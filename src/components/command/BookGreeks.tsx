/**
 * BookGreeks — book-level options Greeks tile for /book.
 *
 * Sits below ConcentrationPanel. Shows:
 *   - The latest ct_book_greeks row (one line: Δ Γ Θ V ρ)
 *   - A 24h history sparkline per greek
 *
 * Greeks source: ct-book-manager aggregates per-contract greeks from UW's
 * /option-contracts response (already fetched for options live P&L, wave 23
 * — no new UW calls) every 15min when ≥1 open option position exists.
 *
 * Aggregation (from the edge function):
 *   position_greek = row.greeks.<greek> * contracts * 100 * side_sign
 *   side_sign      = +1 (long) | -1 (short)
 *   total_<greek>  = SUM across open option positions
 *
 * Coloring — calibrated for a $10k paper book. The thresholds are "book-
 * relative cautions," not hedge-fund-scale. A professional equity-long-short
 * fund might carry |delta| in the tens of thousands on any given day; at
 * $10k of capital, |delta| > 1000 already means the options alone move ~$10
 * for every $1 SPY move (10% of book), which is the right "pay attention"
 * signal at this scale.
 *
 *   caution:  |delta|  > 1000   OR  |gamma| > 50   OR  |theta| > 200/day   OR  |vega|  > 500
 *   ok:       everything below
 *
 * If a user asks about HF norms: |delta| > 50_000, |gamma| > 1_000, etc —
 * but applied per-book, not per-$10k. We expose a tooltip to that effect.
 *
 * Zero-options branch: ct_book_greeks only gets rows written when there
 * are open option positions. Empty → "book is delta-only via underlying."
 */
import { useQuery } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from '@/components/ui/tooltip';
import { Activity, AlertTriangle } from 'lucide-react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip as ChartTooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { ChartSafe } from '@/components/ChartSafe';
import { supabase } from '@/integrations/supabase/client';

// ---- Caution thresholds (absolute value, $10k paper-book scale) ----
const DELTA_CAUTION = 1000;
const GAMMA_CAUTION = 50;
const THETA_CAUTION = 200;  // $/day
const VEGA_CAUTION  = 500;
const RHO_CAUTION   = 500;

interface BookGreeksRow {
  id: string;
  captured_at: string;
  session_date: string;
  total_delta: number;
  total_gamma: number;
  total_vega: number;
  total_theta: number;
  total_rho: number;
  open_options_count: number;
  unique_tickers: string[] | null;
  metadata: unknown;
}

interface PositionBreakdown {
  trade_id: string;
  instrument: string;
  type: 'call' | 'put';
  strike: number;
  expiry: string;
  contracts: number;
  side: 'long' | 'short';
  greeks: { delta: number; gamma: number; theta: number; vega: number; rho: number };
  contributions: { delta: number; gamma: number; theta: number; vega: number; rho: number };
  missing_any_greek: boolean;
}

function isCaution(greek: GreekKey, value: number): boolean {
  const abs = Math.abs(value);
  switch (greek) {
    case 'delta': return abs > DELTA_CAUTION;
    case 'gamma': return abs > GAMMA_CAUTION;
    case 'theta': return abs > THETA_CAUTION;
    case 'vega':  return abs > VEGA_CAUTION;
    case 'rho':   return abs > RHO_CAUTION;
  }
}

function fmtSigned(n: number, digits = 0): string {
  const v = n.toFixed(digits);
  if (n > 0) return `+${v}`;
  return v;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
}

// ---- Data ----

function useLatestGreeks() {
  return useQuery<BookGreeksRow | null>({
    queryKey: ['ct_book_greeks_latest'],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ct_book_greeks')
        .select('*')
        .order('captured_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data as BookGreeksRow | null) ?? null;
    },
  });
}

function useGreeksHistory24h() {
  return useQuery<BookGreeksRow[]>({
    queryKey: ['ct_book_greeks_24h'],
    refetchInterval: 60_000,
    queryFn: async () => {
      const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
      const { data, error } = await supabase
        .from('ct_book_greeks')
        .select('*')
        .gte('captured_at', since)
        .order('captured_at', { ascending: true });
      if (error) throw error;
      return (data as BookGreeksRow[] | null) ?? [];
    },
  });
}

// ---- Per-greek metadata ----

type GreekKey = 'delta' | 'gamma' | 'theta' | 'vega' | 'rho';

