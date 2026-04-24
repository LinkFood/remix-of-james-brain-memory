/**
 * PreflightChip — tiny readiness indicator for TopNav.
 *
 * Green/yellow/red dot + count of non-green checks. Click → /health.
 * Uses the same usePreflightChecks hook as the page, so both views stay
 * in lockstep and the 60s refresh doesn't fire twice.
 */

import { NavLink } from 'react-router-dom';
import { usePreflightChecks } from '@/hooks/usePreflightChecks';

const DOT: Record<string, string> = {
  green: 'bg-emerald-500',
  yellow: 'bg-yellow-500',
  red: 'bg-red-500',
};

const FG: Record<string, string> = {
  green: 'text-emerald-400',
  yellow: 'text-yellow-400',
  red: 'text-red-400',
};

export function PreflightChip() {
  const { summary, loading } = usePreflightChecks();

  // While the first run is in-flight, render a muted placeholder. Don't show
  // fake "green" before we have data — that would lie about readiness.
  if (loading) {
    return (
      <NavLink
        to="/health"
        className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
        title="Preflight — running checks..."
      >
        <span className="w-2 h-2 rounded-full bg-muted-foreground/40 animate-pulse" />
        <span className="hidden sm:inline">Preflight</span>
      </NavLink>
    );
  }

  const dot = DOT[summary.overall];
  const fg = FG[summary.overall];
  const nonGreen = summary.yellow + summary.red;
  const pulse = summary.overall !== 'green';

  return (
    <NavLink
      to="/health"
      className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs hover:bg-muted/50 transition-colors ${fg}`}
      title={summary.headline}
    >
      <span className={`w-2 h-2 rounded-full ${dot} ${pulse ? 'animate-pulse' : ''}`} />
      <span className="hidden sm:inline font-medium">Preflight</span>
      {nonGreen > 0 && (
        <span className="tabular-nums font-semibold">{nonGreen}</span>
      )}
    </NavLink>
  );
}
