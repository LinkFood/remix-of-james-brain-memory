/**
 * GexDirectionStrips — per-ticker dealer-positioning thinking-structure rows.
 *
 * Iter #3 PR-B alpha-class primitive #2. Adds 10 dense numerical strips
 * (one per watchlist ticker) ABOVE the existing flow-positioning grid.
 * Each strip surfaces:
 *
 *   ticker · dealer-net badge · spot · γ flip · ↑/↓ Δ% · call wall · put floor
 *   · top-3 pin attractors (magnitude-scaled glyphs)
 *
 * Bloomberg-terminal density — font-mono, tabular-nums, single line per
 * ticker, color-coded by `dealer_net_direction` and `price_vs_flip`.
 *
 * Reads `useGexInference` exclusively. No flow data — keeps this primitive
 * structurally separate from the existing flow grid below it (Tenet 24:
 * surfaces compose, they don't merge).
 */

import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { ChevronUp, ChevronDown, Minus } from 'lucide-react';
import {
  useGexInference,
  type DealerNetDirection,
  type GexInferencePerTicker,
  type PinAttractor,
  type PriceVsFlip,
} from '@/hooks/useGexInference';

interface DealerStyle {
  badge: string;
  bg: string;
  ring: string;
  dot: string;
}

function dealerStyle(d: DealerNetDirection): DealerStyle {
  switch (d) {
    case 'positive_gamma':
      return {
        badge: 'text-emerald-300',
        bg: 'bg-emerald-500/10',
        ring: 'ring-emerald-500/30',
        dot: 'bg-emerald-400',
      };
    case 'negative_gamma':
      return {
        badge: 'text-red-300',
        bg: 'bg-red-500/10',
        ring: 'ring-red-500/30',
        dot: 'bg-red-400',
      };
    case 'flat':
    default:
      return {
        badge: 'text-muted-foreground',
        bg: 'bg-muted/20',
        ring: 'ring-muted/40',
        dot: 'bg-muted-foreground/60',
      };
  }
}

function dealerLabel(d: DealerNetDirection): string {
  switch (d) {
    case 'positive_gamma': return 'POS γ';
    case 'negative_gamma': return 'NEG γ';
    case 'flat': default:  return 'FLAT';
  }
}

function flipArrow(p: PriceVsFlip | null): JSX.Element {
  if (p === 'above') return <ChevronUp className="w-3 h-3 text-emerald-400 inline-block" />;
  if (p === 'below') return <ChevronDown className="w-3 h-3 text-red-400 inline-block" />;
  return <Minus className="w-3 h-3 text-amber-400 inline-block" />;
}

