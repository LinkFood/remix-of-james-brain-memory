/**
 * LinkGexDeep — single-ticker drill-down (port of James's TrendSpider
 * "LinkGex V3" indicator).
 *
 * Where <GexRadar /> renders a 3-ticker ladder (overview), this component is
 * the deep view for ONE ticker: the full 10-column matrix, header overlay
 * with bias/regime/levels, combo verdict, per-dimension verdicts, the five
 * directional scores, Δ OPEN, and totals.
 *
 * 10 columns:
 *   1 heat bar (▓▓▓ thermal ramp, length scaled by $FLOW + HEDGE magnitude)
 *   2 strike (▶ spot, ★ king, ♛ queen, activity dots)
 *   3 Net GEX
 *   4 $FLOW (dollar OIC)
 *   5 HEDGE (gamma OIC)
 *   6 NOW (DTE-weighted OIC)
 *   7 CALLS% velocity
 *   8 PUTS% velocity
 *   9 OI (call | put)
 *  10 0DTE gamma
 *
 * All aggregation, scoring, king/queen/flip/wall derivation happens in
 * ct-linkgex-deep. This file renders.
 */
import { memo, useMemo } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { RefreshCw } from 'lucide-react';
import { useLinkGexDeep, type LinkGexStrike } from '@/hooks/useLinkGexDeep';

// -----------------------------------------------------------------------------
// Colors — matched to GexRadar.tsx so drill-down feels like the same surface.
// -----------------------------------------------------------------------------
const COLOR_CALL = '#00C853';
const COLOR_PUT = '#FF1744';
const COLOR_SPOT = '#00E6B4';
const COLOR_KING = '#F5D78E';
const COLOR_QUEEN = '#EF9F27';
const COLOR_GAMMA_FLIP = '#FFD600';

// Heat-bar thermal ramp (per brief):
//   r > 0.60 → green
//   r > 0.35 → yellow
//   r > 0.15 → orange
//   else    → dim red/brown
function heatRamp(r: number): string {
  if (r > 0.60) return COLOR_CALL;
  if (r > 0.35) return '#FFD600';
  if (r > 0.15) return '#FF9800';
  return '#7a2b2b';
}

// -----------------------------------------------------------------------------
// Formatting
// -----------------------------------------------------------------------------

