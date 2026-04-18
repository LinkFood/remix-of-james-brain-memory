/**
 * GexRadar — port of James's TrendSpider "GEX Radar" indicator.
 *
 * Three parallel columns (default SPY / QQQ / IWM). Each column:
 *   - header: ticker + spot
 *   - sub-header: GAMMA▲/▼ regime + flip level; ★king / ♛queen
 *   - table: Strike | Net GEX (30 rows centered on spot)
 *     • spot row highlighted teal (#00E6B4)
 *     • king marked ★ gold (#F5D78E)
 *     • queen marked ♛ orange (#EF9F27)
 *     • gamma flip row yellow divider (#FFD600)
 *     • net-GEX cells use the netBgR / cellTxtR color ramps from the TS script
 *     • velocity badges on top-6 |OIC%| strikes (≥5%)
 *   - footer: Δ OPEN in green/red
 *
 * All aggregation happens in the edge function (ct-gex-radar). This file
 * only renders — memoized on tickers prop.
 */
import { memo, useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { FreshnessChip } from '@/components/FreshnessChip';
import { useGexRadar, type GexRadarTicker, type GexRadarStrike } from '@/hooks/useGexRadar';
import { LinkGexDeep } from './LinkGexDeep';

// -----------------------------------------------------------------------------
// Color constants — ported verbatim from James's TrendSpider script.
// -----------------------------------------------------------------------------
const COLOR_CALL = '#00C853';
const COLOR_PUT = '#FF1744';
const COLOR_SPOT = '#00E6B4';
const COLOR_KING = '#F5D78E';
const COLOR_QUEEN = '#EF9F27';
const COLOR_GAMMA_FLIP = '#FFD600';

// netBgR: positive ramp (teal/cyan) for positive netGex,
// negative ramp (amber) for negative netGex. Indices 0..5, 0 = near-zero.
const NET_BG_POS = ['#0e1c28', '#113548', '#154f6c', '#1d7aa3', '#31a5cf', '#52d0f5'];
const NET_BG_NEG = ['#18120a', '#2a2012', '#3e2f18', '#584425', '#816537', '#b8a545'];

// cellTxtR: text colors paired with each bg level — deep → bright.
const CELL_TXT_POS = ['#6edbf5', '#84e2f6', '#a7ecfa', '#cdf4fc', '#e3fafe', '#ffffff'];
const CELL_TXT_NEG = ['#f5c986', '#f7d29b', '#f9dcb2', '#fbe4c7', '#fdecd8', '#ffffff'];

interface Props {
  tickers?: string[];
  windowSize?: number;
  /**
   * Optional: parent-owned drill-down opener. If provided, clicks are
   * forwarded up and the internal Sheet is NOT rendered — the parent owns
   * the LinkGexDeep sheet (so the AlwaysOnFlagStrip can share it).
   * If omitted, GexRadar keeps its own internal sheet (original behavior).
   */
  onDrillDown?: (ticker: string) => void;
}

const DEFAULT_TICKERS = ['SPY', 'QQQ', 'IWM'];

// -----------------------------------------------------------------------------
// Formatting helpers
// -----------------------------------------------------------------------------

function fmtStrike(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  // Strikes can be fractional (e.g. 462.5 on SPY). Show 1 decimal only if needed.
  return Number.isInteger(n) ? n.toFixed(0) : n.toFixed(1);
}

function fmtSpot(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Large gamma number → e.g. "-2.1M", "+450K". */
function fmtGex(n: number): string {
  const sign = n >= 0 ? '+' : '-';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(0)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

function fmtPct(n: number): string {
  const sign = n >= 0 ? '+' : '-';
  return `${sign}${Math.abs(n).toFixed(0)}%`;
}

/**
 * Map |netGex| / max → 0..5 bucket into the ramp.
 */
function rampIndex(abs: number, max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 0;
  const t = Math.max(0, Math.min(1, abs / max));
  return Math.min(5, Math.floor(t * 6));
}

function netCellColors(netGex: number, maxAbsNet: number): { bg: string; fg: string } {
  const idx = rampIndex(Math.abs(netGex), maxAbsNet);
  if (netGex >= 0) return { bg: NET_BG_POS[idx], fg: CELL_TXT_POS[idx] };
  return { bg: NET_BG_NEG[idx], fg: CELL_TXT_NEG[idx] };
}

// -----------------------------------------------------------------------------
// Velocity badge: "+45%C" (calls building), "-12%P" (puts leaving), etc.
// Color rules from TS script:
//   calls building (cOIC>0 dominant)  → green   (#00C853)
//   puts building  (pOIC>0 dominant)  → red     (#FF1744)
//   calls leaving  (cOIC<0 dominant)  → red     (#FF1744)
//   puts leaving   (pOIC<0 dominant)  → dim amber
// -----------------------------------------------------------------------------
function velocityBadge(strike: GexRadarStrike): { label: string; color: string } | null {
  if (!strike.show_velocity || strike.velocity_pct === null || strike.dominant_side === null) {
    return null;
  }
  const side = strike.dominant_side;
  const pct = strike.velocity_pct;
  const sideOIC = side === 'C' ? strike.cOIC : strike.pOIC;
  let color: string;
  if (side === 'C') {
    color = sideOIC >= 0 ? COLOR_CALL : COLOR_PUT;        // calls building vs leaving
  } else {
    color = sideOIC >= 0 ? COLOR_PUT : '#8a6f2f';         // puts building vs leaving (dim amber)
  }
  return { label: `${fmtPct(pct)}${side}`, color };
}

// -----------------------------------------------------------------------------
// Single ticker column
// -----------------------------------------------------------------------------

interface ColumnProps {
  t: GexRadarTicker;
  onDrillDown?: (ticker: string) => void;
}

const TickerColumn = memo(function TickerColumn({ t, onDrillDown }: ColumnProps) {
  const { maxAbsNet, flipAfterIdx } = useMemo(() => {
    let m = 0;
    for (const s of t.strikes) m = Math.max(m, Math.abs(s.netGex));
    // Figure out where the flip row should render. If we have a flip value,
    // insert the divider between the two strikes it falls between.
    let flipIdx = -1;
    if (t.gammaFlip !== null && t.strikes.length > 1) {
      for (let i = 0; i < t.strikes.length - 1; i++) {
        const a = t.strikes[i].strike;
        const b = t.strikes[i + 1].strike;
        if ((t.gammaFlip >= a && t.gammaFlip <= b) || (t.gammaFlip >= b && t.gammaFlip <= a)) {
          flipIdx = i;
          break;
        }
      }
    }
    return { maxAbsNet: m, flipAfterIdx: flipIdx };
  }, [t.strikes, t.gammaFlip]);

  // Find spot row index for highlight — the strike closest to spot.
  const spotRowIdx = useMemo(() => {
    if (t.spot === null) return -1;
    let idx = -1;
    let best = Infinity;
    for (let i = 0; i < t.strikes.length; i++) {
      const d = Math.abs(t.strikes[i].strike - t.spot);
      if (d < best) { best = d; idx = i; }
    }
    return idx;
  }, [t.strikes, t.spot]);

  const regimeColor = t.regime === 'pos' ? COLOR_CALL : t.regime === 'neg' ? COLOR_PUT : '#888';
  const regimeLabel = t.regime === 'pos' ? 'GAMMA▲' : t.regime === 'neg' ? 'GAMMA▼' : 'GAMMA·';

  return (
    <div
      className={`flex-1 min-w-0 border border-white/10 rounded-md bg-black/40 overflow-hidden ${
        onDrillDown ? 'cursor-pointer hover:border-white/25 transition-colors' : ''
      }`}
      onClick={onDrillDown ? () => onDrillDown(t.ticker) : undefined}
      role={onDrillDown ? 'button' : undefined}
      tabIndex={onDrillDown ? 0 : undefined}
      onKeyDown={onDrillDown ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onDrillDown(t.ticker);
        }
      } : undefined}
      title={onDrillDown ? `Open LinkGex deep view for ${t.ticker}` : undefined}
    >
      {/* Header: ticker + spot */}
      <div className="px-3 py-2 border-b border-white/10 flex items-baseline justify-between">
        <div className="text-lg font-bold tracking-wide">{t.ticker}</div>
        <div className="text-xl font-bold tabular-nums" style={{ color: COLOR_SPOT }}>
          {fmtSpot(t.spot)}
        </div>
      </div>

      {/* Regime + king/queen sub-header */}
      <div className="px-3 py-1.5 border-b border-white/10 space-y-0.5">
        <div className="flex items-center justify-between text-[11px] tabular-nums">
          <span className="font-semibold" style={{ color: regimeColor }}>
            {regimeLabel}{' '}
            <span className="text-muted-foreground font-normal">
              γ{fmtStrike(t.gammaFlip)}
            </span>
          </span>
          <span className="text-muted-foreground">
            Δ <span style={{ color: t.deltaOpen >= 0 ? COLOR_CALL : COLOR_PUT }}>
              {fmtGex(t.deltaOpen)}
            </span>
          </span>
        </div>
        <div className="flex items-center justify-between text-[11px] tabular-nums">
          <span style={{ color: COLOR_KING }}>★ {fmtStrike(t.king)}</span>
          <span style={{ color: COLOR_QUEEN }}>♛ {fmtStrike(t.queen)}</span>
        </div>
        <div className="flex items-center justify-between text-[10px] tabular-nums text-muted-foreground">
          <span>
            CW <span style={{ color: COLOR_CALL }}>{fmtStrike(t.callWall)}</span>
          </span>
          <span>
            PW <span style={{ color: COLOR_PUT }}>{fmtStrike(t.putWall)}</span>
          </span>
        </div>
      </div>

      {/* Table header */}
      <div className="grid grid-cols-[1fr_1.4fr] px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground border-b border-white/10 bg-black/30">
        <span>Strike</span>
        <span className="text-right">Net GEX</span>
      </div>

      {/* Strike rows */}
      <div className="divide-y divide-white/5">
        {t.strikes.length === 0 && (
          <div className="px-3 py-3 text-xs text-muted-foreground text-center">
            {t.errors.length ? `err: ${t.errors[0]}` : 'no data'}
          </div>
        )}
        {t.strikes.map((s, i) => {
          const isSpot = i === spotRowIdx;
          const isKing = t.king !== null && s.strike === t.king;
          const isQueen = t.queen !== null && s.strike === t.queen;
          const { bg, fg } = netCellColors(s.netGex, maxAbsNet);
          const badge = velocityBadge(s);

          let prefix = '';
          if (isKing) prefix = '★';
          else if (isQueen) prefix = '♛';

          const strikeColor = isSpot
            ? COLOR_SPOT
            : isKing
              ? COLOR_KING
              : isQueen
                ? COLOR_QUEEN
                : '#cfd3d6';

          return (
            <div key={`${s.strike}-${i}`}>
              <div
                className="grid grid-cols-[1fr_1.4fr] items-center px-3 py-[3px] text-[11px] tabular-nums"
                style={{
                  background: isSpot ? 'rgba(0,230,180,0.10)' : undefined,
                  borderLeft: isSpot
                    ? `2px solid ${COLOR_SPOT}`
                    : isKing
                      ? `2px solid ${COLOR_KING}`
                      : isQueen
                        ? `2px solid ${COLOR_QUEEN}`
                        : '2px solid transparent',
                }}
              >
                <span className="font-medium" style={{ color: strikeColor }}>
                  {prefix && <span className="mr-1">{prefix}</span>}
                  {fmtStrike(s.strike)}
                </span>
                <span
                  className="text-right px-1.5 py-[1px] rounded-sm flex items-center justify-end gap-1"
                  style={{ background: bg, color: fg }}
                >
                  {badge && (
                    <span
                      className="text-[9px] font-bold px-1 rounded-sm"
                      style={{
                        background: 'rgba(0,0,0,0.4)',
                        color: badge.color,
                      }}
                    >
                      {badge.label}
                    </span>
                  )}
                  <span className="font-semibold">{fmtGex(s.netGex)}</span>
                </span>
              </div>

              {/* Gamma-flip divider row inserted between the two crossing strikes */}
              {i === flipAfterIdx && (
                <div
                  className="flex items-center justify-center text-[10px] font-bold py-[2px]"
                  style={{
                    background: 'rgba(255,214,0,0.10)',
                    color: COLOR_GAMMA_FLIP,
                    borderTop: `1px dashed ${COLOR_GAMMA_FLIP}`,
                    borderBottom: `1px dashed ${COLOR_GAMMA_FLIP}`,
                  }}
                >
                  γ{fmtStrike(t.gammaFlip)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});

// -----------------------------------------------------------------------------
// Top-level component
// -----------------------------------------------------------------------------

export const GexRadar = memo(function GexRadar({
  tickers = DEFAULT_TICKERS,
  windowSize = 30,
  onDrillDown: parentDrillDown,
}: Props) {
  const { data, isLoading, isError, error } = useGexRadar(tickers, windowSize);
  const [internalDrill, setInternalDrill] = useState<string | null>(null);

  // If a parent supplies onDrillDown, defer to it (parent owns the sheet so
  // it can be shared with AlwaysOnFlagStrip). Otherwise fall back to the
  // internal Sheet so standalone usage still works.
  const usingParentSheet = !!parentDrillDown;
  const handleDrill = parentDrillDown ?? setInternalDrill;
  const isOpen = internalDrill !== null;

  return (
    <>
      <Card className="p-3 bg-black/60 border-white/10">
        <div className="flex items-baseline justify-between mb-2">
          <div>
            <h3 className="text-sm font-semibold tracking-wide">GEX Radar</h3>
            <p className="text-[10px] text-muted-foreground">
              Dealer gamma + OI velocity · {tickers.join(' · ')} · click a ticker for LinkGex deep
            </p>
          </div>
          <div className="flex items-center gap-2">
            {data?.generated_at && (
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {new Date(data.generated_at).toLocaleTimeString('en-US', { hour12: false })}
              </span>
            )}
            <FreshnessChip timestamp={data?.generated_at ?? null} />
          </div>
        </div>

        {isError && (
          <div className="text-xs text-red-400 px-2 py-3">
            radar fetch failed: {(error as Error)?.message ?? 'unknown'}
          </div>
        )}

        {isLoading && !data && (
          <div className="text-xs text-muted-foreground px-2 py-8 text-center">
            loading radar…
          </div>
        )}

        {data?.tickers && (
          <div className="flex flex-col md:flex-row gap-2">
            {data.tickers.map(t => (
              <TickerColumn
                key={t.ticker}
                t={t}
                onDrillDown={handleDrill}
              />
            ))}
          </div>
        )}
      </Card>

      {!usingParentSheet && (
        <Sheet open={isOpen} onOpenChange={(o) => { if (!o) setInternalDrill(null); }}>
          <SheetContent
            side="right"
            className="w-full sm:max-w-[860px] bg-black border-white/10 p-0 overflow-y-auto"
          >
            {internalDrill && (
              <LinkGexDeep ticker={internalDrill} enabled={isOpen} />
            )}
          </SheetContent>
        </Sheet>
      )}
    </>
  );
});