const GREEK_META: Record<GreekKey, {
  symbol: string;
  label: string;
  what: string;        // what it measures
  watch: string;       // what to watch for
  totalField: keyof BookGreeksRow;
  digits: number;
  suffix?: string;
  color: string;       // line color
}> = {
  delta: {
    symbol: 'Δ',
    label: 'Delta',
    what: 'Directional exposure — $ the book moves per $1 move in underlying.',
    watch: 'Net-long vs net-short tilt. Large |delta| means the options book is effectively a directional bet.',
    totalField: 'total_delta',
    digits: 0,
    color: '#00E6B4',
  },
  gamma: {
    symbol: 'Γ',
    label: 'Gamma',
    what: 'How fast delta changes per $1 move in underlying.',
    watch: 'High gamma near expiry = whipsaw risk. Positive gamma is long-options convexity (good if volatile).',
    totalField: 'total_gamma',
    digits: 1,
    color: '#8ab4ff',
  },
  theta: {
    symbol: 'Θ',
    label: 'Theta',
    what: 'Dollar decay per day ($/day) from time passing (all else equal).',
    watch: 'Negative theta = long-options bleed. Positive theta = short-options collecting. Pair with gamma.',
    totalField: 'total_theta',
    digits: 0,
    suffix: '/day',
    color: '#ff7a7a',
  },
  vega: {
    symbol: 'V',
    label: 'Vega',
    what: '$ P&L per 1 vol-point change in IV.',
    watch: 'Net-long vega profits when IV expands (event, selloff). Net-short vega bleeds in vol spikes.',
    totalField: 'total_vega',
    digits: 0,
    color: '#ffd166',
  },
  rho: {
    symbol: 'ρ',
    label: 'Rho',
    what: '$ P&L per 1% change in interest rates.',
    watch: 'Usually small-impact intraday. Watch only around FOMC / surprise rate moves.',
    totalField: 'total_rho',
    digits: 0,
    color: '#cd9cf2',
  },
};

// ---- Subcomponents ----