function fmt(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

function fmtPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}%`;
}

function priceVsFlipPct(t: GexInferencePerTicker): number | null {
  if (
    t.underlying_price == null ||
    t.gamma_flip_strike == null ||
    t.gamma_flip_strike === 0
  ) {
    return null;
  }
  return ((t.underlying_price - t.gamma_flip_strike) / t.gamma_flip_strike) * 100;
}

/** Pin attractor mini-glyphs — magnitude-scaled opacity, color from sign. */
function PinGlyphs({ pins }: { pins: PinAttractor[] }) {
  if (!pins || pins.length === 0) {
    return <span className="text-muted-foreground/50">—</span>;
  }
  const maxMag = pins.reduce((m, p) => (p.magnitude > m ? p.magnitude : m), 0);
  return (
    <span className="inline-flex items-center gap-1.5">
      {pins.map((p, i) => {
        const norm = maxMag > 0 ? Math.max(0.35, p.magnitude / maxMag) : 0.35;
        const isPos = p.signed_net_gex >= 0;
        return (
          <span
            key={`${p.strike}-${i}`}
            className={cn(
              'inline-flex items-center gap-0.5 text-[10px] tabular-nums',
              isPos ? 'text-emerald-300' : 'text-red-300',
            )}
            title={`strike $${p.strike} · net γ ${p.signed_net_gex >= 0 ? '+' : ''}${p.signed_net_gex.toFixed(1)}`}
          >
            <span
              className={cn(
                'inline-block w-1.5 h-1.5 rounded-full',
                isPos ? 'bg-emerald-400' : 'bg-red-400',
              )}
              style={{ opacity: norm }}
            />
            <span className="font-mono">${p.strike}</span>
          </span>
        );
      })}
    </span>
  );
}

interface StripRowProps {
  ticker: GexInferencePerTicker;
}

function StripRow({ ticker: t }: StripRowProps) {
  const ds = dealerStyle(t.dealer_net_direction);
  const pct = priceVsFlipPct(t);
  const empty = t.atm_strike_count === 0;

  return (
    <div
      className={cn(
        'grid items-center gap-2 px-2 py-1 rounded-sm font-mono text-[11px] tabular-nums',
        'hover:bg-muted/10 transition-colors',
      )}
      style={{
        gridTemplateColumns:
          '64px minmax(96px,auto) 84px 96px 56px 84px 84px minmax(160px,1fr)',
      }}
    >
      {/* ticker */}
      <div className="font-semibold text-foreground/95 tracking-wide">
        {t.ticker}
      </div>

      {/* dealer-net badge */}
      <div
        className={cn(
          'inline-flex items-center gap-1.5 px-2 py-0.5 rounded ring-1 text-[10px] font-semibold uppercase tracking-wide',
          ds.bg,
          ds.ring,
          ds.badge,
        )}
      >
        <span className={cn('w-1.5 h-1.5 rounded-full', ds.dot)} />
        {dealerLabel(t.dealer_net_direction)}
      </div>

      {/* spot */}
      <div>
        <span className="text-muted-foreground/70 text-[10px] uppercase tracking-wider mr-1">spot</span>
        <span className={empty ? 'text-muted-foreground/50' : 'text-foreground/90'}>
          {fmt(t.underlying_price)}
        </span>
      </div>

      {/* gamma flip */}
      <div>
        <span className="text-muted-foreground/70 text-[10px] uppercase tracking-wider mr-1">γ flip</span>
        <span className={empty ? 'text-muted-foreground/50' : 'text-foreground/90'}>
          {fmt(t.gamma_flip_strike)}
        </span>
      </div>

      {/* arrow */}
      <div className="flex items-center justify-center">
        {flipArrow(t.price_vs_flip)}
      </div>

      {/* Δ flip pct */}
      <div>
        <span className="text-muted-foreground/70 text-[10px] uppercase tracking-wider mr-1">Δ flip</span>
        <span
          className={cn(
            pct == null
              ? 'text-muted-foreground/50'
              : pct > 0
                ? 'text-emerald-300'
                : pct < 0
                  ? 'text-red-300'
                  : 'text-amber-300',
          )}
        >
          {fmtPct(pct)}
        </span>
      </div>

      {/* call wall */}
      <div>
        <span className="text-muted-foreground/70 text-[10px] uppercase tracking-wider mr-1">cw</span>
        <span className={t.call_wall_strike == null ? 'text-muted-foreground/50' : 'text-emerald-200'}>
          {t.call_wall_strike != null ? `$${t.call_wall_strike}` : '—'}
        </span>
      </div>

      {/* put floor */}
      <div>
        <span className="text-muted-foreground/70 text-[10px] uppercase tracking-wider mr-1">pf</span>
        <span className={t.put_floor_strike == null ? 'text-muted-foreground/50' : 'text-red-200'}>
          {t.put_floor_strike != null ? `$${t.put_floor_strike}` : '—'}
        </span>
      </div>

      {/* pin attractors */}
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground/70 text-[10px] uppercase tracking-wider">pins</span>
        <PinGlyphs pins={t.pin_attractor_strikes} />
      </div>
    </div>
  );
}

export function GexDirectionStrips() {
  const { data, isLoading, isError } = useGexInference();

  if (isLoading && !data) {
    return (
      <Card className="p-3 border-dashed">
        <div className="text-[11px] font-mono text-muted-foreground uppercase tracking-wider">
          dealer-positioning loading…
        </div>
      </Card>
    );
  }

  if (isError || !data || data.per_ticker.length === 0) {
    return (
      <Card className="p-3 border-dashed">
        <div className="text-[11px] font-mono text-muted-foreground uppercase tracking-wider">
          dealer-positioning unavailable
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-2">
      <div className="px-1 pb-1.5 mb-1 border-b border-border/40 flex items-center gap-3">
        <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
          dealer positioning · per ticker
        </span>
        <span className="text-[10px] font-mono text-muted-foreground/60">
          ATM-band most-recent snapshot · spot · γ flip · walls · pins
        </span>
      </div>
      <div className="space-y-0.5">
        {data.per_ticker.map((t) => (
          <StripRow key={t.ticker} ticker={t} />
        ))}
      </div>
    </Card>
  );
}
