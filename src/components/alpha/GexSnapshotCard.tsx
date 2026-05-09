/**
 * GexSnapshotCard — /alpha medium-temporal-layer surface (iter #3 PR-C).
 *
 * Surgical-grade dealer-positioning view across the 10-ticker watchlist in
 * one glance. Captain reads gamma flip / call wall / put floor / dealer net
 * direction across SPY/QQQ/IWM + Mag7 in <5 seconds. Composes the
 * `gex_inference` brain organ (PR-A #104) — same kernel that PR-B /heatmap
 * redesign consumes.
 *
 * Identity: Bloomberg-terminal-class density per the v2 alpha brief. Same
 * shape language as <NewsCausalityMatrix /> — header strip + structured
 * grid + footer. Click row → drill to /heatmap?ticker={t} (PR-B mounts the
 * depth view; query param is the agreed-upon hand-off).
 *
 * Not a price chart. Not a strategy recommender. Pure dealer-positioning
 * signal — captain reads, captain decides.
 */

import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import {
  Crosshair,
  ArrowUp,
  ArrowDown,
  Minus,
  ArrowUpRight,
} from 'lucide-react';
import {
  useGexInference,
  ALPHA_GEX_WATCHLIST,
  type GexInferencePerTicker,
  type DealerNetDirection,
  type ConsensusDirection,
  type PriceVsFlip,
} from '@/hooks/useGexInference';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtStrike(s: number | null): string {
  if (s == null) return '—';
  if (Math.abs(s) >= 1000) return s.toFixed(0);
  if (Math.abs(s) >= 100) return s.toFixed(1);
  return s.toFixed(2);
}

function fmtPrice(p: number | null): string {
  if (p == null) return '—';
  if (Math.abs(p) >= 1000) return p.toFixed(2);
  return p.toFixed(2);
}