function fmtStrike(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  return Number.isInteger(n) ? n.toFixed(0) : n.toFixed(1);
}
function fmtSpot(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtBig(n: number): string {
  const sign = n >= 0 ? '+' : '-';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(0)}K`;
  if (abs < 1 && abs > 0) return `${sign}${abs.toFixed(2)}`;
  return `${sign}${abs.toFixed(0)}`;
}
function fmtOI(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return `${n.toFixed(0)}`;
}
function fmtPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '-';
  return `${sign}${Math.abs(n).toFixed(0)}%`;
}
function fmtScore(n: number): string {
  const sign = n >= 0 ? '+' : '';
  return `${sign}${Math.round(n)}`;
}

function scoreColor(n: number): string {
  if (n >= 40) return COLOR_CALL;
  if (n >= 15) return '#66bb6a';
  if (n > -15) return '#9e9e9e';
  if (n > -40) return '#ef5350';
  return COLOR_PUT;
}

// -----------------------------------------------------------------------------
// Heat bar — ▓ character count scaled to (dollarOIC + |gammaOIC|) magnitude.
// Max width = 8 blocks.
// -----------------------------------------------------------------------------
const MAX_HEAT_BLOCKS = 8;

function heatBar(
  dollarMag: number,
  gammaMag: number,
  maxDollar: number,
  maxGamma: number,
  direction: number,
): { label: string; color: string } {
  const dr = maxDollar > 0 ? dollarMag / maxDollar : 0;
  const gr = maxGamma > 0 ? gammaMag / maxGamma : 0;
  const r = (dr + gr) / 2;
  const count = Math.max(0, Math.min(MAX_HEAT_BLOCKS, Math.round(r * MAX_HEAT_BLOCKS)));
  const blocks = '▓'.repeat(count) + '░'.repeat(MAX_HEAT_BLOCKS - count);
  // Direction shades — bullish net → green-ish ramp, bearish → red.
  const color = direction >= 0 ? heatRamp(r) : '#FF1744';
  return { label: blocks, color };
}

// -----------------------------------------------------------------------------
// Score pill
// -----------------------------------------------------------------------------

function ScorePill({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  const color = tone ?? (typeof value === 'number' ? scoreColor(value) : '#9e9e9e');
  return (
    <div className="flex flex-col items-center px-2 py-1 rounded-md border border-white/10 bg-black/40 min-w-[64px]">
      <span className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="text-sm font-bold tabular-nums" style={{ color }}>
        {typeof value === 'number' ? fmtScore(value) : value}
      </span>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Verdict badge
// -----------------------------------------------------------------------------

function verdictColor(v: string): string {
  if (v.startsWith('EXTREME')) return v.endsWith('▲') ? COLOR_CALL : COLOR_PUT;
  if (v.startsWith('STRONG'))  return v.endsWith('▲') ? '#66bb6a' : '#ef5350';
  if (v.startsWith('ELEVATED')) return '#ffb74d';
  if (v === 'FRENZY' || v === 'BUILDING') return '#ab47bc';
  if (v === 'ACTIVE' || v === 'STIRRING') return '#9575cd';
  return '#9e9e9e';
}

function VerdictBadge({ label, verdict }: { label: string; verdict: string }) {
  return (
    <div className="flex items-center gap-1 text-[10px]">
      <span className="text-muted-foreground uppercase tracking-wider">{label}</span>
      <span className="font-bold tabular-nums" style={{ color: verdictColor(verdict) }}>
        {verdict}
      </span>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Activity dots ●●●
// -----------------------------------------------------------------------------
function dotsStr(n: number): string {
  return '●'.repeat(n);
}

// -----------------------------------------------------------------------------
// Main component
// -----------------------------------------------------------------------------

interface Props {
  ticker: string;
  /** Gate polling — pass false when off-screen. Default true. */
  enabled?: boolean;
  maxDte?: number;
  strikeWindow?: number;
}

export const LinkGexDeep = memo(function LinkGexDeep({
  ticker,
  enabled = true,
  maxDte = 30,
  strikeWindow = 30,
}: Props) {
  const { data, isLoading, isError, error, refetch, isFetching } = useLinkGexDeep({
    ticker,
    maxDte,
    strikeWindow,
    enabled,
  });

  // Scale baselines for heat-bar magnitude.
  const { maxDollarStrike, maxGammaStrike } = useMemo(() => {
    if (!data) return { maxDollarStrike: 0, maxGammaStrike: 0 };
    let d = 0; let g = 0;
    for (const s of data.strikes) {
      if (s.dollarOIC > d) d = s.dollarOIC;
      const ag = Math.abs(s.gammaOIC);
      if (ag > g) g = ag;
    }
    return { maxDollarStrike: d, maxGammaStrike: g };
  }, [data]);

  const regimeColor = data?.regime === 'pos' ? COLOR_CALL : data?.regime === 'neg' ? COLOR_PUT : '#888';
  const regimeLabel = data?.regime === 'pos' ? 'POS γ' : data?.regime === 'neg' ? 'NEG γ' : 'γ·';
  const biasLabel   = data ? (data.cPct >= data.pPct ? 'CALL DOMINANT' : 'PUT DOMINANT') : '';
  const biasColor   = data ? (data.cPct >= data.pPct ? COLOR_CALL : COLOR_PUT) : '#888';

  return (
    <Card className="bg-black/60 border-white/10 overflow-hidden">
      {/* Header overlay */}
      <div className="px-3 py-2 border-b border-white/10">
        <div className="flex items-baseline justify-between mb-1">
          <div className="flex items-baseline gap-3">
            <h3 className="text-xs font-bold tracking-[0.2em] text-muted-foreground">LINKGEX V3</h3>
            <div className="text-lg font-bold">{ticker}</div>
            <div className="text-lg font-bold tabular-nums" style={{ color: COLOR_SPOT }}>
              {fmtSpot(data?.spot ?? null)}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {data?.generated_at && (
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {new Date(data.generated_at).toLocaleTimeString('en-US', { hour12: false })}
              </span>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0"
              onClick={() => refetch()}
              disabled={isFetching}
              title="Refresh"
            >
              <RefreshCw className={`h-3 w-3 ${isFetching ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>

        {/* Bias + regime + flow bar */}
        <div className="flex items-center gap-3 text-[10px]">
          <span className="font-bold" style={{ color: biasColor }}>
            {biasLabel || '—'}
          </span>
          <span className="font-bold" style={{ color: regimeColor }}>
            {regimeLabel}
          </span>
          {/* Flow bar: green portion = call OI share, red portion = put OI share */}
          <div className="flex-1 h-[8px] rounded-sm overflow-hidden flex border border-white/10">
            <div
              style={{ width: `${data?.cPct ?? 50}%`, background: COLOR_CALL }}
              className="h-full"
            />
            <div
              style={{ width: `${data?.pPct ?? 50}%`, background: COLOR_PUT }}
              className="h-full"
            />
          </div>
          <span className="tabular-nums text-muted-foreground">
            <span style={{ color: COLOR_CALL }}>{(data?.cPct ?? 50).toFixed(0)}%C</span>
            {' / '}
            <span style={{ color: COLOR_PUT }}>{(data?.pPct ?? 50).toFixed(0)}%P</span>
          </span>
        </div>

        {/* Levels sub-header */}
        <div className="flex items-center justify-between mt-1.5 text-[10px] tabular-nums">
          <span style={{ color: COLOR_KING }}>★K {fmtStrike(data?.king ?? null)}</span>
          <span style={{ color: COLOR_QUEEN }}>♛Q {fmtStrike(data?.queen ?? null)}</span>
          <span style={{ color: COLOR_GAMMA_FLIP }}>γ {fmtStrike(data?.gammaFlip ?? null)}</span>
          <span style={{ color: COLOR_CALL }}>CW {fmtStrike(data?.callWall ?? null)}</span>
          <span style={{ color: COLOR_PUT }}>PW {fmtStrike(data?.putWall ?? null)}</span>
        </div>
      </div>

      {/* Verdict row */}
      {data && (
        <div className="px-3 py-2 border-b border-white/10 flex items-center justify-between gap-3 flex-wrap">
          <div
            className="text-lg font-black tracking-wider tabular-nums"
            style={{ color: data.verdicts.comboColor }}
          >
            {data.verdicts.comboLabel.toUpperCase()}
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <VerdictBadge label="$FLOW" verdict={data.verdicts.$flow} />
            <VerdictBadge label="HEDGE" verdict={data.verdicts.gamma} />
            <VerdictBadge label="NOW" verdict={data.verdicts.dte} />
            <VerdictBadge label="CALLS" verdict={data.verdicts.cVel} />
            <VerdictBadge label="PUTS" verdict={data.verdicts.pVel} />
          </div>
        </div>
      )}

      {/* Totals row */}
      {data && (
        <div className="px-3 py-1 border-b border-white/10 grid grid-cols-5 gap-2 text-[10px] tabular-nums">
          <span>
            <span className="text-muted-foreground">$FLOW</span>{' '}
            <span style={{ color: scoreColor(data.totals.dollar >= 0 ? 1 : -1) }}>
              {fmtBig(data.totals.dollar)}
            </span>
          </span>
          <span>
            <span className="text-muted-foreground">HEDGE</span>{' '}
            <span style={{ color: scoreColor(data.totals.gamma) }}>
              {fmtBig(data.totals.gamma)}
            </span>
          </span>
          <span>
            <span className="text-muted-foreground">NOW</span>{' '}
            <span style={{ color: scoreColor(data.totals.dte) }}>
              {fmtBig(data.totals.dte)}
            </span>
          </span>
          <span>
            <span className="text-muted-foreground">avgC</span>{' '}
            <span style={{ color: COLOR_CALL }}>{data.totals.avgCVel.toFixed(1)}%</span>
          </span>
          <span>
            <span className="text-muted-foreground">avgP</span>{' '}
            <span style={{ color: COLOR_PUT }}>{data.totals.avgPVel.toFixed(1)}%</span>
          </span>
        </div>
      )}

      {/* States */}
      {isError && (
        <div className="text-xs text-red-400 px-3 py-3">
          linkgex fetch failed: {(error as Error)?.message ?? 'unknown'}
        </div>
      )}
      {isLoading && !data && (
        <div className="text-xs text-muted-foreground px-3 py-8 text-center">
          loading linkgex…
        </div>
      )}

      {/* Matrix */}
      {data && data.strikes.length > 0 && (
        <div className="max-h-[80vh] overflow-auto">
          {/* Table header */}
          <div
            className="grid px-3 py-1 text-[9px] uppercase tracking-wider text-muted-foreground border-b border-white/10 bg-black/60 sticky top-0"
            style={{ gridTemplateColumns: '70px 90px 80px 80px 80px 80px 60px 60px 100px 70px' }}
          >
            <span>heat</span>
            <span>strike</span>
            <span className="text-right">Net GEX</span>
            <span className="text-right">$FLOW</span>
            <span className="text-right">HEDGE</span>
            <span className="text-right">NOW</span>
            <span className="text-right">C%</span>
            <span className="text-right">P%</span>
            <span className="text-right">OI C|P</span>
            <span className="text-right">0DTE</span>
          </div>

          <div className="divide-y divide-white/5">
            {data.strikes.map((s, i) => (
              <MatrixRow
                key={`${s.strike}-${i}`}
                s={s}
                maxDollar={maxDollarStrike}
                maxGamma={maxGammaStrike}
              />
            ))}
          </div>
        </div>
      )}

      {/* Scores footer */}
      {data && (
        <div className="px-3 py-2 border-t border-white/10 flex items-center gap-2 flex-wrap">
          <ScorePill label="$FLOW" value={data.scores.flow} />
          <ScorePill label="HEDGE" value={data.scores.hedge} />
          <ScorePill
            label="NOW"
            value={data.verdicts.dte.startsWith('EXTREME') ? 'URGENT' : fmtScore(data.scores.now)}
            tone={data.verdicts.dte.startsWith('EXTREME') ? '#ff2d2d' : undefined}
          />
          <ScorePill label="CALLS" value={data.scores.calls} />
          <ScorePill label="PUTS" value={data.scores.puts} />
          <div className="flex-1" />
          <div className="text-[10px] tabular-nums">
            <span className="text-muted-foreground uppercase tracking-wider">Δ OPEN </span>
            <span style={{ color: data.deltaOpen >= 0 ? COLOR_CALL : COLOR_PUT }}>
              {fmtBig(data.deltaOpen)}
            </span>
          </div>
        </div>
      )}
    </Card>
  );
});

