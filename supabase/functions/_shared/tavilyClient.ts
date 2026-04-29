/**
 * Tavily client — single source of truth for every Tavily call from edge functions.
 *
 * Responsibilities:
 *   1. Fire the HTTP search call to https://api.tavily.com/search.
 *   2. Log every call to ct_tavily_usage (caller, query, depth, results, status, ms).
 *   3. Honor monthly budget tier — refuse on `exhausted`, no-op for caller-disabled.
 *   4. Expose a tier check so callers can self-throttle (e.g. news-sweep drops to
 *      top 5 hot tickers at `tightened`, top 2 at `critical`).
 *
 * Pricing reference (verified 2026-04-29):
 *   Search basic    = 1 credit/call
 *   Search advanced = 2 credits/call
 *   Project tier    = 4,000 credits/month at $30
 *
 * Failed calls (non-2xx) are NOT billed by Tavily, so the budget tier RPC counts
 * only 2xx rows. We log every row regardless for visibility into errors.
 */

const TAVILY_URL = 'https://api.tavily.com/search';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score?: number;
  published_date?: string | null;
}

export interface TavilyResponse {
  answer?: string | null;
  query?: string;
  response_time?: number;
  results: TavilyResult[];
}

export type TavilyTier = 'unrestricted' | 'tightened' | 'critical' | 'exhausted';

export interface TavilyTierResult {
  tier: TavilyTier;
  monthly_count: number;
  monthly_limit: number;
  pct_used: number | null;
}

export interface TavilySearchOpts {
  query: string;
  caller: string;                // required — used for usage attribution
  maxResults?: number;           // default 10
  searchDepth?: 'basic' | 'advanced';   // default 'basic'
  topic?: 'news' | 'general';    // default 'news'
  days?: number;                 // restrict to last N days (news topic)
  includeAnswer?: boolean;       // include Tavily AI summary (no extra cost)
  includeRawContent?: boolean;
  includeDomains?: string[];
  excludeDomains?: string[];
}

export class TavilyError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'TavilyError';
    this.status = status;
  }
}

export class TavilyBudgetError extends Error {
  tier: TavilyTier;
  pct_used: number | null;
  constructor(message: string, tier: TavilyTier, pct_used: number | null) {
    super(message);
    this.name = 'TavilyBudgetError';
    this.tier = tier;
    this.pct_used = pct_used;
  }
}

// ---------------------------------------------------------------------------
// Budget tier check
// ---------------------------------------------------------------------------
const FALLBACK_TIER: TavilyTierResult = {
  tier: 'unrestricted',
  monthly_count: 0,
  monthly_limit: 4000,
  pct_used: 0,
};

export async function tavilyBudgetTier(): Promise<TavilyTierResult> {
  try {
    const url = Deno.env.get('SUPABASE_URL');
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) return FALLBACK_TIER;

    const res = await fetch(`${url}/rest/v1/rpc/ct_tavily_budget_tier`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': key,
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({}),
    });
    if (!res.ok) return FALLBACK_TIER;
    const data = await res.json() as Array<{
      tier: TavilyTier;
      monthly_count: number;
      monthly_limit: number;
      pct_used: number | string | null;
    }>;
    if (!Array.isArray(data) || data.length === 0) return FALLBACK_TIER;
    const r = data[0];
    return {
      tier: r.tier ?? 'unrestricted',
      monthly_count: Number(r.monthly_count ?? 0),
      monthly_limit: Number(r.monthly_limit ?? 4000),
      pct_used: r.pct_used == null ? 0 : Number(r.pct_used),
    };
  } catch {
    return FALLBACK_TIER;
  }
}

// ---------------------------------------------------------------------------
// Caller kill-switch — config-driven, cached for 60s per isolate.
// ---------------------------------------------------------------------------
let _killSwitchCache: { ts: number; map: Map<string, boolean> } | null = null;
const KILL_SWITCH_TTL_MS = 60_000;

