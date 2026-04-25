/**
 * AlarmBanner — horizontal pill strip above the /tape table showing the 3 most
 * recent ct-signature-watcher alarms (last 5 minutes). Auto-hides when nothing
 * has fired recently.
 *
 * Each pill:
 *   - tier emoji (🥇 / 🥈 / 🥉)
 *   - {ticker} {side} ${strike}
 *   - click → smooth-scroll to the matching row on /tape (lookup by
 *     data-option-symbol attribute) and highlight briefly
 *
 * Symbol parsing handles OCC-style option symbols (e.g. QQQ260501C00660000).
 * Side + strike are best-effort — if parsing fails we just show the symbol.
 */

import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { useAlarmRealtime, type ActiveAlarm, type AlarmTier } from '@/hooks/useAlarmRealtime';

const BANNER_WINDOW_MS = 5 * 60_000;
const MAX_PILLS = 3;

const TIER_EMOJI: Record<AlarmTier, string> = {
  gold: '🥇',
  silver: '🥈',
  bronze: '🥉',
  unknown: '⚡',
};

const TIER_PILL_CLASS: Record<AlarmTier, string> = {
  gold: 'border-emerald-400/60 bg-emerald-500/15 text-emerald-100 hover:bg-emerald-500/25',
  silver: 'border-emerald-400/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20',
  bronze: 'border-emerald-400/25 bg-emerald-500/[0.06] text-emerald-300 hover:bg-emerald-500/15',
  unknown: 'border-muted bg-muted/20 text-muted-foreground hover:bg-muted/30',
};

interface ParsedOption {
  side: 'C' | 'P' | null;
  strike: number | null;
}

/**
 * Parse the side + strike out of an OCC option symbol like
 * "QQQ260501C00660000" → { side: 'C', strike: 660 }. The strike is a 1000ths
 * of a dollar field (8 chars). Returns nulls if shape doesn't match.
 */
function parseOptionSymbol(sym: string): ParsedOption {
  const m = sym.match(/[CP]\d{8}$/);
  if (!m) return { side: null, strike: null };
  const tail = m[0];
  const side = tail[0] as 'C' | 'P';
  const strikeRaw = Number(tail.slice(1));
  if (!Number.isFinite(strikeRaw)) return { side, strike: null };
  return { side, strike: strikeRaw / 1000 };
}

function pillLabel(a: ActiveAlarm): string {
  const { side, strike } = parseOptionSymbol(a.optionSymbol);
  const t = a.ticker || a.optionSymbol.slice(0, 4);
  if (side && strike != null) {
    const sideLabel = side === 'C' ? 'C' : 'P';
    return `${t} ${sideLabel} $${strike}`;
  }
  return t || a.optionSymbol;
}

function scrollToSymbol(sym: string) {
  const el = document.querySelector<HTMLElement>(`[data-option-symbol="${sym}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

export function AlarmBanner() {
  const { recentAlarms } = useAlarmRealtime();

  // Filter to last 5 min, keep most recent first, cap at MAX_PILLS.
  // Recompute each render — recentAlarms changes on insert + 1Hz tick.
  const visible = useMemo(() => {
    const now = Date.now();
    return recentAlarms
      .filter((a) => now - Date.parse(a.firedAt) <= BANNER_WINDOW_MS)
      .slice(0, MAX_PILLS);
  }, [recentAlarms]);

  if (visible.length === 0) return null;

  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded border border-emerald-500/25 bg-emerald-500/[0.04]">
      <span className="text-[10px] font-mono uppercase tracking-wider text-emerald-300/80 shrink-0">
        Alarms
      </span>
      <div className="flex items-center gap-1.5 flex-wrap">
        {visible.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => scrollToSymbol(a.optionSymbol)}
            title={a.thesis ?? `${a.tier} alarm — ${a.optionSymbol}`}
            className={cn(
              'inline-flex items-center gap-1.5 px-2 py-0.5 rounded border text-[11px] font-mono transition-colors',
              TIER_PILL_CLASS[a.tier],
            )}
          >
            <span className="leading-none">{TIER_EMOJI[a.tier]}</span>
            <span>{pillLabel(a)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
