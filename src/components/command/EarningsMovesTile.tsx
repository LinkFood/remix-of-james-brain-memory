/**
 * EarningsMovesTile — per-ticker historical earnings move readout.
 *
 * Data source: ct_earnings_moves (populated weekly Sun 22:15 UTC by
 * ct-earnings-moves-sync). Pulls up to 8 most-recent quarters per ticker.
 *
 * Rendered fields:
 *   - headline: "avg ±4.2%, range +11.0% / -6.0%, 5 beats / 3 misses"
 *   - mini histogram of move magnitudes (signed, colored by direction)
 *   - n-filled badge when some quarters lack price history
 *
 * States:
 *   - loading: muted placeholder
 *   - no rows: "no historical earnings cached yet — weekly job"
 *   - all rows null-price: "past 8 reports captured but price history is
 *     too thin for move calculation"
 *   - proximity badge: when nextEarnings < 5 days away, headline is prefixed
 *     with "historical day-after move: ±X% avg" in an amber pulse
 *
 * Rendered below FundamentalsTile inside TickerTerminal.
 */
import { memo, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useNextEarningsByTicker } from '@/hooks/useCoTraderData';

// ─── palette (matches the rest of the co-trader surface) ───────────────
const COLOR_CALL = '#00C853';
const COLOR_PUT  = '#FF1744';
const COLOR_AMBER = '#FFB300';
const COLOR_MUTED = '#64748b';

const MAX_QUARTERS = 8;
const PROXIMITY_DAYS = 5;

interface EarningsMoveRow {
  ticker: string;
  report_date: string;          // YYYY-MM-DD
  report_time: string | null;
  pre_earnings_close: number | null;
  post_earnings_close: number | null;
  move_pct: number | null;
  move_direction: 'up' | 'down' | 'flat' | null;
  beat_miss: 'beat' | 'miss' | 'inline' | null;
  surprise_pct: number | null;
  reason: string | null;
}

interface Stats {
  n: number;               // rows with move_pct
  avgMag: number;          // mean(|move_pct|)
  std: number;             // stddev(move_pct) (signed)
  max: number;             // max(move_pct)
  min: number;             // min(move_pct)
  maxMagDate: string | null;
  beats: number;
  misses: number;
  inline: number;
}

// ─── helpers ───────────────────────────────────────────────────────────

