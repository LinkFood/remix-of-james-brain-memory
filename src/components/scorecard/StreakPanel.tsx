/**
 * StreakPanel — tilt-awareness surface for the Scorecard page.
 *
 * Shows:
 *   1. Header ("Current streak: 🔥 3 right" or "⚠️ 2 wrong")
 *   2. 20-dot heatmap of recent outcomes (oldest→newest, left→right)
 *   3. Stats: longest-right / longest-wrong / avg run length
 *   4. Tilt banner (bordered, bold) when tilt_risk fires, with historical
 *      next-outcome win rate after N-wrong streaks
 *   5. Cross-ref links to PreBellChecklist + drawdown watch
 *
 * Place on /scorecard near CalibrationChart. Anchor id=streaks so the
 * TopNav pill can deep-link straight to it.
 */
import { useMemo } from 'react';
import { Card } from '@/components/ui/card';
import { Flame, AlertTriangle, TrendingUp, TrendingDown, Activity, ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  useStreaks,
  nextOutcomeAfterNWrong,
  MIN_HISTORY,
  type GradeDot,
  type Verdict,
} from '@/hooks/useStreaks';

const DOT_COLOR: Record<Verdict, string> = {
  right:     'bg-emerald-500',
  partial:   'bg-amber-500',
  wrong:     'bg-red-500',
  ambiguous: 'bg-muted',
};

const DOT_TITLE: Record<Verdict, string> = {
  right:     'right',
  partial:   'partial',
  wrong:     'wrong',
  ambiguous: 'ambiguous',
};

function Heatmap({ recent, total }: { recent: GradeDot[]; total: number }) {
  // Pad to 20 slots so the width is stable even when history is thin.
  const slots: (GradeDot | null)[] = [...recent];
  while (slots.length < 20) slots.push(null);
  // Render oldest→newest (left→right) so the right edge is "now" — matches
  // how traders read price charts.
  const displayOrder = slots.slice(0, 20).reverse();

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        {displayOrder.map((d, i) => (
          <div
            key={i}
            className={`w-3 h-3 rounded-sm ${d ? DOT_COLOR[d.verdict] : 'bg-muted/20 border border-dashed border-muted'} transition-all`}
            title={
              d
                ? `${DOT_TITLE[d.verdict]}${d.instrument ? ` · ${d.instrument}` : ''} · ${new Date(d.graded_at).toLocaleString()}`
                : 'no data'
            }
          />
        ))}
      </div>
      <div className="flex justify-between text-[9px] text-muted-foreground font-mono uppercase tracking-wider">
        <span>oldest</span>
        <span>total 30d: {total}</span>
        <span>now →</span>
      </div>
    </div>
  );
}

function StreakHeader({
  rightStreak,
  wrongStreak,
}: {
  rightStreak: number;
  wrongStreak: number;
}) {
  if (wrongStreak >= 2) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xl" aria-hidden>⚠️</span>
        <span className="text-lg font-bold text-red-400">
          Current streak: {wrongStreak} wrong
        </span>
      </div>
    );
  }
  if (rightStreak >= 2) {
    return (
      <div className="flex items-center gap-2">
        <Flame className="w-5 h-5 text-orange-400" aria-hidden />
        <span className="text-lg font-bold text-emerald-400">
          Current streak: {rightStreak} right
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <Activity className="w-5 h-5 text-muted-foreground" />
      <span className="text-lg font-semibold text-foreground/80">
        No active streak
      </span>
    </div>
  );
}

