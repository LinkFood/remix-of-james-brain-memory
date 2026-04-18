import { MarketBanner } from '@/components/command/MarketBanner';
import { TickerGrid } from '@/components/command/TickerGrid';
import { EventFeed } from '@/components/command/EventFeed';
import { CuriosityFeed } from '@/components/command/CuriosityFeed';
import { NewsFeed } from '@/components/command/NewsFeed';
import { RecapPanel } from '@/components/command/RecapPanel';
import { DisagreementPanel } from '@/components/command/DisagreementPanel';
import { JamesViewForm } from '@/components/command/JamesViewForm';
// ChatBox replaced by docked ChatPanel (rendered by AuthLayout via sidebar prop)
import { FlowTape } from '@/components/command/FlowTape';
import { DarkPoolTape } from '@/components/command/DarkPoolTape';
import { DarkPoolChart } from '@/components/command/DarkPoolChart';
import { FlowPerStrike } from '@/components/command/FlowPerStrike';
import { NetPremiumLine } from '@/components/command/NetPremiumLine';
import { NetPremiumCumulative } from '@/components/command/NetPremiumCumulative';
import { HiroPanel } from '@/components/command/HiroPanel';
import { MarketMovers } from '@/components/command/MarketMovers';
import { EventsPanel } from '@/components/command/EventsPanel';
import { PositioningPanel } from '@/components/command/PositioningPanel';
import { GexHeatmap } from '@/components/command/GexHeatmap';
import { GexRadar } from '@/components/command/GexRadar';
import { AlwaysOnFlagStrip } from '@/components/command/AlwaysOnFlagStrip';
import { SweepClusterStrip } from '@/components/command/SweepClusterStrip';
import { DpClusterStrip } from '@/components/command/DpClusterStrip';
import { LinkGexDeep } from '@/components/command/LinkGexDeep';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { MorningBriefPanel } from '@/components/command/MorningBriefPanel';
import { BookEquityCurve } from '@/components/command/BookEquityCurve';
import { ClaudesRead } from '@/components/command/ClaudesRead';
import { ColdOpen } from '@/components/command/ColdOpen';
import { TradeCards } from '@/components/command/TradeCards';
import { VoiceToggle } from '@/components/command/VoiceToggle';
import { McpCallsPanel } from '@/components/command/McpCallsPanel';
import { UwUsageBadge } from '@/components/command/UwUsageBadge';
import { Button } from '@/components/ui/button';
import { triggerCoTrader } from '@/hooks/useCoTraderData';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { RefreshCw, Zap, Clock, Activity } from 'lucide-react';
import { toast } from 'sonner';
import { Link } from 'react-router-dom';