function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}%`;
}

function fmtMag(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `±${Math.abs(n).toFixed(digits)}%`;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

function computeStats(rows: EarningsMoveRow[]): Stats {
  const priced = rows.filter((r) => r.move_pct !== null && Number.isFinite(r.move_pct)) as Array<EarningsMoveRow & { move_pct: number }>;
  const n = priced.length;
  const beats  = rows.filter((r) => r.beat_miss === 'beat').length;
  const misses = rows.filter((r) => r.beat_miss === 'miss').length;
  const inline = rows.filter((r) => r.beat_miss === 'inline').length;

  if (n === 0) {
    return { n: 0, avgMag: 0, std: 0, max: 0, min: 0, maxMagDate: null, beats, misses, inline };
  }

  const mags = priced.map((r) => Math.abs(r.move_pct));
  const avgMag = mags.reduce((a, b) => a + b, 0) / n;
  const mean = priced.reduce((a, b) => a + b.move_pct, 0) / n;
  const variance = priced.reduce((acc, r) => acc + (r.move_pct - mean) ** 2, 0) / Math.max(n, 1);
  const std = Math.sqrt(variance);
  const max = Math.max(...priced.map((r) => r.move_pct));
  const min = Math.min(...priced.map((r) => r.move_pct));
  const maxMagRow = priced.reduce((hi, r) => (Math.abs(r.move_pct) > Math.abs(hi.move_pct) ? r : hi), priced[0]);
  return {
    n, avgMag, std, max, min,
    maxMagDate: maxMagRow.report_date,
    beats, misses, inline,
  };
}

function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map((v) => parseInt(v, 10));
  if (!y || !m || !d) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(y, m - 1, d);
  return Math.round((target.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
}

// ─── data hook ─────────────────────────────────────────────────────────

function useEarningsMoves(ticker: string) {
  return useQuery<EarningsMoveRow[]>({
    queryKey: ['ct_earnings_moves', ticker],
    enabled: !!ticker,
    staleTime: 60 * 60_000,       // 1h — weekly-refreshed data
    refetchInterval: 6 * 60 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ct_earnings_moves')
        .select('ticker, report_date, report_time, pre_earnings_close, post_earnings_close, move_pct, move_direction, beat_miss, surprise_pct, reason')
        .eq('ticker', ticker)
        .order('report_date', { ascending: false })
        .limit(MAX_QUARTERS);
      if (error) throw error;
      return (data as EarningsMoveRow[] | null) ?? [];
    },
  });
}

// ─── histogram bar ─────────────────────────────────────────────────────

function Histogram({ rows }: { rows: EarningsMoveRow[] }) {
  const priced = rows
    .filter((r) => r.move_pct !== null && Number.isFinite(r.move_pct))
    .slice()
    .sort((a, b) => a.report_date.localeCompare(b.report_date)); // oldest → newest L→R
  if (priced.length === 0) return null;
  const maxMag = Math.max(...priced.map((r) => Math.abs(r.move_pct as number)), 1);

  return (
    <div className="flex items-end gap-1 h-12 mt-2" title="oldest → newest (left → right)">
      {priced.map((r) => {
        const v = r.move_pct as number;
        const heightPct = (Math.abs(v) / maxMag) * 100;
        const color = v >= 0 ? COLOR_CALL : COLOR_PUT;
        return (
          <div
            key={r.report_date}
            className="flex-1 rounded-sm min-w-[6px]"
            style={{
              height: `${Math.max(heightPct, 6)}%`,
              background: color,
              opacity: 0.8,
            }}
            title={`${r.report_date}: ${fmtPct(v)}${r.beat_miss ? ` (${r.beat_miss})` : ''}`}
          />
        );
      })}
    </div>
  );
}

// ─── component ─────────────────────────────────────────────────────────

export const EarningsMovesTile = memo(function EarningsMovesTile({ ticker }: { ticker: string }) {
  const { data: rows, isLoading } = useEarningsMoves(ticker);
  const { data: nextEarningsMap } = useNextEarningsByTicker();
  const nextEarnings = nextEarningsMap?.[ticker] ?? null;

  const stats = useMemo(() => computeStats(rows ?? []), [rows]);
  const proximityDays = useMemo(() => daysUntil(nextEarnings?.report_date), [nextEarnings]);
  const imminent = proximityDays !== null && proximityDays >= 0 && proximityDays <= PROXIMITY_DAYS;

  if (isLoading) {
    return (
      <Card className="p-3 bg-black/60 border-white/10 text-[11px] text-muted-foreground">
        <span className="uppercase tracking-wider text-[10px] text-muted-foreground/60 mr-2">Earnings moves</span>
        loading…
      </Card>
    );
  }

  if (!rows || rows.length === 0) {
    return (
      <Card className="p-3 bg-black/60 border-white/10 text-[11px] text-muted-foreground/70">
        <span className="uppercase tracking-wider text-[10px] text-muted-foreground/60 mr-2">Earnings moves</span>
        no historical earnings cached yet — weekly job
      </Card>
    );
  }

  const totalRows = rows.length;
  const priced = stats.n;
  const missing = totalRows - priced;

  const headlineColor = stats.avgMag >= 5 ? COLOR_AMBER : stats.avgMag >= 2 ? COLOR_MUTED : COLOR_MUTED;

  return (
    <Card className="p-3 bg-black/60 border-white/10">
      <div className="flex items-center justify-between mb-2">
        <span className="uppercase tracking-wider text-[10px] text-muted-foreground/70">
          Earnings moves · last {totalRows}
        </span>
        <div className="flex items-center gap-2">
          {imminent && (
            <Badge variant="outline" className="text-[9px] bg-amber-500/10 text-amber-400 border-amber-500/30 uppercase tracking-wider">
              earnings in {proximityDays}d
            </Badge>
          )}
          {missing > 0 && (
            <Badge variant="outline" className="text-[9px] bg-slate-500/10 text-slate-300 border-slate-500/30 uppercase tracking-wider">
              thin history · {priced}/{totalRows} priced
            </Badge>
          )}
        </div>
      </div>

      {priced === 0 ? (
        <div className="text-[11px] text-muted-foreground/70 italic leading-snug">
          past {totalRows} {totalRows === 1 ? 'report' : 'reports'} captured but price history is too thin for move calculation —
          coverage will improve as the tick pipeline accumulates history.
        </div>
      ) : (
        <>
          {/* Imminent-earnings proximity line (when next print is within PROXIMITY_DAYS) */}
          {imminent && (
            <div className="text-[11px] leading-snug mb-1" style={{ color: COLOR_AMBER }}>
              historical day-after move: <span className="font-semibold tabular-nums">{fmtMag(stats.avgMag)}</span> avg
              {nextEarnings?.report_time && <> · next print {nextEarnings.report_time.toUpperCase()} {nextEarnings.report_date}</>}
            </div>
          )}

          {/* Headline stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1 text-[11px] tabular-nums">
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">Avg mag</span>
              <span className="font-semibold text-sm" style={{ color: headlineColor }}>
                {fmtMag(stats.avgMag)}
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">Range</span>
              <span className="text-foreground">
                <span style={{ color: COLOR_CALL }}>{fmtPct(stats.max)}</span>
                <span className="text-muted-foreground mx-1">/</span>
                <span style={{ color: COLOR_PUT }}>{fmtPct(stats.min)}</span>
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">Std dev</span>
              <span className="text-foreground">{fmtMag(stats.std)}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">Beat/miss</span>
              <span className="text-foreground">
                <span style={{ color: COLOR_CALL }}>{stats.beats}</span>
                <span className="text-muted-foreground mx-0.5">/</span>
                <span style={{ color: COLOR_PUT }}>{stats.misses}</span>
                {stats.inline > 0 && (
                  <>
                    <span className="text-muted-foreground mx-0.5">/</span>
                    <span style={{ color: COLOR_MUTED }}>{stats.inline}</span>
                  </>
                )}
              </span>
            </div>
          </div>

          {/* Histogram of signed moves (oldest → newest) */}
          <Histogram rows={rows} />

          {stats.maxMagDate && (
            <div className="mt-1 text-[10px] text-muted-foreground/80 tabular-nums">
              biggest: {fmtPct(Math.abs(stats.max) >= Math.abs(stats.min) ? stats.max : stats.min)} on {fmtDate(stats.maxMagDate)}
            </div>
          )}
        </>
      )}
    </Card>
  );
});
