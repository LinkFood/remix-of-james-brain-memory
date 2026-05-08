/**
 * RightRail — composed snapshots for the v2 Tape command center.
 *
 * Slot order is phase-aware (pre_open / rth / post_close) computed once on
 * mount via useEtPhaseBucket. Captain manual reorder via collapse state
 * could be added in v1.1; v1 trusts the phase ordering.
 *
 * Phase 2 emission event-feed slot is deferred (PR #71 §9). Adding it later
 * is one entry in this slot-order array + one component import.
 *
 * Layout: stacked column. The page-level grid handles narrow-viewport
 * collapse (right rail wraps below main col on lg- breakpoints).
 */

import { useMemo } from 'react';
import { useEtPhaseBucket, type EtPhase } from '@/hooks/useEtPhaseBucket';
import { BriefSwap } from './snapshots/BriefSwap';
import { AlarmsSnapshot } from './snapshots/AlarmsSnapshot';
import { HeatmapSnapshot } from './snapshots/HeatmapSnapshot';
import { FlagsSnapshot } from './snapshots/FlagsSnapshot';
import { NewsFeed } from '@/components/co-trader/NewsFeed';

type SlotKey = 'brief' | 'alarms' | 'heatmap' | 'flags' | 'news';

const ORDER_BY_PHASE: Record<EtPhase, SlotKey[]> = {
  pre_open:   ['brief', 'heatmap', 'flags', 'alarms', 'news'],
  rth:        ['alarms', 'heatmap', 'flags', 'brief', 'news'],
  post_close: ['brief', 'flags', 'alarms', 'heatmap', 'news'],
};

function renderSlot(key: SlotKey) {
  switch (key) {
    case 'brief':   return <BriefSwap />;
    case 'alarms':  return <AlarmsSnapshot />;
    case 'heatmap': return <HeatmapSnapshot />;
    case 'flags':   return <FlagsSnapshot />;
    case 'news':    return <NewsFeed />;
  }
}

export function RightRail() {
  const phase = useEtPhaseBucket();
  const order = useMemo<SlotKey[]>(() => ORDER_BY_PHASE[phase], [phase]);

  return (
    <div className="space-y-2.5">
      {order.map((slot) => (
        <div key={slot}>{renderSlot(slot)}</div>
      ))}
    </div>
  );
}