export default function CommandStation() {
  const qc = useQueryClient();
  const [firing, setFiring] = useState(false);
  // Shared drill-down sheet — AlwaysOnFlagStrip and GexRadar both trigger it.
  const [deepTicker, setDeepTicker] = useState<string | null>(null);
  const deepOpen = deepTicker !== null;

  async function fireWatcher() {
    setFiring(true);
    try {
      const r = await triggerCoTrader('watcher');
      if (r.ok) toast.success('watcher fired — 15-30s to land');
      else toast.error(`watcher failed: ${r.error}`);
      setTimeout(() => qc.invalidateQueries(), 20_000);
    } finally {
      setFiring(false);
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-[1600px] mx-auto p-4 space-y-4">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <span className="text-primary">Co-Trader</span>
              <span className="text-sm text-muted-foreground font-normal">command station</span>
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Claude watches SPY · QQQ · IWM · Mag 7 · GLD (gold proxy) · USO (oil proxy) · SPX macro
            </p>
          </div>
          <div className="flex items-center gap-2">
            <UwUsageBadge />
            <VoiceToggle />
            <Button asChild size="sm" variant="outline">
              <Link to="/session"><Clock className="w-3.5 h-3.5 mr-1" /> Session →</Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link to="/health"><Activity className="w-3.5 h-3.5 mr-1" /> Health</Link>
            </Button>
            <Button size="sm" variant="outline" onClick={() => qc.invalidateQueries()}>
              <RefreshCw className="w-3.5 h-3.5 mr-1" /> Refresh
            </Button>
            <Button size="sm" onClick={fireWatcher} disabled={firing}>
              <Zap className="w-3.5 h-3.5 mr-1" /> {firing ? 'firing…' : 'Run watcher now'}
            </Button>
          </div>
        </header>

        {/* Cold Open — "what matters right now?" digest. Literal first block.
            Scrolls to or opens the right panel for each bullet. */}
        <ColdOpen onOpenDeep={setDeepTicker} />

        <ClaudesRead />

        <div id="co-trade-cards">
          <TradeCards />
        </div>

        {/* Always-on flag strip: structural signals (URGENT / A+ / SQUEEZE /
            BATTLEGROUND) regardless of filter state. Eyes-first row. */}
        <AlwaysOnFlagStrip
          tickers={['SPY', 'QQQ', 'IWM']}
          onOpenDeep={setDeepTicker}
        />

        {/* Sibling strip for sweep-cluster event bursts. Hidden when the
            15-min window is empty. Click pill → focuses FlowTape via
            ct:flowtape:filter window event. */}
        <div id="co-sweep-strip">
          <SweepClusterStrip />
        </div>

        {/* Dark-pool cluster strip — parallel pattern for block-print bursts.
            3+ prints >= $1M on same ticker in a 10-min window. Click pill →
            focuses DarkPoolTape via ct:darkpool:filter window event. */}
        <div id="co-dp-strip">
          <DpClusterStrip />
        </div>

        <div id="co-market-banner">
          <MarketBanner />
        </div>

        <GexRadar tickers={['SPY', 'QQQ', 'IWM']} onDrillDown={setDeepTicker} />

        <GexHeatmap />

        <NetPremiumCumulative />

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          <div className="lg:col-span-8 space-y-4">
            <TickerGrid onOpenDeep={setDeepTicker} />
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <NetPremiumLine />
              <HiroPanel />
            </div>
            <FlowPerStrike />
            <div id="co-event-feed">
              <EventFeed />
            </div>
            <CuriosityFeed />
            <DarkPoolTape />
            <DarkPoolChart />
            <NewsFeed />
          </div>
          <div className="lg:col-span-4 space-y-4">
            {/* Morning Brief pinned to top — 90-sec pre-bell read */}
            <MorningBriefPanel />
            {/* Book equity — Claude's $10k paper book, live. Equity curve +
                HWM band + drawdown shading. "view full book" → /book. */}
            <BookEquityCurve />
            <FlowTape />
            <MarketMovers />
            <EventsPanel />
            <PositioningPanel />
            <RecapPanel />
            <McpCallsPanel />
          </div>
        </div>

        {/* Bottom tools row — post-a-view + claude's self-critique, side-by-side */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
          <JamesViewForm />
          <DisagreementPanel />
        </div>

        <footer className="pt-4 text-[10px] text-muted-foreground/60 text-center">
          Watcher: 30min · Curiosity: 30min (offset :07/:37) · Grader: 15min · News: 20min · EOD: 21:30 UTC weekdays · Lessons: Sunday 23:00 UTC
        </footer>
      </div>

      {/* Shared LinkGexDeep drill-down Sheet — driven by AlwaysOnFlagStrip
          pill clicks AND GexRadar column clicks. Single surface. */}
      <Sheet open={deepOpen} onOpenChange={(o) => { if (!o) setDeepTicker(null); }}>
        <SheetContent
          side="right"
          className="w-full sm:max-w-[860px] bg-black border-white/10 p-0 overflow-y-auto"
        >
          {deepTicker && <LinkGexDeep ticker={deepTicker} enabled={deepOpen} />}
        </SheetContent>
      </Sheet>
      {/* ChatPanel docked by AuthLayout sidebar prop */}
    </div>
  );
}
