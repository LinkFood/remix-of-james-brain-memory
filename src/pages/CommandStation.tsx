import { MarketBanner } from '@/components/command/MarketBanner';
import { TickerGrid } from '@/components/command/TickerGrid';
import { EventFeed } from '@/components/command/EventFeed';
import { NewsFeed } from '@/components/command/NewsFeed';
import { RecapPanel } from '@/components/command/RecapPanel';
import { DisagreementPanel } from '@/components/command/DisagreementPanel';
import { JamesViewForm } from '@/components/command/JamesViewForm';
import { ChatBox } from '@/components/command/ChatBox';
import { FlowTape } from '@/components/command/FlowTape';
import { DarkPoolTape } from '@/components/command/DarkPoolTape';
import { FlowPerStrike } from '@/components/command/FlowPerStrike';
import { NetPremiumLine } from '@/components/command/NetPremiumLine';
import { HiroPanel } from '@/components/command/HiroPanel';
import { MarketMovers } from '@/components/command/MarketMovers';
import { EventsPanel } from '@/components/command/EventsPanel';
import { GexHeatmap } from '@/components/command/GexHeatmap';
import { MorningBriefPanel } from '@/components/command/MorningBriefPanel';
import { Button } from '@/components/ui/button';
import { triggerCoTrader } from '@/hooks/useCoTraderData';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { RefreshCw, Zap } from 'lucide-react';
import { toast } from 'sonner';

export default function CommandStation() {
  const qc = useQueryClient();
  const [firing, setFiring] = useState(false);

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
            <Button size="sm" variant="outline" onClick={() => qc.invalidateQueries()}>
              <RefreshCw className="w-3.5 h-3.5 mr-1" /> Refresh
            </Button>
            <Button size="sm" onClick={fireWatcher} disabled={firing}>
              <Zap className="w-3.5 h-3.5 mr-1" /> {firing ? 'firing…' : 'Run watcher now'}
            </Button>
          </div>
        </header>

        <MarketBanner />

        <GexHeatmap />

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          <div className="lg:col-span-8 space-y-4">
            <TickerGrid />
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <NetPremiumLine />
              <HiroPanel />
            </div>
            <div className="grid grid-cols-1 gap-4">
              <FlowPerStrike />
            </div>
            <EventFeed />
          </div>
          <div className="lg:col-span-4 space-y-4">
            <MorningBriefPanel />
            <FlowTape />
            <MarketMovers />
            <EventsPanel />
            <DarkPoolTape />
            <RecapPanel />
            <JamesViewForm />
            <DisagreementPanel />
            <NewsFeed />
          </div>
        </div>

        <footer className="pt-4 text-[10px] text-muted-foreground/60 text-center">
          Watcher: 30min · Grader: 15min · News: 20min · EOD: 21:30 UTC weekdays · Lessons: Sunday 23:00 UTC
        </footer>
      </div>
      <ChatBox />
    </div>
  );
}
