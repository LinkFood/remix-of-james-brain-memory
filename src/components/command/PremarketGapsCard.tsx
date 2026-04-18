/**
 * PremarketGapsCard — renders today's ct_premarket_gaps as a compact table.
 *
 * Fed by ct-premarket-scan (13:15 UTC / 9:15 ET weekdays). Hidden when
 * every scanned ticker lands in the 'flat' tier — no point consuming
 * screen real estate on a quiet overnight.
 *
 * Placement: above ColdOpen on CommandStation, because the gap read is
 * time-boxed (only relevant for ~the first hour after the bell).
 *
 * No new UW calls here — pure read of the ct_premarket_gaps row that the
 * scanner upserts.
 */

import { memo } from 'react';
import { Card } from '@/components/ui/card';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

type Tier = 'flat' | 'minor' | 'moderate' | 'significant' | 'extreme';
type Direction = 'up' | 'down' | 'flat';

interface PremarketGapRow {
  id: string;
  ticker: string;
  prev_close: number | null;
  premarket_price: number | null;
  gap_pct: number | null;
  gap_direction: Direction | null;
  magnitude_tier: Tier | null;
  captured_at: string;
  session_date: string;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function usePremarketGaps() {
  return useQuery<PremarketGapRow[]>({
    queryKey: ['ct_premarket_gaps_today'],
    refetchInterval: 5 * 60_000, // 5 min — the scan only fires once, but watchlist adds are cheap
    queryFn: async () => {
      const today = todayIsoDate();
      const { data, error } = await supabase
        .from('ct_premarket_gaps')
        .select('id, ticker, prev_close, premarket_price, gap_pct, gap_direction, magnitude_tier, captured_at, session_date')
        .eq('session_date', today)
        .order('gap_pct', { ascending: false, nullsFirst: false });
      if (error) throw error;
      return (data ?? []) as PremarketGapRow[];
    },
  });
}

interface TierBadgeStyle {
  label: string;
  bg: string;
  text: string;
  border: string;
}

const TIER_STYLES: Record<Tier, TierBadgeStyle> = {
  flat:        { label: 'flat',        bg: 'bg-muted/30',       text: 'text-muted-foreground', border: 'border-muted/40' },
  minor:       { label: 'minor',       bg: 'bg-sky-500/15',     text: 'text-sky-300',          border: 'border-sky-500/30' },
  moderate:    { label: 'moderate',    bg: 'bg-amber-500/15',   text: 'text-amber-300',        border: 'border-amber-500/30' },
  significant: { label: 'significant', bg: 'bg-orange-500/20',  text: 'text-orange-300',       border: 'border-orange-500/40' },
  extreme:     { label: 'extreme',     bg: 'bg-red-500/20',     text: 'text-red-300',          border: 'border-red-500/40' },
};

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1000) return n.toFixed(1);
  return n.toFixed(2);
}

function fmtPct(pct: number | null): string {
  if (pct == null || !Number.isFinite(pct)) return '—';
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

const DirectionIcon = memo(function DirectionIcon({ dir }: { dir: Direction | null }) {
  if (dir === 'up')   return <TrendingUp  className="w-3.5 h-3.5 text-emerald-400" />;
  if (dir === 'down') return <TrendingDown className="w-3.5 h-3.5 text-red-400" />;
  return <Minus className="w-3.5 h-3.5 text-muted-foreground" />;
});

export function PremarketGapsCard() {
  const { data, isLoading } = usePremarketGaps();
  const rows = data ?? [];

  // Hide if nothing loaded OR every ticker is flat (the task's exact rule).
  const hasNonFlat = rows.some(r => r.magnitude_tier && r.magnitude_tier !== 'flat');
  if (!isLoading && rows.length === 0) return null;
  if (!isLoading && !hasNonFlat) return null;

  return (
    <Card className="py-2.5 px-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground font-semibold">
          Pre-market Gaps · {todayIsoDate()}
        </div>
        <div className="text-[10px] text-muted-foreground/70 font-mono">
          9:15 ET scan · |gap| ≥ 0.2%
        </div>
      </div>

      {isLoading ? (
        <div className="text-xs text-muted-foreground py-2">loading…</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground border-b border-white/5">
                <th className="text-left font-medium py-1.5 pr-3">Ticker</th>
                <th className="text-right font-medium py-1.5 pr-3">Prev Close</th>
                <th className="text-right font-medium py-1.5 pr-3">Pre-market</th>
                <th className="text-right font-medium py-1.5 pr-3">Gap</th>
                <th className="text-left font-medium py-1.5 pl-2">Tier</th>
              </tr>
            </thead>
            <tbody>
              {rows
                .filter(r => r.magnitude_tier && r.magnitude_tier !== 'flat')
                .map((r) => {
                  const tier = (r.magnitude_tier ?? 'flat') as Tier;
                  const style = TIER_STYLES[tier];
                  const pct = r.gap_pct;
                  const pctColor =
                    pct == null ? 'text-muted-foreground'
                    : pct > 0 ? 'text-emerald-300'
                    : pct < 0 ? 'text-red-300'
                    : 'text-foreground/80';

                  return (
                    <tr key={r.id} className="border-b border-white/5 last:border-b-0 hover:bg-white/[0.02] transition-colors">
                      <td className="py-1.5 pr-3">
                        <div className="flex items-center gap-1.5">
                          <DirectionIcon dir={r.gap_direction} />
                          <span className="font-semibold text-foreground/95">{r.ticker}</span>
                        </div>
                      </td>
                      <td className="py-1.5 pr-3 text-right text-muted-foreground">
                        {fmtPrice(r.prev_close)}
                      </td>
                      <td className="py-1.5 pr-3 text-right text-foreground/90">
                        {fmtPrice(r.premarket_price)}
                      </td>
                      <td className={`py-1.5 pr-3 text-right font-semibold ${pctColor}`}>
                        {fmtPct(pct)}
                      </td>
                      <td className="py-1.5 pl-2">
                        <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider font-medium border ${style.bg} ${style.text} ${style.border}`}>
                          {style.label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}

      {/* Subtle footnote for missing-baseline tickers, if any. */}
      {rows.some(r => r.magnitude_tier == null) && (
        <div className="mt-1.5 text-[10px] text-muted-foreground/60 text-right font-mono">
          {rows.filter(r => r.magnitude_tier == null).length} ticker(s) missing baseline
        </div>
      )}
    </Card>
  );
}