export function StreakPanel() {
  const { data, isLoading } = useStreaks();

  const combined = data?.combined;
  const insufficient = (combined?.total ?? 0) < MIN_HISTORY;

  const tiltRecovery = useMemo(() => {
    if (!combined) return null;
    const n = Math.max(3, combined.current_wrong_streak);
    const r = nextOutcomeAfterNWrong(combined.recent.concat([]), n);
    // For historical depth we want the FULL 30d stream, not just the 20 recent
    // dots — use combined.recent only if we haven't built a richer dataset.
    // useStreaks already restricts recent=last 20; we feed the whole combined
    // stream via a second pass below.
    return { n, ...r };
  }, [combined]);

  // Build a larger recovery sample from all grade dots (the hook exposes
  // recent=20; walk the combined streams via nextOutcomeAfterNWrong over the
  // full grades stream to get a stable rate).
  const recoveryStat = useMemo(() => {
    if (!data) return null;
    // Concatenate all grade + trade dots (most recent first is fine, the
    // helper handles reversal).
    const allCombined: GradeDot[] = [
      ...data.grades.recent,
      ...data.trades.recent,
    ]
      .filter((d): d is GradeDot => !!d)
      .sort((a, b) => new Date(b.graded_at).getTime() - new Date(a.graded_at).getTime());
    if (allCombined.length < 10) return null;
    const n = Math.max(3, data.combined.current_wrong_streak);
    return { n, ...nextOutcomeAfterNWrong(allCombined, n) };
  }, [data]);

  return (
    <Card id="streaks" className="p-4 scroll-mt-4">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground mb-3">
        <Flame className="w-3 h-3" /> Streaks &amp; Tilt
        <span className="normal-case tracking-normal text-muted-foreground/70">
          — psychology surface: 3 wrong in a row or &le;40% over last 5 → pause signal
        </span>
      </div>

      {isLoading ? (
        <div className="text-xs text-muted-foreground py-6">Loading streak data...</div>
      ) : !combined ? (
        <div className="text-xs text-muted-foreground py-6">No streak data available.</div>
      ) : (
        <div className="flex flex-col gap-4">
          {/* Header */}
          <div className="flex items-baseline justify-between gap-4 flex-wrap">
            <StreakHeader
              rightStreak={combined.current_right_streak}
              wrongStreak={combined.current_wrong_streak}
            />
            <div className="text-[10px] text-muted-foreground font-mono">
              last verdict:&nbsp;
              <span className="text-foreground/80 uppercase tracking-wide">
                {combined.last_verdict ?? '—'}
              </span>
            </div>
          </div>

          {/* Tilt banner — only when tilt_risk fires. Bordered and unmissable. */}
          {combined.tilt_risk && (
            <div
              className="border-2 border-red-500/60 bg-red-500/10 rounded-md p-3 flex flex-col gap-2"
              role="alert"
            >
              <div className="flex items-center gap-2 text-red-400 font-bold text-sm">
                <AlertTriangle className="w-4 h-4" />
                TILT RISK: {combined.tilt_reasons.join(' · ')}
              </div>
              <div className="text-xs text-foreground/90 leading-relaxed">
                {recoveryStat && recoveryStat.hits >= 2 ? (
                  <>
                    Historical next-trade win rate after{' '}
                    <span className="font-mono font-semibold">
                      {recoveryStat.n}L
                    </span>
                    :{' '}
                    <span className="font-mono font-semibold text-red-300">
                      {recoveryStat.rate != null
                        ? `${Math.round(recoveryStat.rate * 100)}%`
                        : '—'}
                    </span>{' '}
                    <span className="text-muted-foreground">
                      ({recoveryStat.nextWin}/{recoveryStat.hits} recoveries in 30d).
                    </span>
                  </>
                ) : (
                  <span className="text-muted-foreground">
                    Insufficient 30d sample to compute recovery rate ({recoveryStat?.hits ?? 0}{' '}
                    prior {recoveryStat?.n ?? 3}L streaks).
                  </span>
                )}{' '}
                Consider pausing, reducing size, or sticking to
                highest-conviction setups only.
              </div>
              <div className="flex items-center gap-3 text-[11px] pt-1">
                <Link
                  to="/preflight"
                  className="text-red-300 hover:text-red-200 underline-offset-2 hover:underline flex items-center gap-1"
                >
                  Pre-bell checklist <ArrowRight className="w-3 h-3" />
                </Link>
                <Link
                  to="/book"
                  className="text-red-300 hover:text-red-200 underline-offset-2 hover:underline flex items-center gap-1"
                >
                  Drawdown &amp; book <ArrowRight className="w-3 h-3" />
                </Link>
              </div>
            </div>
          )}

          {/* Heatmap — last 20 grades oldest→newest */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
              Last 20 outcomes (combined)
            </div>
            {insufficient ? (
              <div className="flex flex-col gap-1.5">
                <Heatmap recent={combined.recent} total={combined.total} />
                <div className="text-[10px] text-amber-400/80 font-mono">
                  insufficient history ({combined.total} / {MIN_HISTORY} minimum) — streak stats will stabilize as horizons close.
                </div>
              </div>
            ) : (
              <Heatmap recent={combined.recent} total={combined.total} />
            )}
          </div>

          {/* Stats grid — longest right / longest wrong / avg streak length */}
          <div className="grid grid-cols-3 gap-2">
            <StatTile
              icon={<TrendingUp className="w-3 h-3" />}
              label="Longest right (30d)"
              value={combined.longest_right_streak_30d}
              tone="good"
            />
            <StatTile
              icon={<TrendingDown className="w-3 h-3" />}
              label="Longest wrong (30d)"
              value={combined.longest_wrong_streak_30d}
              tone="bad"
            />
            <StatTile
              icon={<Activity className="w-3 h-3" />}
              label="Avg run length"
              value={combined.avg_streak_length.toFixed(1)}
              tone="neutral"
            />
          </div>

          {/* Trades-only subline — surfaces whether the tilt is in CLAIMS (grades)
              or real money (trades). Deliberately compact. */}
          {data && (data.grades.total > 0 || data.trades.total > 0) && (
            <div className="grid grid-cols-2 gap-2 text-[10px] font-mono">
              <SubStream label="Grades (flags/alerts/views)" s={data.grades} />
              <SubStream label="Trades (closed)" s={data.trades} />
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function StatTile({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  tone: 'good' | 'bad' | 'neutral';
}) {
  const color =
    tone === 'good' ? 'text-emerald-400' : tone === 'bad' ? 'text-red-400' : 'text-foreground';
  return (
    <div className="bg-muted/20 rounded p-2 flex flex-col gap-0.5">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <div className={`text-xl font-bold font-mono ${color}`}>{value}</div>
    </div>
  );
}

function SubStream({
  label,
  s,
}: {
  label: string;
  s: {
    total: number;
    current_right_streak: number;
    current_wrong_streak: number;
    longest_right_streak_30d: number;
    longest_wrong_streak_30d: number;
  };
}) {
  return (
    <div className="bg-muted/10 rounded px-2 py-1.5">
      <div className="text-muted-foreground uppercase tracking-wider">{label}</div>
      <div className="text-foreground/80">
        now: {s.current_right_streak}R · {s.current_wrong_streak}W · peak: {s.longest_right_streak_30d}R / {s.longest_wrong_streak_30d}W · n={s.total}
      </div>
    </div>
  );
}
