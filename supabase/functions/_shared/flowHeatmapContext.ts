import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import type {
  ContextHelper,
  HelperDescription,
  HelperFetchContext,
  HelperOpts,
  HelperResult,
} from './contextHelper.ts';

export interface FlowHeatmapStack {
  expiry_bucket_week: string;  // YYYY-MM-DD
  value: number;
  source_alert_count: number;
}

export interface FlowHeatmapContext {
  per_ticker: Array<{ ticker: string; stacks: FlowHeatmapStack[] }>;
  generated_at: string;
  lookback_hours: number;
  math_mode: 'aggressive_directional_decay' | 'total' | 'net_signed' | 'aggressive_directional_raw' | 'voi_unusual';
}

/**
 * ContextHelper-contract result alias. The underlying shape is identical to
 * `FlowHeatmapContext`; this name aligns with the brain orchestrator's
 * `HelperResult<TResult>` naming.
 */
export type FlowHeatmapResult = FlowHeatmapContext;

const HELPER_NAME = 'flow_heatmap';
const HELPER_VERSION = 'v2';

// Audit-driven fallbacks — used only when ct_config lookup fails. These match
// the captain-correct global defaults seeded by
// 20260506120000_flow_heatmap_config_and_warden.sql so the runtime behavior
// of an unconfigured deployment is the same as a freshly-migrated one.
const FALLBACK_INCLUDE_0DTE = true;
const FALLBACK_CAP = 6;
const FALLBACK_MIN_PREMIUM = 100000;
const FALLBACK_MAX_EXPIRY_DAYS = 180;
const FALLBACK_LOOKBACK_HOURS = 168;
const FALLBACK_MATH_MODE = 'aggressive_directional_decay';

interface FlowHeatmapConfig {
  include_0dte: boolean;
  cap: number;
  min_premium: number;
  max_expiry_days: number;
  lookback_hours: number;
  math_mode: string;
}

interface CacheEntry {
  config: FlowHeatmapConfig;
  fetchedAt: number;
}

const CONFIG_TTL_MS = 60_000;
const configCache = new Map<string, CacheEntry>();

function fallbackConfig(): FlowHeatmapConfig {
  return {
    include_0dte: FALLBACK_INCLUDE_0DTE,
    cap: FALLBACK_CAP,
    min_premium: FALLBACK_MIN_PREMIUM,
    max_expiry_days: FALLBACK_MAX_EXPIRY_DAYS,
    lookback_hours: FALLBACK_LOOKBACK_HOURS,
    math_mode: FALLBACK_MATH_MODE,
  };
}

function unwrapJsonbValue(raw: unknown): unknown {
  // ct_config_get returns the raw jsonb. Booleans/numbers come through as
  // JS primitives, but strings come wrapped in quotes (e.g. '"foo"' as a
  // string literal). PostgREST already parses jsonb → JS, so we just need
  // to trust the type.
  return raw;
}

async function readConfigKey(
  supabase: SupabaseClient,
  key: string,
): Promise<unknown> {
  try {
    const { data, error } = await supabase.rpc('ct_config_get', { p_key: key });
    if (error) return undefined;
    return data === null ? undefined : unwrapJsonbValue(data);
  } catch {
    return undefined;
  }
}

