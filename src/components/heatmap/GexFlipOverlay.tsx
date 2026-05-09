/**
 * GexFlipOverlay — per-ticker structural-levels rail rendered ABOVE the
 * per-ticker strikes-by-expiry grid.
 *
 * Iter #3 PR-B alpha-class primitive #3. The brief asked for a horizontal
 * gamma-flip line "on each strike's row visualization" but constrains:
 * "DO NOT touch the existing per-ticker view's existing rendering." Those
 * pull in opposite directions if rendered inside the grid; this primitive
 * resolves the tension by surfacing the same structural-level information
 * (gamma flip · call wall · put floor) as a sibling rail directly above the
 * grid, scoped to the same 10 tickers, so the captain can scan the levels
 * for whichever ticker they then select in the grid below.
 *
 * The result is structurally clean — the existing FlowHeatmapPerTicker stays
 * untouched, and the alpha-class GEX layer composes ON TOP. Per Tenet 24
 * (surfaces compose, they don't merge).
 *
 * One row per ticker, each row = (ticker | spot | γ flip — call wall — put
 * floor visual rail). The rail uses % distance-to-spot to position the three
 * markers, so a glance reveals where dealers are pinned relative to where
 * the underlying is right now.
 */

import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import {
  useGexInference,
  type GexInferencePerTicker,
} from '@/hooks/useGexInference';

/** Tighter horizon than full-grid percentile — surfaces the levels right around spot. */
const PCT_HALF_WIDTH = 5; // ±5% rail

function pct(level: number | null, spot: number | null): number | null {
  if (level == null || spot == null || spot === 0) return null;
  return ((level - spot) / spot) * 100;
}

/** Map a percentage delta into the rail's [0%, 100%] coordinate space.
 *  Out-of-rail values clip to edges with a hint marker. */
function railPosition(deltaPct: number | null): { left: string; clipped: 'low' | 'high' | null } {
  if (deltaPct == null) return { left: '50%', clipped: null };
  if (deltaPct < -PCT_HALF_WIDTH) return { left: '0%', clipped: 'low' };
  if (deltaPct > +PCT_HALF_WIDTH) return { left: '100%', clipped: 'high' };
  const t = (deltaPct + PCT_HALF_WIDTH) / (2 * PCT_HALF_WIDTH);
  return { left: `${(t * 100).toFixed(2)}%`, clipped: null };
}

interface RailRowProps {
  ticker: GexInferencePerTicker;
}

