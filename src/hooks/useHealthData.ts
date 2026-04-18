/**
 * useHealthData — batches all /health page queries in parallel.
 *
 * Refresh: 60s. Read-only. No mutations.
 *
 * Sources:
 *   - get_cron_status RPC             → ct_* crons (filtered client-side)
 *   - ct_uw_usage_latest view         → today's UW count / limit / pct
 *   - ct_uw_usage table               → last 7 days mini-line
 *   - ct_claude_usage_today view      → today + 7-day per-function cost breakdown
 *   - ct_attention_stream table       → last 24h attention_score histogram
 *   - ct_mcp_calls table              → last 20 calls
 *   - ct_book / ct_trades tables      → today's session + open positions
 *
 * Cost attribution:
 *   Every ct-* function that calls Claude now writes to ct_claude_usage via the
 *   shared logClaudeUsage() helper. The ct_claude_usage_today view aggregates
 *   by (session_date, source) — /health groups by source to show per-function
 *   cost, and by session_date for the 7-day rolling trend. ct_chat_tokens
 *   still exists (chat-specific audit trail) but is no longer the primary
 *   source of cost telemetry.
 */

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HealthCronRow {
  jobid: number;
  jobname: string;
  schedule: string;
  command: string;
  active: boolean;
  last_run_status: string | null;
  last_run_at: string | null;
  last_run_duration: string | null;
}

export interface UwUsageLatest {
  session_date: string;
  observed_at: string;
  daily_count: number;
  daily_limit: number;
  pct: number;
}

export interface UwUsageDaily {
  session_date: string;
  daily_count: number;
  daily_limit: number | null;
}

/**
 * Raw row from ct_claude_usage_today view — grouped by (session_date, source).
 * One row per function per day.
 */
export interface ClaudeUsageRow {
  session_date: string;
  source: string;
  turns: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  mcp_calls: number;
  avg_ms: number;
}

/** Per-function breakdown for a single day — rendered in the table. */
export interface ClaudeUsageBySource {
  source: string;
  turns: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  mcp_calls: number;
  avg_ms: number;
}

/** Totals for a single day — rendered in the top-line + footer. */
export interface ClaudeUsageDailyTotal {
  session_date: string;
  turns: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  mcp_calls: number;
  avg_ms: number;
}

export interface AttentionBucket {
  bucket: string;   // e.g. "0-10", "10-20"
  floor: number;    // numeric floor for sorting
  count: number;
}

export interface McpCallRow {
  id: string;
  source: string;
  server_name: string | null;
  tool_name: string | null;
  is_error: boolean;
  created_at: string;
}

export interface BookSnapshot {
  starting_balance: number | null;
  current_equity: number | null;
  realized_pnl_today: number | null;
  open_positions: number;
  session_date: string | null;
}

/**
 * Options live P&L freshness snapshot — how recently book-manager refreshed
 * option-contract mark-to-market for any open option position.
 */
export interface OptionsLivePnlStatus {
  tracked: number;                      // count of open option trades
  last_updated_at: string | null;       // most recent live_pnl_updated_at across option rows
}

export interface HealthData {
  crons: HealthCronRow[];
  uwLatest: UwUsageLatest | null;
  uwDaily: UwUsageDaily[];
  /** Per-function rows for today, sorted by cost desc. */
  claudeTodayBySource: ClaudeUsageBySource[];
  /** Today's grand totals (sum across sources). */
  claudeTodayTotal: ClaudeUsageDailyTotal | null;
  /** Last 7 days of daily totals for the trend chart. */
  claudeDailyTotals: ClaudeUsageDailyTotal[];
  attentionBuckets: AttentionBucket[];
  attentionTotal: number;
  mcpCalls: McpCallRow[];
  book: BookSnapshot;
  optionsLivePnl: OptionsLivePnlStatus;
}

// ---------------------------------------------------------------------------
// Fetchers (each isolated so a single failure doesn't nuke the whole page)
// ---------------------------------------------------------------------------

async function fetchCtCrons(): Promise<HealthCronRow[]> {
  const { data, error } = await supabase.rpc('get_cron_status');
  if (error) {
    console.warn('[useHealthData] get_cron_status failed:', error.message);
    return [];
  }
  const rows = (data as HealthCronRow[]) || [];
  return rows
    .filter((r) => (r.jobname ?? '').toLowerCase().startsWith('ct-') || (r.jobname ?? '').toLowerCase().startsWith('ct_'))
    .sort((a, b) => {
      const ta = a.last_run_at ? Date.parse(a.last_run_at) : 0;
      const tb = b.last_run_at ? Date.parse(b.last_run_at) : 0;
      return tb - ta;
    });
}