function fmtAgo(iso: string | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const minutes = Math.max(0, Math.round((Date.now() - t) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// Style helpers
// ---------------------------------------------------------------------------

function dealerBadgeClass(d: DealerNetDirection): string {
  if (d === 'positive_gamma') return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
  if (d === 'negative_gamma') return 'bg-red-500/15 text-red-300 border-red-500/30';
  return 'bg-muted/20 text-muted-foreground border-border/30';
}

function dealerLabel(d: DealerNetDirection): string {
  if (d === 'positive_gamma') return '+γ';
  if (d === 'negative_gamma') return '−γ';
  return 'flat';
}

function consensusClass(c: ConsensusDirection): string {
  if (c === 'broad_positive_gamma') return 'bg-emerald-600/25 text-emerald-200 border-emerald-500/40';
  if (c === 'broad_negative_gamma') return 'bg-red-600/25 text-red-200 border-red-500/40';
  if (c === 'mixed') return 'bg-amber-500/20 text-amber-200 border-amber-500/40';
  return 'bg-muted/20 text-muted-foreground border-border/30';
}

function consensusLabel(c: ConsensusDirection): string {
  if (c === 'broad_positive_gamma') return 'BROAD POSITIVE GAMMA';
  if (c === 'broad_negative_gamma') return 'BROAD NEGATIVE GAMMA';
  if (c === 'mixed') return 'MIXED';
  return 'NO SIGNAL';
}

function flipArrow(p: PriceVsFlip | null) {
  if (p === 'above') return <ArrowUp className="w-3 h-3 text-emerald-400" aria-label="above flip" />;
  if (p === 'below') return <ArrowDown className="w-3 h-3 text-red-400" aria-label="below flip" />;
  if (p === 'at') return <Minus className="w-3 h-3 text-amber-300" aria-label="at flip" />;
  return <span className="text-muted-foreground/50 text-[10px]">·</span>;
}

// ---------------------------------------------------------------------------
// Per-ticker row
// ---------------------------------------------------------------------------

function farFromSpot(strike: number | null, spot: number | null, threshold = 0.03): boolean {
  if (strike == null || spot == null || spot === 0) return false;
  return Math.abs((strike - spot) / spot) > threshold;
}

interface RowProps {
  t: GexInferencePerTicker;
}

function TickerRow({ t }: RowProps) {
  const noData = t.atm_strike_count === 0;
  const callFar = farFromSpot(t.call_wall_strike, t.underlying_price);
  const putFar = farFromSpot(t.put_floor_strike, t.underlying_price);

  return (
    <Link
      to={`/heatmap?ticker=${encodeURIComponent(t.ticker)}`}
      className={cn(
        'grid items-center gap-2 px-2 py-1.5 rounded-sm border border-transparent',
        'hover:border-primary/30 hover:bg-muted/10 transition-colors cursor-pointer',
        'text-[10.5px] font-mono',
      )}
      style={{
        gridTemplateColumns: 'minmax(48px,56px) minmax(48px,56px) minmax(60px,72px) minmax(20px,24px) minmax(60px,72px) minmax(60px,72px) minmax(60px,72px)',
      }}
      aria-label={`${t.ticker} — open /heatmap depth view`}
    >
      {/* Ticker */}
      <span className="font-bold text-foreground tracking-wider">{t.ticker}</span>

      {/* Dealer direction badge */}
      <span
        className={cn(
          'inline-flex items-center justify-center px-1.5 py-0.5 border rounded text-[9.5px] uppercase',
          dealerBadgeClass(t.dealer_net_direction),
        )}
        title={`dealer net direction: ${t.dealer_net_direction}`}
      >
        {dealerLabel(t.dealer_net_direction)}
      </span>

      {/* Underlying price */}
      <span className="text-foreground/90 tabular-nums">
        {noData ? <span className="text-muted-foreground/40">no data</span> : fmtPrice(t.underlying_price)}
      </span>

      {/* Direction arrow (above/below/at flip) */}
      <span className="inline-flex items-center justify-center" title={`price vs flip: ${t.price_vs_flip ?? '—'}`}>
        {flipArrow(t.price_vs_flip)}
      </span>

      {/* γ flip */}
      <span className="text-foreground/80 tabular-nums" title="gamma flip strike">
        <span className="text-muted-foreground/60 mr-1">γ</span>
        {fmtStrike(t.gamma_flip_strike)}
      </span>

      {/* Call wall */}
      <span
        className={cn('tabular-nums', callFar ? 'text-muted-foreground/50' : 'text-emerald-300/80')}
        title="call wall (top resistance)"
      >
        <span className="text-muted-foreground/60 mr-1">C</span>
        {fmtStrike(t.call_wall_strike)}
      </span>

      {/* Put floor */}
      <span
        className={cn('tabular-nums', putFar ? 'text-muted-foreground/50' : 'text-red-300/80')}
        title="put floor (bottom support)"
      >
        <span className="text-muted-foreground/60 mr-1">P</span>
        {fmtStrike(t.put_floor_strike)}
      </span>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export function GexSnapshotCard() {
  const { data, isLoading, isError } = useGexInference(ALPHA_GEX_WATCHLIST);

  if (isLoading) {
    return (
      <Card className="p-3 bg-muted/10 border-primary/20">
        <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
          GEX Snapshot · loading...
        </div>
      </Card>
    );
  }

  if (isError || !data) {
    return (
      <Card className="p-3 bg-muted/10 border-primary/20">
        <div className="flex items-center gap-2 mb-1">
          <Crosshair className="w-3.5 h-3.5 text-primary" />
          <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground font-semibold">
            GEX Snapshot · dealer positioning
          </span>
        </div>
        <div className="text-[11px] text-muted-foreground/70 italic">
          GEX inference unavailable. ct_gex_timeseries ingester writes every ~5 min — surface fills as snapshots arrive.
        </div>
      </Card>
    );
  }

  const { per_ticker, watchlist, generated_at, organ_status } = data;
  const consensus = watchlist.consensus_direction;
  const populatedCount = per_ticker.filter((t) => t.atm_strike_count > 0).length;

  // Stable order: keep the ALPHA_GEX_WATCHLIST canonical sequence so captain's
  // muscle memory matches across visits.
  const ordered = [...ALPHA_GEX_WATCHLIST]
    .map((tk) => per_ticker.find((t) => t.ticker === tk))
    .filter((t): t is GexInferencePerTicker => t !== undefined);

  return (
    <Card className="p-3 bg-muted/10 border-primary/20 space-y-2">
      {/* Header strip */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Crosshair className="w-3.5 h-3.5 text-primary" />
          <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground font-semibold">
            GEX Snapshot · dealer positioning
          </span>
        </div>
        <div className="flex items-center gap-3 text-[9.5px] font-mono">
          <span
            className={cn(
              'inline-flex items-center px-1.5 py-0.5 border rounded text-[9.5px] uppercase font-semibold tracking-wider',
              consensusClass(consensus),
            )}
            title="watchlist consensus across dealer net direction"
          >
            {consensusLabel(consensus)}
          </span>
          <span className="text-muted-foreground tabular-nums">
            <span className="text-emerald-400">{watchlist.tickers_above_flip}</span>
            <span className="text-muted-foreground/60 mx-0.5">↑</span>
            <span className="text-muted-foreground/40">/</span>
            <span className="text-red-400">{watchlist.tickers_below_flip}</span>
            <span className="text-muted-foreground/60 mx-0.5">↓</span>
            <span className="text-muted-foreground/60 ml-0.5">flip</span>
          </span>
          <span className="text-muted-foreground/70" title={generated_at}>
            {fmtAgo(generated_at)}
          </span>
        </div>
      </div>

      {/* Column header */}
      <div
        className="grid items-center gap-2 px-2 text-[8.5px] font-mono uppercase tracking-wider text-muted-foreground/60"
        style={{
          gridTemplateColumns: 'minmax(48px,56px) minmax(48px,56px) minmax(60px,72px) minmax(20px,24px) minmax(60px,72px) minmax(60px,72px) minmax(60px,72px)',
        }}
      >
        <span>ticker</span>
        <span>dealer</span>
        <span>spot</span>
        <span className="text-center">vs</span>
        <span>γ flip</span>
        <span>call wall</span>
        <span>put floor</span>
      </div>

      {/* Rows */}
      <div className="space-y-0.5">
        {ordered.map((t) => (
          <TickerRow key={t.ticker} t={t} />
        ))}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between gap-3 pt-1 border-t border-border/30">
        <div className="text-[9px] font-mono text-muted-foreground/60 leading-snug">
          {populatedCount}/{ALPHA_GEX_WATCHLIST.length} populated
          {organ_status !== 'populated' && (
            <span className="ml-1.5 text-amber-400/70">· {organ_status}</span>
          )}
          <span className="ml-2 opacity-70">
            +γ = dealer long gamma (mean reversion) · −γ = dealer short gamma (momentum amplifier)
          </span>
        </div>
        <Link
          to="/heatmap"
          className="inline-flex items-center gap-1 text-[9.5px] font-mono uppercase tracking-wider text-primary/80 hover:text-primary transition-colors"
          title="open /heatmap depth view"
        >
          /heatmap <ArrowUpRight className="w-3 h-3" />
        </Link>
      </div>
    </Card>
  );
}