async function loadConfig(
  supabase: SupabaseClient,
  consumerName: string | undefined,
): Promise<FlowHeatmapConfig> {
  const cacheKey = consumerName ?? '__global__';
  const now = Date.now();
  const hit = configCache.get(cacheKey);
  if (hit && now - hit.fetchedAt < CONFIG_TTL_MS) return hit.config;

  const cfg = fallbackConfig();
  const consumerPrefix = consumerName ? `flow_heatmap.consumer.${consumerName}.` : null;
  const fields: Array<{ field: keyof FlowHeatmapConfig; cast: (v: unknown) => unknown }> = [
    { field: 'include_0dte', cast: (v) => (typeof v === 'boolean' ? v : v === 'true') },
    { field: 'cap', cast: (v) => (typeof v === 'number' ? v : Number(v)) },
    { field: 'min_premium', cast: (v) => (typeof v === 'number' ? v : Number(v)) },
    { field: 'max_expiry_days', cast: (v) => (typeof v === 'number' ? v : Number(v)) },
    { field: 'lookback_hours', cast: (v) => (typeof v === 'number' ? v : Number(v)) },
    { field: 'math_mode', cast: (v) => (typeof v === 'string' ? v : String(v)) },
  ];

  for (const { field, cast } of fields) {
    let raw: unknown = undefined;
    if (consumerPrefix) {
      raw = await readConfigKey(supabase, `${consumerPrefix}${field}`);
    }
    if (raw === undefined) {
      raw = await readConfigKey(supabase, `flow_heatmap.${field}`);
    }
    if (raw === undefined) continue;
    const casted = cast(raw);
    if (typeof cfg[field] === 'number' && Number.isNaN(casted as number)) continue;
    (cfg as Record<keyof FlowHeatmapConfig, unknown>)[field] = casted;
  }

  configCache.set(cacheKey, { config: cfg, fetchedAt: now });
  return cfg;
}

export interface GetFlowHeatmapContextOpts {
  cap?: number;
  consumerName?: string;
}

/**
 * Pulls top N expiry-week stacks per watchlist ticker by abs(value) using the
 * configured math mode and lookback. Compact enough to drop into any Claude
 * context payload as positioning regime input.
 *
 * Always returns a FlowHeatmapContext, never null. If the RPC fails, returns
 * an empty per_ticker array (defensive — never blocks the caller).
 *
 * Config resolution (per-consumer overrides → global defaults → audit-driven
 * fallback constants):
 *   1. `flow_heatmap.consumer.<consumerName>.<field>` (when consumerName set)
 *   2. `flow_heatmap.<field>`
 *   3. FALLBACK_* constants in this file
 *
 * The optional `cap`/`opts.cap` override applies AFTER config resolution
 * (caller wins over config).
 *
 * Backward-compatible signature: 3rd arg accepts a number (legacy `cap`) or
 * an opts object. Existing positional callers with `cap` still work.
 */
export async function getFlowHeatmapContext(
  supabase: SupabaseClient,
  watchlist: string[],
  capOrOpts?: number | GetFlowHeatmapContextOpts,
): Promise<FlowHeatmapContext> {
  const callerOpts: GetFlowHeatmapContextOpts =
    typeof capOrOpts === 'number'
      ? { cap: capOrOpts }
      : (capOrOpts ?? {});

  const cfg = await loadConfig(supabase, callerOpts.consumerName);
  const cap = Math.max(1, callerOpts.cap ?? cfg.cap);

  const empty: FlowHeatmapContext = {
    per_ticker: [],
    generated_at: new Date().toISOString(),
    lookback_hours: cfg.lookback_hours,
    math_mode: cfg.math_mode as FlowHeatmapContext['math_mode'],
  };

  try {
    const { data, error } = await supabase.rpc('ct_flow_heatmap_live', {
      p_tickers: watchlist,
      p_math_mode: cfg.math_mode,
      p_min_premium: cfg.min_premium,
      p_include_0dte: cfg.include_0dte,
      p_max_expiry_days: cfg.max_expiry_days,
      p_lookback_hours: cfg.lookback_hours,
    });
    if (error || !Array.isArray(data)) return empty;
    const byTicker = new Map<string, FlowHeatmapStack[]>();
    for (const row of data as Array<{ ticker: string; expiry_bucket_week: string; value: number; source_alert_count: number }>) {
      if (!byTicker.has(row.ticker)) byTicker.set(row.ticker, []);
      byTicker.get(row.ticker)!.push({
        expiry_bucket_week: row.expiry_bucket_week,
        value: Number(row.value),
        source_alert_count: row.source_alert_count,
      });
    }
    const per_ticker = Array.from(byTicker.entries()).map(([ticker, stacks]) => ({
      ticker,
      stacks: stacks.sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, cap),
    }));
    return { ...empty, per_ticker };
  } catch {
    return empty;
  }
}