async function fetchUwLatest(): Promise<UwUsageLatest | null> {
  const { data, error } = await supabase
    .from('ct_uw_usage_latest')
    .select('*')
    .order('session_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn('[useHealthData] ct_uw_usage_latest failed:', error.message);
    return null;
  }
  return (data as UwUsageLatest | null) ?? null;
}

async function fetchUwDaily(): Promise<UwUsageDaily[]> {
  // Pull last 7 days of raw usage, take the max daily_count per session_date
  // (count only goes up during a day, so max = end-of-day value).
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('ct_uw_usage')
    .select('session_date, daily_count, daily_limit')
    .gte('session_date', since)
    .order('session_date', { ascending: true })
    .order('observed_at', { ascending: false });
  if (error) {
    console.warn('[useHealthData] ct_uw_usage failed:', error.message);
    return [];
  }
  const byDay = new Map<string, UwUsageDaily>();
  for (const r of (data ?? []) as UwUsageDaily[]) {
    const prev = byDay.get(r.session_date);
    if (!prev || (r.daily_count ?? 0) > (prev.daily_count ?? 0)) {
      byDay.set(r.session_date, r);
    }
  }
  return Array.from(byDay.values()).sort((a, b) => a.session_date.localeCompare(b.session_date));
}

/**
 * Fetch ct_claude_usage_today (view grouped by session_date + source) and
 * return the raw per-(day, source) rows. Roll-ups to daily totals and today's
 * breakdown are computed in the hook aggregator.
 */
async function fetchClaudeUsage(): Promise<ClaudeUsageRow[]> {
  const since = new Date(Date.now() - 8 * 86_400_000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('ct_claude_usage_today')
    .select('*')
    .gte('session_date', since)
    .order('session_date', { ascending: false });
  if (error) {
    console.warn('[useHealthData] ct_claude_usage_today failed:', error.message);
    return [];
  }
  return ((data ?? []) as ClaudeUsageRow[]).map((r) => ({
    ...r,
    turns: Number(r.turns ?? 0),
    tokens_in: Number(r.tokens_in ?? 0),
    tokens_out: Number(r.tokens_out ?? 0),
    cost_usd: Number(r.cost_usd ?? 0),
    mcp_calls: Number(r.mcp_calls ?? 0),
    avg_ms: Number(r.avg_ms ?? 0),
  }));
}

async function fetchAttentionHistogram(): Promise<{ buckets: AttentionBucket[]; total: number }> {
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const { data, error } = await supabase
    .from('ct_attention_stream')
    .select('attention_score')
    .gte('created_at', since)
    .not('attention_score', 'is', null)
    .limit(5000);
  if (error) {
    console.warn('[useHealthData] ct_attention_stream failed:', error.message);
    return { buckets: emptyAttentionBuckets(), total: 0 };
  }
  const buckets = emptyAttentionBuckets();
  const rows = (data ?? []) as Array<{ attention_score: number | null }>;
  for (const r of rows) {
    if (r.attention_score == null) continue;
    const idx = Math.min(9, Math.max(0, Math.floor(r.attention_score / 10)));
    buckets[idx].count += 1;
  }
  return { buckets, total: rows.length };
}

function emptyAttentionBuckets(): AttentionBucket[] {
  const out: AttentionBucket[] = [];
  for (let i = 0; i < 10; i++) {
    const lo = i * 10;
    const hi = i === 9 ? 100 : lo + 10;
    out.push({ bucket: `${lo}-${hi}`, floor: lo, count: 0 });
  }
  return out;
}

async function fetchMcpCalls(): Promise<McpCallRow[]> {
  const { data, error } = await supabase
    .from('ct_mcp_calls')
    .select('id, source, server_name, tool_name, is_error, created_at')
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) {
    console.warn('[useHealthData] ct_mcp_calls failed:', error.message);
    return [];
  }
  return (data ?? []) as McpCallRow[];
}

async function fetchOptionsLivePnl(): Promise<OptionsLivePnlStatus> {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('ct_trades')
    .select('live_pnl_updated_at')
    .eq('session_date', today)
    .eq('status', 'open')
    .neq('contract_type', 'underlying');
  if (error) {
    console.warn('[useHealthData] options live pnl status failed:', error.message);
    return { tracked: 0, last_updated_at: null };
  }
  const rows = (data ?? []) as Array<{ live_pnl_updated_at: string | null }>;
  let latest: number | null = null;
  for (const r of rows) {
    if (!r.live_pnl_updated_at) continue;
    const ts = Date.parse(r.live_pnl_updated_at);
    if (!Number.isFinite(ts)) continue;
    if (latest == null || ts > latest) latest = ts;
  }
  return {
    tracked: rows.length,
    last_updated_at: latest != null ? new Date(latest).toISOString() : null,
  };
}

