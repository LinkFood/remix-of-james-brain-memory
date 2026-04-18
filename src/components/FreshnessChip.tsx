/**
 * FreshnessChip — compact "last updated" indicator.
 *
 * Placement: top-right corner of a Co-Trader panel header. Small, unobtrusive,
 * color-coded by age. Tooltip shows exact ISO timestamp for precision.
 *
 * Live updates via the shared FreshnessClock context (1 Hz tick). If no
 * provider is mounted, the chip still renders but won't re-tick on its own.
 *
 * Defaults (thresholdsSec):
 *   - fresh  <= 60s   → green dot
 *   - aging  <= 300s  → amber dot
 *   - stale  >  300s  → red dot
 *   - null timestamp  → muted "—"
 *
 * Intentional: the chip is always memo'd and pure — only the `display` string
 * from useFreshness triggers DOM updates. At 30+ mounted chips this is the
 * difference between a smooth UI and a reflow storm.
 */
import { memo } from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  useFreshness,
  DEFAULT_THRESHOLDS,
  type FreshnessThresholds,
  type FreshnessTier,
} from '@/hooks/useFreshness';
import { cn } from '@/lib/utils';

interface FreshnessChipProps {
  timestamp: Date | string | number | null | undefined;
  /** Optional label prefix, e.g. "heartbeat". Renders as "heartbeat · 3s ago". */
  label?: string;
  /** Override the default tier thresholds (seconds). */
  thresholdsSec?: FreshnessThresholds;
  /** Extra classes for positioning inside a card header. */
  className?: string;
}

const TIER_DOT: Record<FreshnessTier, string> = {
  fresh:   'bg-green-500',
  aging:   'bg-amber-500',
  stale:   'bg-red-500',
  unknown: 'bg-muted-foreground/50',
};

const TIER_TEXT: Record<FreshnessTier, string> = {
  fresh:   'text-green-500/90',
  aging:   'text-amber-500/90',
  stale:   'text-red-500/90',
  unknown: 'text-muted-foreground',
};

function isoForTooltip(ts: Date | string | number | null | undefined): string {
  if (ts == null) return 'no timestamp';
  try {
    const d = ts instanceof Date ? ts : new Date(ts);
    if (!Number.isFinite(d.getTime())) return 'invalid timestamp';
    return d.toISOString();
  } catch {
    return 'invalid timestamp';
  }
}

export const FreshnessChip = memo(function FreshnessChip({
  timestamp,
  label,
  thresholdsSec = DEFAULT_THRESHOLDS,
  className,
}: FreshnessChipProps) {
  const { tier, display } = useFreshness(timestamp, thresholdsSec);

  const iso = isoForTooltip(timestamp);

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-mono tabular-nums leading-none select-none',
              'bg-black/20 border border-white/5',
              className,
            )}
            aria-label={`data age: ${display}`}
          >
            <span
              className={cn('inline-block h-1.5 w-1.5 rounded-full', TIER_DOT[tier])}
              aria-hidden
            />
            {label && (
              <span className="text-muted-foreground/70 uppercase tracking-wider">
                {label}
              </span>
            )}
            <span className={TIER_TEXT[tier]}>{display}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="bg-black/95 border-white/10 text-white text-[10px] font-mono">
          {iso}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
});
