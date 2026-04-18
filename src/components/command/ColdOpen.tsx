/**
 * ColdOpen — "what matters right now?" digest, pinned to the absolute top
 * of CommandStation (above Claude's Read).
 *
 * Up to 5 compact bullets, each clickable:
 *   click → scrolls to relevant panel (via DOM id) OR opens the shared
 *           LinkGex Deep Sheet (via onOpenDeep prop, wired by CommandStation).
 *
 * If every data source is quiet, renders a single muted "tape is quiet"
 * bullet — so the block never collapses to empty. Small "last updated"
 * footnote confirms the card is live.
 *
 * Visuals: Card with border-l-4 in the top-priority bullet's color. Each
 * bullet starts with a colored dot matching its own severity.
 */
import { memo, useCallback } from 'react';
import { Card } from '@/components/ui/card';
import { FreshnessChip } from '@/components/FreshnessChip';
import { useColdOpen, type ColdOpenBullet, type ColdOpenSeverity } from '@/hooks/useColdOpen';

interface SeverityStyle {
  /** Left-border color on the card (applied when this severity is the top). */
  borderLeft: string;
  /** Dot color used next to each bullet. */
  dot: string;
  /** Text accent used for the bullet label/meta. */
  accent: string;
}

const SEVERITY_STYLES: Record<ColdOpenSeverity, SeverityStyle> = {
  red:     { borderLeft: 'border-l-red-500',     dot: 'bg-red-500',     accent: 'text-red-300' },
  orange:  { borderLeft: 'border-l-orange-500',  dot: 'bg-orange-500',  accent: 'text-orange-300' },
  amber:   { borderLeft: 'border-l-amber-500',   dot: 'bg-amber-500',   accent: 'text-amber-300' },
  emerald: { borderLeft: 'border-l-emerald-500', dot: 'bg-emerald-500', accent: 'text-emerald-300' },
  sky:     { borderLeft: 'border-l-sky-500',     dot: 'bg-sky-500',     accent: 'text-sky-300' },
  violet:  { borderLeft: 'border-l-violet-500',  dot: 'bg-violet-500',  accent: 'text-violet-300' },
  muted:   { borderLeft: 'border-l-muted',       dot: 'bg-muted-foreground/60', accent: 'text-muted-foreground' },
};

function scrollToId(id: string) {
  if (typeof document === 'undefined') return;
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function timeOfDay(iso: string | undefined | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch {
    return '—';
  }
}

interface BulletRowProps {
  b: ColdOpenBullet;
  onOpenDeep?: (ticker: string) => void;
}

const BulletRow = memo(function BulletRow({ b, onOpenDeep }: BulletRowProps) {
  const style = SEVERITY_STYLES[b.severity];
  const clickable = b.action.kind !== 'none';

  const handleClick = useCallback(() => {
    if (b.action.kind === 'scroll') scrollToId(b.action.targetId);
    else if (b.action.kind === 'openDeep') onOpenDeep?.(b.action.ticker);
  }, [b.action, onOpenDeep]);

  return (
    <button
      type="button"
      onClick={clickable ? handleClick : undefined}
      disabled={!clickable}
      className={[
        'w-full flex items-center gap-2.5 px-2 py-1.5 rounded text-left',
        clickable ? 'hover:bg-white/5 cursor-pointer' : 'cursor-default',
        'transition-colors',
      ].join(' ')}
    >
      <span className={`w-2 h-2 rounded-full shrink-0 ${style.dot}`} aria-hidden />
      <span className={`flex-1 min-w-0 text-sm leading-snug truncate ${b.severity === 'muted' ? 'text-muted-foreground' : 'text-foreground/95'}`}>
        {b.text}
      </span>
      {b.meta && (
        <span className={`text-[10px] uppercase tracking-wider font-mono shrink-0 ${style.accent}`}>
          {b.meta}
        </span>
      )}
    </button>
  );
});

interface ColdOpenProps {
  /** Wire to CommandStation's LinkGex Deep Sheet trigger. */
  onOpenDeep?: (ticker: string) => void;
}

export function ColdOpen({ onOpenDeep }: ColdOpenProps) {
  const { bullets, topSeverity, lastUpdated, isLoading } = useColdOpen();

  const borderLeft = SEVERITY_STYLES[topSeverity].borderLeft;

  return (
    <Card className={`border-l-4 ${borderLeft} py-2.5 px-3`}>
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground font-semibold">
          Cold Open · what matters right now
        </div>
        <div className="flex items-center gap-2">
          {isLoading && !lastUpdated && (
            <span className="text-[10px] text-muted-foreground">loading…</span>
          )}
          <FreshnessChip timestamp={lastUpdated ?? null} />
        </div>
      </div>
      <ul className="space-y-0.5">
        {bullets.map(b => (
          <li key={b.id}>
            <BulletRow b={b} onOpenDeep={onOpenDeep} />
          </li>
        ))}
      </ul>
      {lastUpdated && (
        <div className="mt-1.5 text-[10px] text-muted-foreground/70 text-right font-mono">
          last updated {timeOfDay(lastUpdated)}
        </div>
      )}
    </Card>
  );
}