function RailRow({ ticker: t }: RailRowProps) {
  const empty = t.atm_strike_count === 0 || t.underlying_price == null;
  const flipPct = pct(t.gamma_flip_strike, t.underlying_price);
  const cwPct   = pct(t.call_wall_strike, t.underlying_price);
  const pfPct   = pct(t.put_floor_strike, t.underlying_price);

  const flipPos = railPosition(flipPct);
  const cwPos   = railPosition(cwPct);
  const pfPos   = railPosition(pfPct);

  return (
    <div
      className="grid items-center gap-2 px-2 py-1 font-mono text-[11px] tabular-nums"
      style={{ gridTemplateColumns: '56px 88px 1fr 56px' }}
    >
      {/* ticker */}
      <div className="font-semibold text-foreground/95 tracking-wide">{t.ticker}</div>

      {/* spot */}
      <div>
        <span className="text-muted-foreground/70 text-[10px] uppercase tracking-wider mr-1">spot</span>
        <span className={empty ? 'text-muted-foreground/50' : 'text-foreground/90'}>
          {t.underlying_price != null ? t.underlying_price.toFixed(2) : '—'}
        </span>
      </div>

      {/* rail */}
      <div className="relative h-5 rounded-sm bg-muted/15 ring-1 ring-border/50 overflow-hidden">
        {/* spot anchor (always center) */}
        <div className="absolute top-0 bottom-0 w-px bg-foreground/40" style={{ left: '50%' }} />
        <div className="absolute top-0 -translate-y-3 -translate-x-1/2 text-[9px] uppercase tracking-wider text-foreground/60" style={{ left: '50%' }}>
          {/* spacer above for label alignment in the legend below — kept hidden */}
        </div>

        {/* gamma flip marker — primary dashed */}
        {flipPct != null && (
          <div
            className="absolute top-0 bottom-0 border-l border-dashed border-primary"
            style={{ left: flipPos.left }}
            title={`γ flip $${t.gamma_flip_strike?.toFixed(2)} (${flipPct >= 0 ? '+' : ''}${flipPct.toFixed(2)}%)`}
          >
            <span className="absolute -top-0 left-1 text-[9px] font-semibold text-primary uppercase">γ</span>
          </div>
        )}

        {/* call wall marker — emerald solid above spot */}
        {cwPct != null && cwPct >= 0 && (
          <div
            className="absolute top-1 bottom-1 w-1.5 rounded-sm bg-emerald-500/80"
            style={{ left: cwPos.left, transform: 'translateX(-50%)' }}
            title={`call wall $${t.call_wall_strike} (${cwPct >= 0 ? '+' : ''}${cwPct.toFixed(2)}%)`}
          />
        )}

        {/* put floor marker — red solid below spot */}
        {pfPct != null && pfPct <= 0 && (
          <div
            className="absolute top-1 bottom-1 w-1.5 rounded-sm bg-red-500/80"
            style={{ left: pfPos.left, transform: 'translateX(-50%)' }}
            title={`put floor $${t.put_floor_strike} (${pfPct >= 0 ? '+' : ''}${pfPct.toFixed(2)}%)`}
          />
        )}

        {/* clip indicators */}
        {flipPos.clipped === 'low' && (
          <span className="absolute left-0 top-0 bottom-0 w-2 bg-gradient-to-r from-primary/40 to-transparent" />
        )}
        {flipPos.clipped === 'high' && (
          <span className="absolute right-0 top-0 bottom-0 w-2 bg-gradient-to-l from-primary/40 to-transparent" />
        )}
      </div>

      {/* delta-flip pct on the right edge for at-a-glance read */}
      <div className="text-right">
        <span
          className={cn(
            flipPct == null
              ? 'text-muted-foreground/50'
              : flipPct > 0
                ? 'text-emerald-300'
                : flipPct < 0
                  ? 'text-red-300'
                  : 'text-amber-300',
          )}
        >
          {flipPct != null ? `${flipPct >= 0 ? '+' : ''}${flipPct.toFixed(2)}%` : '—'}
        </span>
      </div>
    </div>
  );
}

export function GexFlipOverlay() {
  const { data, isLoading, isError } = useGexInference();

  if (isLoading && !data) {
    return (
      <Card className="p-3 border-dashed">
        <div className="text-[11px] font-mono text-muted-foreground uppercase tracking-wider">
          gamma-flip rail loading…
        </div>
      </Card>
    );
  }

  if (isError || !data || data.per_ticker.length === 0) {
    return (
      <Card className="p-3 border-dashed">
        <div className="text-[11px] font-mono text-muted-foreground uppercase tracking-wider">
          gamma-flip rail unavailable
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-2">
      <div className="px-1 pb-1.5 mb-1 border-b border-border/40 flex items-center gap-3 flex-wrap">
        <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
          structural levels rail · ±{PCT_HALF_WIDTH}% from spot
        </span>
        <span className="text-[10px] font-mono text-muted-foreground/60 inline-flex items-center gap-2">
          <span className="inline-flex items-center gap-1">
            <span className="inline-block w-2 h-px border-t border-dashed border-primary" />
            <span>γ flip</span>
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block w-1.5 h-2 bg-emerald-500/80 rounded-sm" />
            <span>call wall</span>
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block w-1.5 h-2 bg-red-500/80 rounded-sm" />
            <span>put floor</span>
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block w-px h-2 bg-foreground/40" />
            <span>spot anchor</span>
          </span>
        </span>
      </div>
      <div className="space-y-0.5">
        {data.per_ticker.map((t) => (
          <RailRow key={t.ticker} ticker={t} />
        ))}
      </div>
    </Card>
  );
}
