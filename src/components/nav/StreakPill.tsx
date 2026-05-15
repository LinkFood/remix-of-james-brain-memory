/**
 * StreakPill — muted streak indicator for TopNav.
 *
 * Rules:
 *   - Green  🔥 Nr  when current_right_streak >= 2
 *   - Red    ⚠️ Nw  when current_wrong_streak >= 2
 *   - Muted (nothing displayed) when both streaks are < 2
 *
 * Click → /patterns#streaks. Reuses useStreaks — the hook cache means this
 * doesn't double-fetch if a streak panel is mounted elsewhere.
 */
import { Link } from 'react-router-dom';
import { Flame, AlertTriangle } from 'lucide-react';
import { useStreaks } from '@/hooks/useStreaks';

export function StreakPill() {
  const { data } = useStreaks();
  if (!data) return null;

  const { current_right_streak: r, current_wrong_streak: w, tilt_risk } = data.combined;

  // Silence when there's no streak. Silent by design — noise costs
  // trust, and a "no streak" pill is just visual clutter on the bar.
  if (r < 2 && w < 2) return null;

  // Wrong streak takes priority if both > 0 (shouldn't happen since they're
  // mutually exclusive — leading-run logic — but defensive).
  if (w >= 2) {
    const tone = tilt_risk
      ? 'text-red-400 bg-red-500/10 hover:bg-red-500/20 border-red-500/30'
      : 'text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 border-amber-500/30';
    return (
      <Link
        to="/patterns#streaks"
        className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs border transition-colors ${tone}`}
        title={
          // Label scope made explicit so captain doesn't conflate this 30d
          // per-call-grader counter with today's contract-track WIN-bar hit%
          // (EOD slack) or the morning-brief scorecard EOD% (/eod-report).
          // (goal #4 item 3 disambiguation, 2026-05-15.)
          tilt_risk
            ? `Tilt streak (30d grader) — ${data.combined.tilt_reasons.join(', ')}`
            : `Tilt streak (30d grader) — current wrong streak: ${w}`
        }
      >
        <AlertTriangle className="w-3 h-3" aria-hidden />
        <span className="font-mono tabular-nums">{w}w</span>
      </Link>
    );
  }

  // Right streak — non-alarming green.
  return (
    <Link
      to="/patterns#streaks"
      className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 transition-colors"
      title={`Current right streak: ${r}`}
    >
      <Flame className="w-3 h-3" aria-hidden />
      <span className="font-mono tabular-nums">{r}r</span>
    </Link>
  );
}