async function fetchBookSnapshot(): Promise<BookSnapshot> {
  const today = new Date().toISOString().slice(0, 10);

  const [bookRes, tradesRes] = await Promise.all([
    supabase
      .from('ct_book')
      .select('session_date, starting_balance, ending_balance, realized_pnl, unrealized_pnl')
      .eq('session_date', today)
      .maybeSingle(),
    supabase
      .from('ct_trades')
      .select('status')
      .eq('session_date', today),
  ]);

  const book = bookRes.data as
    | {
        session_date: string;
        starting_balance: number;
        ending_balance: number | null;
        realized_pnl: number | null;
        unrealized_pnl: number | null;
      }
    | null;

  const trades = (tradesRes.data ?? []) as Array<{ status: string }>;
  const openPositions = trades.filter((t) => t.status === 'open' || t.status === 'planned').length;

  if (!book) {
    return {
      starting_balance: null,
      current_equity: null,
      realized_pnl_today: null,
      open_positions: openPositions,
      session_date: null,
    };
  }

  const currentEquity =
    book.ending_balance ??
    book.starting_balance + (book.realized_pnl ?? 0) + (book.unrealized_pnl ?? 0);

  return {
    starting_balance: book.starting_balance,
    current_equity: currentEquity,
    realized_pnl_today: book.realized_pnl ?? 0,
    open_positions: openPositions,
    session_date: book.session_date,
  };
}

// ---------------------------------------------------------------------------
// Aggregation helpers — roll per-(day, source) rows up to daily totals and
// today's per-source breakdown.
// ---------------------------------------------------------------------------

function rollUpDailyTotals(rows: ClaudeUsageRow[]): ClaudeUsageDailyTotal[] {
  const byDay = new Map<string, ClaudeUsageDailyTotal & { _ms_weighted: number }>();
  for (const r of rows) {
    const prev = byDay.get(r.session_date);
    const weighted = r.avg_ms * r.turns; // weight avg_ms by turns to re-average properly
    if (!prev) {
      byDay.set(r.session_date, {
        session_date: r.session_date,
        turns: r.turns,
        tokens_in: r.tokens_in,
        tokens_out: r.tokens_out,
        cost_usd: r.cost_usd,
        mcp_calls: r.mcp_calls,
        avg_ms: r.avg_ms,
        _ms_weighted: weighted,
      });
    } else {
      prev.turns += r.turns;
      prev.tokens_in += r.tokens_in;
      prev.tokens_out += r.tokens_out;
      prev.cost_usd += r.cost_usd;
      prev.mcp_calls += r.mcp_calls;
      prev._ms_weighted += weighted;
      prev.avg_ms = prev.turns > 0 ? Math.round(prev._ms_weighted / prev.turns) : 0;
    }
  }
  return Array.from(byDay.values())
    .map(({ _ms_weighted: _ms, ...rest }) => rest)
    .sort((a, b) => a.session_date.localeCompare(b.session_date));
}

function pickTodaySources(rows: ClaudeUsageRow[], today: string): ClaudeUsageBySource[] {
  return rows
    .filter((r) => r.session_date === today)
    .map(({ session_date: _sd, ...rest }) => rest)
    .sort((a, b) => b.cost_usd - a.cost_usd);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useHealthData() {
  return useQuery<HealthData>({
    queryKey: ['health-data'],
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const [
        crons,
        uwLatest,
        uwDaily,
        claudeUsage,
        attention,
        mcpCalls,
        book,
        optionsLivePnl,
      ] = await Promise.all([
        fetchCtCrons(),
        fetchUwLatest(),
        fetchUwDaily(),
        fetchClaudeUsage(),
        fetchAttentionHistogram(),
        fetchMcpCalls(),
        fetchBookSnapshot(),
        fetchOptionsLivePnl(),
      ]);

      const today = new Date().toISOString().slice(0, 10);
      const claudeDailyTotals = rollUpDailyTotals(claudeUsage);
      const claudeTodayBySource = pickTodaySources(claudeUsage, today);
      const claudeTodayTotal =
        claudeDailyTotals.find((d) => d.session_date === today) ?? null;

      return {
        crons,
        uwLatest,
        uwDaily,
        claudeTodayBySource,
        claudeTodayTotal,
        claudeDailyTotals,
        attentionBuckets: attention.buckets,
        attentionTotal: attention.total,
        mcpCalls,
        book,
        optionsLivePnl,
      };
    },
  });
}
