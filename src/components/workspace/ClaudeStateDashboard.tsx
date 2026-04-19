/**
 * ClaudeStateDashboard — the glance-first /workspace landing (Phase 1 Wave H).
 *
 * Tenet 9: "UI is glance-first. User sees state in one view. Tabs drill down.
 * Nothing critical hides behind navigation." This composite renders every
 * live pulse of Claude in a single scrollable page:
 *
 *   Row 1 — Status strip (heartbeat, circuit, hallucinations, exposure, balance)
 *   Row 2 — Today's brief
 *   Row 3 — Open positions + armed ideas (side by side)
 *   Row 4 — Decision log feed (last 15)
 *   Row 5 — James's review queue (one-click thumbs)
 *
 * No tabs. No navigation to see the state. James opens /workspace → sees
 * everything. Old tabs (Theses, Trade Log, Book, Divergence) move to a top
 * sub-view router in Workspace.tsx.
 */
import { StatusStrip } from './StatusStrip';
import { BriefSummaryCard } from './BriefSummaryCard';
import { LiveActionStrip } from './LiveActionStrip';
import { DecisionLogFeed } from './DecisionLogFeed';
import { ReviewQueueCompact } from './ReviewQueueCompact';

export function ClaudeStateDashboard() {
  return (
    <div className="space-y-3">
      <StatusStrip />
      <BriefSummaryCard />
      <LiveActionStrip />
      <DecisionLogFeed />
      <ReviewQueueCompact />
    </div>
  );
}
