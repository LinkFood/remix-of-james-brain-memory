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
import { memo } from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  useGexRadar,
  type GexComboVerdict,
  type GexRadarTicker,
} from '@/hooks/useGexRadar';

// James's TS palette — spec'd exactly.
const COLOR_URGENT = '#FF5252';
const COLOR_A_PLUS_BULLISH = '#00E676';
const COLOR_A_PLUS_BEARISH = '#FF5252';
const COLOR_SQUEEZE = '#d08030';
const COLOR_BATTLEGROUND = '#e8d840';

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
          <button
            type="button"
            onClick={() => onOpen(t.ticker)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold tabular-nums tracking-wide hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-white/30 transition-all shadow-sm"
            style={{ background: palette.bg, color: palette.fg }}
            aria-label={`${t.ticker} ${palette.label} — open deep view`}
          >
            <span>{t.ticker}</span>
            <span className="opacity-80">·</span>
            <span>{palette.label}</span>
          </button>
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
          <div className="text-[9px] text-white/40 mt-1">click for LinkGex deep</div>
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

  // If every ticker came back LEAN/NEUTRAL (or no data): show the muted pill.
  if (structural.length === 0) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-black/40 border border-white/5">
        <span className="text-[10px] uppercase tracking-wider text-white/40">Flags</span>
        <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-medium text-white/50 bg-white/5 border border-white/10">
          no structural signals — consolidation
        </span>
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
      </div>
    </div>
  );
});
