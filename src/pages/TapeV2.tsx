/**
 * /tape-v2 — Tape command-center redesign (parallel route).
 *
 * Captain framing locked 2026-05-08: Tape becomes the captain's composition
 * surface. The architecture is multi-component (correctly so); this page
 * un-silos the read at the UX layer while preserving the dedicated pages
 * as depth views. Tenet 24 manifesting at the UX layer.
 *
 * Old /tape stays UNTOUCHED. Both routes function during the validation
 * window. After captain validates, follow-up small PRs handle nav exposure
 * → migration → cleanup of Tape.tsx (App.tsx is the only importer per
 * PR #71 finding).
 *
 * v1 scope:
 *   - Main col: Warden + MacroBanner + TapeReaderArc + Specialists 10-tile
 *     + FlowPulse + Flow Butterfly section (TICKER/MARKET/ALL) + Overnight
 *   - Right rail: phase-aware composition of BriefSwap + Alarms + Heatmap
 *     + Flags + News
 *
 * v1 deferral: raw tape table (lives inline in Tape.tsx and would require
 * touching that file to extract — violates the parallel-route safety
 * constraint). Captain validates the new composition on /tape-v2 with
 * /tape still available for raw prints. v1.1 follow-up extracts the table
 * into a shared component once /tape can be retired.
 *
 * Reuse: SystemWardenCard, MacroBanner, FlowPulse, OvernightPositioning,
 * AlarmBanner, NewsFeed, TickerSheet — all imported as-is, zero edits.
 */

import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Link } from 'react-router-dom';
import { ArrowUpRight, ArrowRight } from 'lucide-react';
import { SystemWardenCard } from '@/components/system/SystemWardenCard';
import { MacroBanner } from '@/components/command/MacroBanner';
import { FlowPulse } from '@/components/command/FlowPulse';
import { OvernightPositioning } from '@/components/command/OvernightPositioning';
import { AlarmBanner } from '@/components/co-trader/AlarmBanner';
import { TickerSheet } from '@/components/command/TickerSheet';
import { TapeReaderArc } from '@/components/tape-v2/TapeReaderArc';
import { SpecialistsTileRow } from '@/components/tape-v2/SpecialistsTileRow';
import { FlowButterflySection } from '@/components/tape-v2/FlowButterflySection';
import { RightRail } from '@/components/tape-v2/RightRail';

export default function TapeV2() {
  const [activeTicker, setActiveTicker] = useState<string | null>(null);

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-sm font-mono uppercase tracking-wider text-muted-foreground">
          Command Center · v2
        </h1>
        <Link
          to="/tape"
          className="inline-flex items-center gap-1 text-[10px] font-mono text-muted-foreground hover:text-foreground transition-colors"
          title="Original /tape with full prints table"
        >
          legacy /tape <ArrowUpRight className="w-3 h-3" />
        </Link>
      </div>

      {/* Main grid: main col + right rail.
          - lg+: two-column with right rail at fixed 320px
          - below lg: stacks (main col over right rail) */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-3">

        <div className="space-y-3 min-w-0">
          <SystemWardenCard />
          <MacroBanner onTickerClick={setActiveTicker} />
          <AlarmBanner />
          <TapeReaderArc />
          <SpecialistsTileRow />
          {/* showChartPanel=false suppresses FlowPulse's embedded
              FlowPulseChartPanel because FlowButterflySection (rendered
              just below) already owns the MARKET / TICKER / ALL chart
              surface. Without this, /tape-v2 paints two stacked Flow
              Butterfly charts. Iter #4 fix. */}
          <FlowPulse onTickerClick={setActiveTicker} showChartPanel={false} />
          <FlowButterflySection />
          <OvernightPositioning
            onTickerClick={setActiveTicker}
            onContractClick={undefined}
          />

          {/* v1 footer: raw prints table lives on legacy /tape until v1.1
              extraction. Surfacing the link here so captain knows where
              to drill for raw flow during validation. */}
          <Card className="p-2.5 border-dashed bg-muted/5">
            <div className="flex items-center justify-between gap-2 text-[10px]">
              <span className="text-muted-foreground">
                Raw prints table · v1 keeps it on legacy /tape during the
                validation window. v1.1 extracts the table into a shared
                component for inline rendering here.
              </span>
              <Link
                to="/tape"
                className="inline-flex items-center gap-1 font-mono text-primary/80 hover:text-primary whitespace-nowrap"
              >
                Open /tape <ArrowRight className="w-3 h-3" />
              </Link>
            </div>
          </Card>
        </div>

        <aside className="lg:sticky lg:top-3 lg:self-start min-w-0">
          <RightRail />
        </aside>
      </div>

      <TickerSheet
        ticker={activeTicker}
        open={activeTicker !== null}
        onOpenChange={(o) => !o && setActiveTicker(null)}
      />
    </div>
  );
}
