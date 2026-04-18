/**
 * AttentionLeaderboard — per-ticker attention ranking as a one-row pill strip.
 *
 * Answers "which tickers are hot right now?" in one glance. Sibling of
 * AlwaysOnFlagStrip / SweepClusterStrip / DpClusterStrip — same compact format,
 * same hidden-when-quiet ergonomics. The distinction:
 *
 *   - AlwaysOnFlagStrip   = structural combo verdicts on SPY/QQQ/IWM.
 *   - SweepClusterStrip   = flow-burst events (directional).
 *   - DpClusterStrip      = block-print bursts (institutional size).
 *   - AttentionLeaderboard = aggregate attention_score across obs/flags/alerts
 *     for the watched ticker set. Not tied to any single signal — just
 *     "what has Claude been most attentive to in the last 30 min?"
 *
 * Click a pill → navigates to /ticker/:symbol (TickerTerminal) — the
 * Bloomberg-style drill-down page. Previously opened a shared LinkGexDeep
 * Sheet; changed to full-page navigation because the terminal surfaces
 * attention history, flow, dark pool, graded alerts, and positions — not
 * just the option chain.
 *
 * Hidden entirely when every ticker scores below 20 — avoid shouting when
 * the market's quiet. Source hook handles the polling / realtime updates.
 */
import { memo } from 'react';
import { Link } from 'react-router-dom';
import { Flame } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  useAttentionLeaderboard,
  type LeaderboardEntry,
} from '@/hooks/useAttentionLeaderboard';

// Color tiers — picked to read at a glance, no text needed to distinguish.
// Matches the "heat" vocabulary: red = drop-what-you're-doing, grey = background.
const TIER_HOT = '#FF1744';     // 80+  — red
const TIER_WARM = '#FF9800';    // 60–79 — orange
const TIER_ACTIVE = '#FFD600';  // 40–59 — yellow
const TIER_DIM = '#64748b';     // <40   — slate

function tierColor(score: number): string {
  if (score >= 80) return TIER_HOT;
  if (score >= 60) return TIER_WARM;
  if (score >= 40) return TIER_ACTIVE;
  return TIER_DIM;
}

function kindLabel(kind: 'observation' | 'flag' | 'alert'): string {
  switch (kind) {
    case 'alert':       return 'ALERT';
    case 'flag':        return 'flag';
    case 'observation': return 'obs';
  }
}

interface PillProps {
  entry: LeaderboardEntry;
}

const AttentionPill = memo(function AttentionPill({ entry }: PillProps) {
  const bg = tierColor(entry.score);

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to={`/ticker/${entry.ticker}`}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold tabular-nums tracking-wide hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-white/30 transition-all shadow-sm"
            style={{ background: bg, color: '#000' }}
            aria-label={`${entry.ticker} attention score ${entry.score} — open ticker terminal`}
          >
            <Flame className="w-3 h-3" />
            <span>{entry.ticker}</span>
            <span className="opacity-80">{entry.score}</span>
          </Link>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="bg-black/95 border-white/10 text-white px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-white/60 mb-1">
            {entry.ticker} attention · last 30 min
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] tabular-nums">
            <span className="text-white/50">score</span>
            <span className="text-right">{entry.score}</span>
            <span className="text-white/50">events</span>
            <span className="text-right">{entry.event_count}</span>
            <span className="text-white/50">last 5 min</span>
            <span className="text-right">{entry.recent_count_5min}</span>
            <span className="text-white/50">top kind</span>
            <span className="text-right">{kindLabel(entry.top_event_kind)}</span>
          </div>
          <div className="text-[9px] text-white/40 mt-1.5 pt-1.5 border-t border-white/10">
            click → open ticker terminal for {entry.ticker}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
});

interface Props {
  /**
   * Legacy callback — kept for source compatibility with existing parents,
   * but no longer invoked: pills now navigate to /ticker/:symbol instead of
   * opening the shared LinkGexDeep sheet.
   */
  onOpenDeep?: (ticker: string) => void;
  /** Max pills shown. Default 8. */
  limit?: number;
  /** Window in minutes. Default 30. */
  windowMinutes?: number;
}

export const AttentionLeaderboard = memo(function AttentionLeaderboard({
  limit = 8,
  windowMinutes = 30,
}: Props) {
  const { data, isLoading } = useAttentionLeaderboard(windowMinutes);

  if (isLoading && data.length === 0) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-black/40 border border-white/5 text-[10px] text-muted-foreground">
        ranking attention…
      </div>
    );
  }

  const ranked = data.slice(0, limit);
  // Hide the whole strip when the market's quiet. "Quiet" = every candidate
  // below 20, per spec. We still keep the component mounted so the hook's
  // realtime subscription stays active.
  const maxScore = ranked.length > 0 ? ranked[0].score : 0;
  if (maxScore < 20) return null;

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-black/40 border border-white/5 overflow-x-auto">
      <span className="text-[10px] uppercase tracking-wider text-white/40 shrink-0">
        Attention
      </span>
      <div className="flex items-center gap-2 flex-nowrap">
        {ranked.map((e) => (
          <AttentionPill key={e.ticker} entry={e} />
        ))}
      </div>
    </div>
  );
});
