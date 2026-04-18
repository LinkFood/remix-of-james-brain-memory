/**
 * AlwaysOnFlagStrip — horizontal pill strip of per-ticker combo verdicts.
 *
 * Surfaces URGENT / A+ / SQUEEZE / BATTLEGROUND signals REGARDLESS of any
 * downstream filter state — these are James's always-on flag patterns,
 * computed in ct-gex-radar (same shared LinkGex V3 scorer that
 * ct-linkgex-deep uses) and lifted into the command-station header row.
 *
 * Behavior:
 *   - One pill per ticker whose verdict is NOT LEAN/NEUTRAL.
 *   - If all tickers are LEAN/NEUTRAL → single muted "no structural signals —
 *     consolidation" pill.
 *   - Hover pill → tooltip with the 5 directional scores + totals.
 *   - Click pill → opens the LinkGexDeep sheet for that ticker (parent owns
 *     the sheet state so GexRadar + this strip share one drill-down surface).
 *
 * No new UW calls — consumes useGexRadar which already fetches
 * option-contracts + spot-exposures for SPY/QQQ/IWM.
 */
import { memo, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { FreshnessChip } from '@/components/FreshnessChip';
import {
  useGexRadar,
  type GexComboVerdict,
  type GexRadarTicker,
} from '@/hooks/useGexRadar';
import { useRegimeInversions, useIvShifts, type RegimeInversion, type IvShift } from '@/hooks/useCoTraderData';

// James's TS palette — spec'd exactly.
const COLOR_URGENT = '#FF5252';
const COLOR_A_PLUS_BULLISH = '#00E676';
const COLOR_A_PLUS_BEARISH = '#FF5252';
const COLOR_SQUEEZE = '#d08030';
const COLOR_BATTLEGROUND = '#e8d840';
const COLOR_GAMMA_FLIP = '#FFD600';  // classic warning yellow — regime inversion
const COLOR_IV_UP      = '#00BCD4';  // cyan — vol rank rising day-over-day
const COLOR_IV_DOWN    = '#8B5CF6';  // purple — vol rank falling day-over-day

/** Pick James's exact TS palette for the combo; null = not a structural signal. */
function paletteFor(combo: GexComboVerdict): { bg: string; fg: string; label: string } | null {
  switch (combo) {
    case 'URGENT':
      return { bg: COLOR_URGENT, fg: '#000', label: 'URGENT' };
    case 'A+ BULLISH':
      return { bg: COLOR_A_PLUS_BULLISH, fg: '#000', label: 'A+ BULLISH' };
    case 'A+ BEARISH':
      return { bg: COLOR_A_PLUS_BEARISH, fg: '#000', label: 'A+ BEARISH' };
    case 'SQUEEZE SETUP':
      return { bg: COLOR_SQUEEZE, fg: '#000', label: 'SQUEEZE' };
    case 'BATTLEGROUND':
      return { bg: COLOR_BATTLEGROUND, fg: '#000', label: 'BATTLEGROUND' };
    // LEAN BULLISH / LEAN BEARISH / NEUTRAL → not a structural signal
    default:
      return null;
  }
}

function fmtScore(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '-';
  return `${sign}${Math.abs(n).toFixed(0)}`;
}

function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${n.toFixed(1)}%`;
}

interface PillProps {
  t: GexRadarTicker;
  onOpen: (ticker: string) => void;
}

const FlagPill = memo(function FlagPill({ t, onOpen }: PillProps) {
  if (!t.verdicts) return null;
  const palette = paletteFor(t.verdicts.combo);
  if (!palette) return null;

  const s = t.scores;

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* Split pill: ticker slug → /ticker/:symbol (full terminal);
              verdict slug → shared LinkGexDeep sheet (preserved drill-down). */}
          <span
            className="inline-flex items-center rounded-full text-[11px] font-bold tabular-nums tracking-wide shadow-sm overflow-hidden"
            style={{ background: palette.bg, color: palette.fg }}
          >
            <Link
              to={`/ticker/${t.ticker}`}
              className="pl-2.5 pr-1.5 py-1 hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-white/30 transition-all"
              style={{ color: palette.fg }}
              aria-label={`${t.ticker} — open ticker terminal`}
              onClick={(e) => e.stopPropagation()}
            >
              {t.ticker}
            </Link>
            <span className="opacity-60 px-0.5">·</span>
            <button
              type="button"
              onClick={() => onOpen(t.ticker)}
              className="pl-1.5 pr-2.5 py-1 hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-white/30 transition-all"
              style={{ color: palette.fg }}
              aria-label={`${t.ticker} ${palette.label} — open LinkGex deep sheet`}
            >
              {palette.label}
            </button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="bg-black/95 border-white/10 text-white px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-white/60 mb-1">
            {t.ticker} scores
          </div>
          <div className="grid grid-cols-5 gap-2 text-[11px] tabular-nums">
            <div className="text-center">
              <div className="text-white/50 text-[9px]">$FLOW</div>
              <div>{fmtScore(s?.flow)}</div>
            </div>
            <div className="text-center">
              <div className="text-white/50 text-[9px]">HEDGE</div>
              <div>{fmtScore(s?.hedge)}</div>
            </div>
            <div className="text-center">
              <div className="text-white/50 text-[9px]">NOW</div>
              <div>{fmtScore(s?.now)}</div>
            </div>
            <div className="text-center">
              <div className="text-white/50 text-[9px]">CALLS</div>
              <div>{fmtScore(s?.calls)}</div>
            </div>
            <div className="text-center">
              <div className="text-white/50 text-[9px]">PUTS</div>
              <div>{fmtScore(s?.puts)}</div>
            </div>
          </div>
          <div className="mt-1.5 pt-1.5 border-t border-white/10 flex justify-between text-[10px] text-white/70">
            <span>cVel {fmtPct(t.verdicts.cVel)}</span>
            <span>pVel {fmtPct(t.verdicts.pVel)}</span>
          </div>
          <div className="text-[9px] text-white/40 mt-1">
            ticker → full terminal · verdict → LinkGex deep sheet
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
});

interface RegimePillProps {
  flip: RegimeInversion;
  onOpen: (ticker: string) => void;
}

/**
 * γ-FLIP pill — session-scale structural regime inversion (dealers long→short
 * gamma or vice versa). Click opens LinkGexDeep; SPX routes to SPY because
 * LinkGex covers ETFs, not the cash index.
 */
const RegimeFlipPill = memo(function RegimeFlipPill({ flip, onOpen }: RegimePillProps) {
  const dir = `${flip.prev_regime.toUpperCase().slice(0, 3)}→${flip.new_regime.toUpperCase().slice(0, 3)}`;
  const lvl = flip.flip_level !== null ? `@${flip.flip_level.toFixed(0)}` : '';
  const label = `${flip.ticker} γ-FLIP ${dir}${lvl ? ' ' + lvl : ''}`;
  const deepTicker = flip.ticker === 'SPX' ? 'SPY' : flip.ticker;
  const vibe = flip.new_regime === 'negative'
    ? 'dealers now short gamma — expect amplified moves / trending'
    : 'dealers now long gamma — expect damped vol / pinning';

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* Split pill: ticker → full terminal, body → LinkGex deep sheet. */}
          <span
            className="inline-flex items-center rounded-full text-[11px] font-bold tabular-nums tracking-wide shadow-sm overflow-hidden"
            style={{ background: COLOR_GAMMA_FLIP, color: '#000' }}
          >
            <Link
              to={`/ticker/${deepTicker}`}
              className="pl-2.5 pr-1.5 py-1 hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-white/30 transition-all"
              style={{ color: '#000' }}
              aria-label={`${flip.ticker} — open ticker terminal`}
              onClick={(e) => e.stopPropagation()}
            >
              {flip.ticker}
            </Link>
            <span className="opacity-60 px-0.5">·</span>
            <button
              type="button"
              onClick={() => onOpen(deepTicker)}
              className="pl-1.5 pr-2.5 py-1 hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-white/30 transition-all"
              style={{ color: '#000' }}
              aria-label={`${label} — open LinkGex deep sheet`}
            >
              γ-FLIP {dir}{lvl ? ' ' + lvl : ''}
            </button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="bg-black/95 border-white/10 text-white px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-white/60 mb-1">
            regime inversion
          </div>
          <div className="text-[11px] mb-1">{vibe}</div>
          <div className="text-[10px] text-white/60 flex gap-3 tabular-nums">
            {flip.spot_at_flip !== null && <span>spot {flip.spot_at_flip.toFixed(2)}</span>}
            {flip.flip_level !== null && <span>flip {flip.flip_level.toFixed(0)}</span>}
          </div>
          <div className="text-[9px] text-white/40 mt-1">
            ticker → full terminal · body → LinkGex deep sheet
            {flip.ticker === 'SPX' ? ' (SPY proxy)' : ''}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
});

interface IvShiftPillProps {
  shift: IvShift;
  onOpen: (ticker: string) => void;
}

/**
 * IV SHIFT pill — day-over-day IV rank move (vol regime shift, daily cadence).
 * Written by ct-iv-shift-watch at 21:05 UTC weekdays off ct_iv_rank_daily.
 * Cyan = rank rising, purple = rank falling. Click opens LinkGex Deep Sheet.
 */
const IvShiftPill = memo(function IvShiftPill({ shift, onOpen }: IvShiftPillProps) {
  const isUp = shift.direction === 'up';
  const bg = isUp ? COLOR_IV_UP : COLOR_IV_DOWN;
  const deltaSign = shift.delta >= 0 ? '+' : '';
  const deltaStr = `${deltaSign}${shift.delta.toFixed(0)}`;
  const prevStr = shift.prev_rank !== null ? shift.prev_rank.toFixed(0) : '—';
  const newStr  = shift.new_rank  !== null ? shift.new_rank.toFixed(0)  : '—';
  const label = `${shift.ticker} IV ${deltaStr} (${prevStr}→${newStr})`;
  const vibe = isUp
    ? 'IV rank rising — options richer, vol regime expanding'
    : 'IV rank falling — options cheaper, vol regime compressing';

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* Split pill: ticker → full terminal, body → LinkGex deep sheet. */}
          <span
            className="inline-flex items-center rounded-full text-[11px] font-bold tabular-nums tracking-wide shadow-sm overflow-hidden"
            style={{ background: bg, color: '#000' }}
          >
            <Link
              to={`/ticker/${shift.ticker}`}
              className="pl-2.5 pr-1.5 py-1 hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-white/30 transition-all"
              style={{ color: '#000' }}
              aria-label={`${shift.ticker} — open ticker terminal`}
              onClick={(e) => e.stopPropagation()}
            >
              {shift.ticker}
            </Link>
            <span className="opacity-60 px-0.5">·</span>
            <button
              type="button"
              onClick={() => onOpen(shift.ticker)}
              className="pl-1.5 pr-2.5 py-1 hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-white/30 transition-all"
              style={{ color: '#000' }}
              aria-label={`${label} — open LinkGex deep sheet`}
            >
              IV {deltaStr} ({prevStr}→{newStr})
            </button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="bg-black/95 border-white/10 text-white px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-white/60 mb-1">
            IV rank shift · day-over-day
          </div>
          <div className="text-[11px] mb-1">{vibe}</div>
          <div className="text-[10px] text-white/60 flex gap-3 tabular-nums">
            <span>ref {shift.ref_day}</span>
            <span>att {shift.attention_score}</span>
          </div>
          <div className="text-[9px] text-white/40 mt-1">
            ticker → full terminal · body → LinkGex deep sheet
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
});

interface Props {
  tickers?: string[];
  /** Parent-owned drill-down opener; the strip and GexRadar share the same sheet. */
  onOpenDeep: (ticker: string) => void;
}

const DEFAULT_TICKERS = ['SPY', 'QQQ', 'IWM'];

export const AlwaysOnFlagStrip = memo(function AlwaysOnFlagStrip({
  tickers = DEFAULT_TICKERS,
  onOpenDeep,
}: Props) {
  const { data, isLoading } = useGexRadar(tickers);
  // Regime flips in the last 60 min — always-on structural inversions.
  // Queried independently of GexRadar so they show even on partial UW failure.
  const { data: flips = [] } = useRegimeInversions(5, 60);
  // Day-over-day IV rank shifts — daily-cadence vol regime moves written
  // by ct-iv-shift-watch right after ct-eod-positioning lands at 21:00 UTC.
  // 48h window keeps yesterday's shift visible through the next session.
  const { data: ivShifts = [] } = useIvShifts(5, 48);

  if (isLoading && !data) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-black/40 border border-white/5 text-[10px] text-muted-foreground">
        scanning structural signals…
      </div>
    );
  }

  // Gracefully handle partial failures — skip tickers with no verdict or errors
  // (e.g. UW timeout on one ticker), render the working ones.
  const all = data?.tickers ?? [];
  const structural = all.filter(t => {
    if (!t.verdicts) return false;
    const p = paletteFor(t.verdicts.combo);
    return p !== null;
  });

  const hasStructural = structural.length > 0;
  const hasFlips = flips.length > 0;
  const hasIvShifts = ivShifts.length > 0;

  // Freshness anchor: max of the three feeds' most-recent event timestamps.
  // Multi-source panel — show the most recent event rather than the oldest,
  // since "the strip is live if ANY signal updated recently".
  const latestTs = useMemo(() => {
    const candidates: number[] = [];
    if (data?.generated_at) {
      const t = Date.parse(data.generated_at);
      if (Number.isFinite(t)) candidates.push(t);
    }
    for (const f of flips) {
      const t = Date.parse(f.created_at);
      if (Number.isFinite(t)) candidates.push(t);
    }
    for (const s of ivShifts) {
      const t = Date.parse(s.created_at);
      if (Number.isFinite(t)) candidates.push(t);
    }
    if (candidates.length === 0) return null;
    return new Date(Math.max(...candidates)).toISOString();
  }, [data?.generated_at, flips, ivShifts]);

  // If every ticker came back LEAN/NEUTRAL AND there are no regime flips
  // AND no IV shifts: show the muted pill.
  if (!hasStructural && !hasFlips && !hasIvShifts) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-black/40 border border-white/5">
        <span className="text-[10px] uppercase tracking-wider text-white/40">Flags</span>
        <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-medium text-white/50 bg-white/5 border border-white/10">
          no structural signals — consolidation
        </span>
        <FreshnessChip timestamp={latestTs} className="ml-auto" />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-black/40 border border-white/5 overflow-x-auto">
      <span className="text-[10px] uppercase tracking-wider text-white/40 shrink-0">Flags</span>
      <div className="flex items-center gap-2 flex-nowrap">
        {structural.map(t => (
          <FlagPill key={t.ticker} t={t} onOpen={onOpenDeep} />
        ))}
        {flips.map(f => (
          <RegimeFlipPill key={f.id} flip={f} onOpen={onOpenDeep} />
        ))}
        {ivShifts.map(s => (
          <IvShiftPill key={s.id} shift={s} onOpen={onOpenDeep} />
        ))}
      </div>
      <FreshnessChip timestamp={latestTs} className="ml-auto shrink-0" />
    </div>
  );
});