function GreekChip({
  greek,
  value,
}: {
  greek: GreekKey;
  value: number;
}) {
  const meta = GREEK_META[greek];
  const caution = isCaution(greek, value);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={`inline-flex items-baseline gap-1 px-2 py-1 rounded font-mono text-xs cursor-help ${
            caution ? 'bg-amber-500/20 text-amber-300' : 'bg-muted/40 text-foreground'
          }`}
        >
          <span className="font-semibold">{meta.symbol}</span>
          <span>
            {fmtSigned(value, meta.digits)}
            {meta.suffix ?? ''}
          </span>
          {caution && <AlertTriangle className="w-3 h-3 inline" />}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[280px] text-[11px] leading-snug">
        <div className="font-semibold mb-1">{meta.symbol} {meta.label}</div>
        <div className="text-muted-foreground mb-1.5">{meta.what}</div>
        <div className="text-muted-foreground">Watch: {meta.watch}</div>
        {caution && (
          <div className="mt-1.5 text-amber-300">
            Caution at this scale ($10k paper book). HF norms are much larger —
            thresholds here are tuned to flag meaningful-vs-book exposure.
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

function GreekSparkline({
  greek,
  history,
}: {
  greek: GreekKey;
  history: BookGreeksRow[];
}) {
  const meta = GREEK_META[greek];
  const data = history.map(r => ({
    t: r.captured_at,
    v: Number(r[meta.totalField] ?? 0),
  }));
  const latest = data.length > 0 ? data[data.length - 1].v : 0;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <div className="flex items-baseline gap-1.5">
          <span className="font-mono font-semibold text-xs">{meta.symbol}</span>
          <span className="text-[10px] text-muted-foreground uppercase tracking-wide">{meta.label}</span>
        </div>
        <span
          className={`font-mono text-xs ${
            isCaution(greek, latest) ? 'text-amber-300' : 'text-foreground'
          }`}
        >
          {fmtSigned(latest, meta.digits)}
          {meta.suffix ?? ''}
        </span>
      </div>
      <div className="h-12">
        <ChartSafe fallback={<div className="h-full bg-muted/20 rounded" />}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
              <XAxis dataKey="t" hide />
              <YAxis hide domain={['dataMin', 'dataMax']} />
              <ReferenceLine y={0} stroke="#555" strokeDasharray="2 2" />
              <ChartTooltip
                contentStyle={{
                  fontSize: 11,
                  background: 'hsl(var(--background))',
                  border: '1px solid hsl(var(--border))',
                }}
                labelFormatter={(v) => fmtTime(v as string)}
                formatter={(v: number) => [fmtSigned(v, meta.digits), meta.label]}
              />
              <Line
                type="monotone"
                dataKey="v"
                stroke={meta.color}
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </ChartSafe>
      </div>
    </div>
  );
}

export function BookGreeks() {
  const { data: latest, isLoading: loadingLatest } = useLatestGreeks();
  const { data: history, isLoading: loadingHistory } = useGreeksHistory24h();

  const isLoading = loadingLatest || loadingHistory;

  // Empty-state: no rows ever, OR the latest row is older than 2h AND
  // no open option positions right now. We treat "no ct_book_greeks row
  // today" as the empty-state — ct-book-manager skips the write when the
  // book has zero options.
  const emptyState = !latest || (latest.open_options_count ?? 0) === 0;

  const positionCount = latest?.open_options_count ?? 0;
  const tickers = latest?.unique_tickers ?? [];
  const metadata = (latest?.metadata ?? {}) as { positions?: PositionBreakdown[]; missing_greeks_count?: number };
  const missingGreeks = metadata.missing_greeks_count ?? 0;

  return (
    <TooltipProvider delayDuration={150}>
      <Card className="overflow-hidden">
        <div className="px-4 py-2.5 border-b border-border bg-muted/20 flex items-center gap-3">
          <Activity className="w-4 h-4 text-primary" />
          <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground">Book Greeks</h3>
          {latest && !emptyState && (
            <span className="text-[10px] text-muted-foreground font-mono">
              {positionCount} option position{positionCount === 1 ? '' : 's'}
              {tickers.length > 0 && ` · ${tickers.join(', ')}`}
              {' · updated '}
              {fmtTime(latest.captured_at)}
            </span>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-[9px] text-muted-foreground/70 cursor-help ml-auto">
                what is this?
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-[320px] text-[11px] leading-snug">
              Book-level Greeks = SUM of per-contract greeks × contracts × 100 ×
              side_sign (long = +, short = −) across all open option trades.
              Captured every 15min alongside live P&L (no extra UW calls).
              Caution thresholds are tuned to this $10k paper book — HF norms
              would be orders of magnitude larger.
            </TooltipContent>
          </Tooltip>
        </div>

        {isLoading && (
          <div className="p-4 text-xs text-muted-foreground">loading…</div>
        )}

        {!isLoading && emptyState && (
          <div className="p-4 text-xs text-muted-foreground">
            No options positions — book is delta-only via underlying.
          </div>
        )}

        {!isLoading && !emptyState && latest && (
          <>
            {/* Headline line — the glanceable one-liner */}
            <div className="px-4 py-3 border-b border-border flex flex-wrap gap-2 items-center">
              <GreekChip greek="delta" value={Number(latest.total_delta)} />
              <span className="text-muted-foreground/50 text-xs">·</span>
              <GreekChip greek="gamma" value={Number(latest.total_gamma)} />
              <span className="text-muted-foreground/50 text-xs">·</span>
              <GreekChip greek="theta" value={Number(latest.total_theta)} />
              <span className="text-muted-foreground/50 text-xs">·</span>
              <GreekChip greek="vega"  value={Number(latest.total_vega)} />
              <span className="text-muted-foreground/50 text-xs">·</span>
              <GreekChip greek="rho"   value={Number(latest.total_rho)} />
              {missingGreeks > 0 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="ml-auto text-[10px] text-amber-300 font-mono cursor-help flex items-center gap-1">
                      <AlertTriangle className="w-3 h-3" />
                      {missingGreeks} position{missingGreeks === 1 ? '' : 's'} missing greeks
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[240px] text-[11px] leading-snug">
                    UW didn't return one or more greek fields for this position.
                    Missing values treated as 0 — totals understate true exposure.
                  </TooltipContent>
                </Tooltip>
              )}
            </div>

            {/* 24h sparklines per greek */}
            <div className="p-4 grid grid-cols-2 lg:grid-cols-5 gap-4">
              {(['delta', 'gamma', 'theta', 'vega', 'rho'] as GreekKey[]).map(g => (
                <GreekSparkline key={g} greek={g} history={history ?? []} />
              ))}
            </div>
          </>
        )}
      </Card>
    </TooltipProvider>
  );
}