/**
 * Internal: total `source_alert_count` across all returned stacks. Used as
 * the `rowCount` telemetry signal — more meaningful than per_ticker length
 * which is bounded by watchlist size.
 */
function countStacks(result: FlowHeatmapResult): number {
  let n = 0;
  for (const t of result.per_ticker) n += t.stacks.length;
  return n;
}

/**
 * Default export: ContextHelper<FlowHeatmapResult> — the orchestrator-side
 * surface. Wraps `getFlowHeatmapContext`. consumerName flows in via opts so
 * per-consumer config overrides resolve.
 */
const flowHeatmapHelper: ContextHelper<FlowHeatmapResult> = {
  name: HELPER_NAME,
  version: HELPER_VERSION,
  defaultCap: FALLBACK_CAP,
  isExpensive: false,
  minRefreshSeconds: 60,
  dependencies: [],
  audienceFilter: undefined,
  cacheTtlSeconds: 60,

  async fetch(
    ctx: HelperFetchContext,
    opts: HelperOpts,
  ): Promise<HelperResult<FlowHeatmapResult>> {
    const startedAt = Date.now();
    const consumerName = typeof opts.consumerName === 'string' ? opts.consumerName : undefined;

    // Single-ticker focus collapses the watchlist for the underlying RPC,
    // matching the same defensive contract the named function provides.
    const tickers = opts.tickerFocus
      ? [opts.tickerFocus]
      : Array.from(ctx.watchlist ?? []);

    const data = await getFlowHeatmapContext(ctx.supabase, tickers, {
      cap: opts.cap,
      consumerName,
    });
    const rowCount = countStacks(data);

    // Resolve cap-as-applied for the truncated meta.
    const cfg = await loadConfig(ctx.supabase, consumerName);
    const effectiveCap = Math.max(1, opts.cap ?? cfg.cap);

    return {
      data,
      meta: {
        helperName: HELPER_NAME,
        helperVersion: HELPER_VERSION,
        fetchedAt: data.generated_at,
        rowCount,
        cacheHit: false,
        latencyMs: Date.now() - startedAt,
        truncated: data.per_ticker.some((t) => t.stacks.length >= effectiveCap),
        warning: rowCount === 0 ? 'empty_result' : undefined,
      },
    };
  },

  describe(): HelperDescription {
    return {
      name: HELPER_NAME,
      version: HELPER_VERSION,
      defaultCap: FALLBACK_CAP,
      expensive: false,
      minRefreshSeconds: 60,
      dependencies: [],
      audienceFilter: undefined,
      outputShape:
        'Top-N expiry-week stacks per watchlist ticker, sorted by |value| ' +
        'descending. All math/window/cap params resolve from ct_config.flow_heatmap.* ' +
        '(per-consumer overrides → global defaults → audit-driven fallbacks). ' +
        'Defensive: empty per_ticker array on RPC failure.',
      exampleResult: {
        per_ticker: [
          {
            ticker: 'NVDA',
            stacks: [
              { expiry_bucket_week: '2026-05-08', value: 19905987, source_alert_count: 158 },
            ],
          },
        ],
        generated_at: '2026-05-06T12:00:00.000Z',
        lookback_hours: 168,
        math_mode: 'aggressive_directional_decay',
      } satisfies FlowHeatmapResult,
    };
  },
};

export default flowHeatmapHelper;

/**
 * Test-only — clears the in-module config cache. Never call from production.
 */
export function _resetFlowHeatmapConfigCacheForTests(): void {
  configCache.clear();
}
