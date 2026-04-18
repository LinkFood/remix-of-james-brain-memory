/**
 * SessionBadge — tiny "Fri Apr 17 (market closed)" pill shown on chart
 * headers when the effective session date is not today. Keeps the charts
 * honest: the numbers you're looking at are Friday's, not "right now."
 *
 * Renders nothing when session is live — by design, the live case should
 * look identical to the pre-fallback UI.
 */
import { useEffectiveSessionDate, formatClosedSessionLabel } from '@/hooks/useEffectiveSessionDate';

interface SessionBadgeProps {
  className?: string;
}

export function SessionBadge({ className = '' }: SessionBadgeProps) {
  const { data } = useEffectiveSessionDate();
  if (!data || data.isLive) return null;
  return (
    <span
      className={`text-[10px] font-mono text-amber-500/90 bg-amber-500/10 border border-amber-500/30 rounded px-1.5 py-0.5 ${className}`}
      title="Live data unavailable — showing the most recent completed session"
    >
      {formatClosedSessionLabel(data.sessionDateET)}
    </span>
  );
}