async function isCallerEnabled(caller: string): Promise<boolean> {
  const now = Date.now();
  if (_killSwitchCache && now - _killSwitchCache.ts < KILL_SWITCH_TTL_MS) {
    const cached = _killSwitchCache.map.get(caller);
    return cached === undefined ? true : cached;
  }

  try {
    const url = Deno.env.get('SUPABASE_URL');
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) return true;

    const res = await fetch(
      `${url}/rest/v1/ct_config?select=key,value&key=like.tavily_caller.%25`,
      { headers: { 'apikey': key, 'Authorization': `Bearer ${key}` } },
    );
    if (!res.ok) return true;

    const rows = await res.json() as Array<{ key: string; value: unknown }>;
    const map = new Map<string, boolean>();
    for (const r of rows) {
      const m = r.key.match(/^tavily_caller\.(.+)\.enabled$/);
      if (!m) continue;
      const enabled = r.value === true || r.value === 'true' || r.value === 1;
      map.set(m[1], enabled);
    }
    _killSwitchCache = { ts: now, map };
    const cached = map.get(caller);
    return cached === undefined ? true : cached;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Usage logging — fire-and-forget, batched.
// ---------------------------------------------------------------------------
type UsageRow = {
  caller: string;
  query: string;
  search_depth: string;
  topic: string | null;
  results_count: number | null;
  credits_charged: number;
  status: number;
  error: string | null;
  ms: number;
};

let _usageBuffer: UsageRow[] = [];
let _flushPending = false;

function recordUsage(row: UsageRow): void {
  _usageBuffer.push(row);
  if (!_flushPending) {
    _flushPending = true;
    setTimeout(flushUsage, 500);
  }
}

async function flushUsage(): Promise<void> {
  const rows = _usageBuffer;
  _usageBuffer = [];
  _flushPending = false;
  if (rows.length === 0) return;
  try {
    const url = Deno.env.get('SUPABASE_URL');
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) return;
    await fetch(`${url}/rest/v1/ct_tavily_usage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(rows),
    });
  } catch { /* swallow */ }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
/**
 * Run a Tavily search with budget tracking + tier guard. Throws TavilyBudgetError
 * if the caller is killed via config OR if the monthly budget is exhausted.
 * Returns the parsed result list (caller can use rawResponse() for the full body).
 */
export async function searchTavily(opts: TavilySearchOpts): Promise<TavilyResult[]> {
  const data = await searchTavilyRaw(opts);
  return Array.isArray(data.results) ? data.results : [];
}

/**
 * Variant that returns the full Tavily response (including AI answer if requested).
 * Used by jac-web-search which surfaces answer + sources to the user.
 */
export async function searchTavilyRaw(opts: TavilySearchOpts): Promise<TavilyResponse> {
  if (!opts.caller) {
    throw new Error('searchTavily: caller is required');
  }

  // 1. Caller-level kill switch
  const enabled = await isCallerEnabled(opts.caller);
  if (!enabled) {
    throw new TavilyBudgetError(`Tavily caller ${opts.caller} disabled via ct_config`, 'unrestricted', null);
  }

  // 2. Monthly budget tier — exhausted halts everything
  const tierResult = await tavilyBudgetTier();
  if (tierResult.tier === 'exhausted') {
    throw new TavilyBudgetError(
      `Tavily monthly budget exhausted (${tierResult.pct_used ?? '?'}% used). Halting until next month rollover.`,
      tierResult.tier,
      tierResult.pct_used,
    );
  }

  // 3. Fire the search
  const apiKey = Deno.env.get('TAVILY_API_KEY');
  if (!apiKey) throw new Error('TAVILY_API_KEY not configured');

  const searchDepth = opts.searchDepth ?? 'basic';
  const credits = searchDepth === 'advanced' ? 2 : 1;

  const body: Record<string, unknown> = {
    api_key: apiKey,
    query: opts.query,
    search_depth: searchDepth,
    max_results: opts.maxResults ?? 10,
    include_answer: opts.includeAnswer ?? false,
    include_raw_content: opts.includeRawContent ?? false,
  };
  if (opts.topic) body.topic = opts.topic;
  if (opts.days != null) body.days = opts.days;
  if (opts.includeDomains?.length) body.include_domains = opts.includeDomains;
  if (opts.excludeDomains?.length) body.exclude_domains = opts.excludeDomains;

  const startMs = Date.now();
  let resp: Response;
  let resultsCount: number | null = null;
  let parsed: TavilyResponse | null = null;
  let errorMsg: string | null = null;
  let status = 0;
  let bodyText = '';

  try {
    resp = await fetch(TAVILY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    status = resp.status;

    if (resp.ok) {
      bodyText = await resp.text();
      try {
        parsed = JSON.parse(bodyText) as TavilyResponse;
        resultsCount = Array.isArray(parsed.results) ? parsed.results.length : 0;
      } catch {
        errorMsg = 'json_parse_failed';
      }
    } else {
      bodyText = await resp.text().catch(() => '');
      errorMsg = `${resp.status}: ${bodyText.slice(0, 200)}`;
    }
  } catch (e) {
    status = 0;
    errorMsg = `fetch_threw: ${e instanceof Error ? e.message : String(e)}`;
  }

  const ms = Date.now() - startMs;

  // Log every call — successful (2xx) AND failed. The view filters for billing.
  recordUsage({
    caller: opts.caller,
    query: opts.query.slice(0, 500),
    search_depth: searchDepth,
    topic: opts.topic ?? null,
    results_count: resultsCount,
    credits_charged: status >= 200 && status < 300 ? credits : 0,
    status,
    error: errorMsg,
    ms,
  });

  if (errorMsg || !parsed) {
    throw new TavilyError(`Tavily ${status}: ${errorMsg ?? 'unknown'}`, status || 500);
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Slack alarm — fire once per month per tier when crossing into critical /
// exhausted. Mirrors the UW pattern (alarm-state row id=1, upsert per tier).
// ---------------------------------------------------------------------------
export async function maybeFireTavilyAlarm(
  supabase: { from: (t: string) => unknown },
  tier: 'tightened' | 'critical' | 'exhausted',
  pct_used: number | null,
): Promise<{ fired: boolean; reason?: string }> {
  const month = new Date().toISOString().slice(0, 7);  // YYYY-MM
  const col =
    tier === 'tightened' ? 'last_tightened_alarm_month' :
    tier === 'critical'  ? 'last_critical_alarm_month'  :
                           'last_exhausted_alarm_month';

  try {
    const { data: state } = await (supabase.from('ct_tavily_alarm_state') as {
      select: (s: string) => { eq: (k: string, v: number) => { maybeSingle: () => Promise<{ data: Record<string, unknown> | null }> } };
    }).select(col).eq('id', 1).maybeSingle();

    if (state && state[col] === month) {
      return { fired: false, reason: 'already_fired_this_month' };
    }

    await (supabase.from('ct_tavily_alarm_state') as {
      upsert: (row: Record<string, unknown>, opts: { onConflict: string }) => Promise<{ error: unknown }>;
    }).upsert(
      { id: 1, [col]: month, updated_at: new Date().toISOString() },
      { onConflict: 'id' },
    );

    return { fired: true };
  } catch (e) {
    return { fired: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