// -----------------------------------------------------------------------------
// Matrix row
// -----------------------------------------------------------------------------

interface RowProps {
  s: LinkGexStrike;
  maxDollar: number;
  maxGamma: number;
}

const MatrixRow = memo(function MatrixRow({ s, maxDollar, maxGamma }: RowProps) {
  const heat = heatBar(s.dollarOIC, Math.abs(s.gammaOIC), maxDollar, maxGamma, s.dollarNetOIC);

  // Strike prefix marker
  let prefix = '';
  if (s.isSpot) prefix = '▶';
  else if (s.isKing) prefix = '★';
  else if (s.isQueen) prefix = '♛';

  const strikeColor = s.isSpot
    ? COLOR_SPOT
    : s.isKing
      ? COLOR_KING
      : s.isQueen
        ? COLOR_QUEEN
        : s.isCallWall
          ? COLOR_CALL
          : s.isPutWall
            ? COLOR_PUT
            : '#cfd3d6';

  // Net GEX color by sign
  const netColor = s.netGex >= 0 ? COLOR_CALL : COLOR_PUT;

  // $FLOW tint by signed net direction
  const dollarColor = s.dollarNetOIC >= 0 ? COLOR_CALL : COLOR_PUT;
  // HEDGE tint by gamma sign
  const hedgeColor = s.gammaOIC >= 0 ? COLOR_CALL : COLOR_PUT;
  // NOW tint by signed direction
  const nowColor = s.dteNetOIC >= 0 ? COLOR_CALL : COLOR_PUT;

  return (
    <div
      className="grid items-center px-3 py-[3px] text-[11px] tabular-nums"
      style={{
        gridTemplateColumns: '70px 90px 80px 80px 80px 80px 60px 60px 100px 70px',
        background: s.isSpot ? 'rgba(0,230,180,0.10)' : undefined,
        borderLeft: s.isSpot
          ? `2px solid ${COLOR_SPOT}`
          : s.isKing
            ? `2px solid ${COLOR_KING}`
            : s.isQueen
              ? `2px solid ${COLOR_QUEEN}`
              : '2px solid transparent',
      }}
    >
      {/* 1. heat bar */}
      <span className="font-mono text-[10px]" style={{ color: heat.color }}>
        {heat.label}
      </span>

      {/* 2. strike (with marker + activity dots) */}
      <span className="font-medium flex items-center gap-1" style={{ color: strikeColor }}>
        {prefix && <span>{prefix}</span>}
        <span>{fmtStrike(s.strike)}</span>
        {s.activityDots > 0 && (
          <span className="text-[8px] opacity-70">{dotsStr(s.activityDots)}</span>
        )}
      </span>

      {/* 3. Net GEX */}
      <span className="text-right font-semibold" style={{ color: netColor }}>
        {fmtBig(s.netGex)}
      </span>

      {/* 4. $FLOW (net) */}
      <span className="text-right" style={{ color: dollarColor }}>
        {s.dollarNetOIC === 0 ? '—' : fmtBig(s.dollarNetOIC)}
      </span>

      {/* 5. HEDGE (gamma OIC) */}
      <span className="text-right" style={{ color: hedgeColor }}>
        {s.gammaOIC === 0 ? '—' : fmtBig(s.gammaOIC)}
      </span>

      {/* 6. NOW (dte-weighted net OIC) */}
      <span className="text-right" style={{ color: nowColor }}>
        {s.dteNetOIC === 0 ? '—' : fmtBig(s.dteNetOIC)}
      </span>

      {/* 7. CALLS% */}
      <span
        className="text-right"
        style={{
          color: s.cVelPct === null ? '#555' : (s.cVelPct >= 0 ? COLOR_CALL : COLOR_PUT),
        }}
      >
        {fmtPct(s.cVelPct)}
      </span>

      {/* 8. PUTS% */}
      <span
        className="text-right"
        style={{
          color: s.pVelPct === null ? '#555' : (s.pVelPct >= 0 ? COLOR_PUT : COLOR_CALL),
        }}
      >
        {fmtPct(s.pVelPct)}
      </span>

      {/* 9. OI C|P */}
      <span className="text-right">
        <span style={{ color: COLOR_CALL }}>{fmtOI(s.cOI)}</span>
        <span className="text-muted-foreground mx-0.5">|</span>
        <span style={{ color: COLOR_PUT }}>{fmtOI(s.pOI)}</span>
      </span>

      {/* 10. 0DTE */}
      <span
        className="text-right"
        style={{ color: s.zeroDteGex === 0 ? '#555' : (s.zeroDteGex >= 0 ? COLOR_CALL : COLOR_PUT) }}
      >
        {s.zeroDteGex === 0 ? '—' : fmtBig(s.zeroDteGex)}
      </span>
    </div>
  );
});
