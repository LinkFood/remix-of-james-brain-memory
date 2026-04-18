import { MarketBanner } from '@/components/command/MarketBanner';
import { MarketBreadth } from '@/components/command/MarketBreadth';
import { TickerGrid } from '@/components/command/TickerGrid';
import { EventFeed } from '@/components/command/EventFeed';
import { CuriosityFeed } from '@/components/command/CuriosityFeed';
import { NewsFeed } from '@/components/command/NewsFeed';
import { RecapPanel } from '@/components/command/RecapPanel';
import { JamesVsClaude } from '@/components/command/JamesVsClaude';
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
import { MacroCalendar } from '@/components/command/MacroCalendar';
import { PositioningPanel } from '@/components/command/PositioningPanel';
import { GexHeatmap } from '@/components/command/GexHeatmap';
import { GexRadar } from '@/components/command/GexRadar';
import { AlwaysOnFlagStrip } from '@/components/command/AlwaysOnFlagStrip';
import { SweepClusterStrip } from '@/components/command/SweepClusterStrip';
import { DpClusterStrip } from '@/components/command/DpClusterStrip';
import { AttentionLeaderboard } from '@/components/command/AttentionLeaderboard';
import { LinkGexDeep } from '@/components/command/LinkGexDeep';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { MorningBriefPanel } from '@/components/command/MorningBriefPanel';
import { BookEquityCurve } from '@/components/command/BookEquityCurve';
import { TradeAdvisoriesStrip } from '@/components/command/TradeAdvisoriesStrip';
import { ClaudesRead } from '@/components/command/ClaudesRead';
import { ColdOpen } from '@/components/command/ColdOpen';
import { PreBellChecklist } from '@/components/command/PreBellChecklist';
import { HistoricalAnalogsCard } from '@/components/command/HistoricalAnalogsCard';
import { PremarketGapsCard } from '@/components/command/PremarketGapsCard';
import { isPreMarket } from '@/lib/etMarketClock';
import { TradeCards } from '@/components/command/TradeCards';
import { VoiceToggle } from '@/components/command/VoiceToggle';
import { McpCallsPanel } from '@/components/command/McpCallsPanel';
import { BiasesPanel } from '@/components/command/BiasesPanel';
import { SizingCalculatorButton } from '@/components/command/SizingCalculator';
import { Button } from '@/components/ui/button';
import { triggerCoTrader } from '@/hooks/useCoTraderData';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { RefreshCw, Zap, Flag } from 'lucide-react';
import { toast } from 'sonner';

export default function CommandStation() {
  const qc = useQueryClient();
  const [firing, setFiring] = useState(false);
  // Shared drill-down sheet — AlwaysOnFlagStrip and GexRadar both trigger it.
  const [deepTicker, setDeepTicker] = useState<string | null>(null);
  const deepOpen = deepTicker !== null;

  // Pre-bell mode swaps ColdOpen → PreBellChecklist during 04:00–09:31 ET on
  // trading days. Polled every 30s (not every render) so the swap happens at
  // the minute boundary without re-rendering on every second tick.
  const [preBell, setPreBell] = useState(() => isPreMarket());
  useEffect(() => {
    const id = setInterval(() => setPreBell(isPreMarket()), 30_000);
    return () => clearInterval(id);
  }, []);

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

  function scrollToPostView() {
    const el = document.getElementById('co-post-view');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Brief attention pulse — CSS handles the animation via the ring class.
      el.classList.add('ring-2', 'ring-blue-400/60', 'transition-shadow');
      setTimeout(() => {
        el.classList.remove('ring-2', 'ring-blue-400/60', 'transition-shadow');
      }, 1600);
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
            <VoiceToggle />
            <SizingCalculatorButton />
            <Button
              size="sm"
              variant="outline"
              onClick={scrollToPostView}
              className="border-blue-500/40 text-blue-300 hover:bg-blue-500/10 hover:text-blue-200"
            >
              <Flag className="w-3.5 h-3.5 mr-1" /> Post your view
            </Button>
            <Button size="sm" variant="outline" onClick={() => qc.invalidateQueries()}>
              <RefreshCw className="w-3.5 h-3.5 mr-1" /> Refresh
            </Button>
            <Button size="sm" onClick={fireWatcher} disabled={firing}>
              <Zap className="w-3.5 h-3.5 mr-1" /> {firing ? 'firing…' : 'Run watcher now'}
            </Button>
          </div>
        </header>

        {/* Pre-market Gaps — only mounts above ColdOpen in the pre-open window.
            The component self-hides when every ticker is 'flat' tier, so it
            disappears after the first hour of trade without us having to
            orchestrate visibility here. */}
        <PremarketGapsCard />

        {/* Pre-bell mode: glance-able readiness checklist replaces ColdOpen
            from 04:00 → 09:30 ET (weekdays, skips NYSE holidays). Once the
            bell rings at 09:31 ET, ColdOpen returns and the checklist
            self-unmounts. PreBellChecklist also returns null on non-trading
            days, so ColdOpen is always the fallback. */}
        {preBell ? <PreBellChecklist /> : <ColdOpen onOpenDeep={setDeepTicker} />}

        {/* Historical Analogs — "today's tape matches these past sessions".
            Directional forecast (avg EOD return of top-N analogs) + link to
            /session?date= for each match. Warming-up copy shown until the
            nightly cron has accumulated ~5 days of embeddings. */}
        <HistoricalAnalogsCard />

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

        {/* Watchlist breadth — narrow vs broad tape at a glance. Zero new UW
            calls, aggregates ct_heartbeats._snapshot.per_ticker prices. */}
        <div id="co-market-breadth">
          <MarketBreadth />
        </div>

        {/* Macro calendar — 14d timeline of FOMC/CPI/PPI/jobs/employment/GDP/
            fed_speak/retail_sales with pre-event posture for high-impact
            events inside 48h. Zero new UW calls (reads ct_events). */}
        <MacroCalendar />

        <GexRadar tickers={['SPY', 'QQQ', 'IWM']} onDrillDown={setDeepTicker} />

        <GexHeatmap />

        <NetPremiumCumulative />

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          <div className="lg:col-span-8 space-y-4">
            {/* Per-ticker attention leaderboard — aggregate of obs/flags/alerts
                over the last 30 min. Hidden when every ticker scores <20.
                Click pill → opens shared LinkGexDeep sheet (same surface as
                AlwaysOnFlagStrip / GexRadar). */}
            <AttentionLeaderboard onOpenDeep={setDeepTicker} />
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
            {/* Biases — Claude's self-identified blindspots, weekly cadence.
                Below CuriosityFeed: calibration data, not real-time tape. */}
            <BiasesPanel />
            <DarkPoolTape />
            <DarkPoolChart />
            <NewsFeed />
          </div>
          <div className="lg:col-span-4 space-y-4">
            {/* Advisories strip — highest-urgency unacked trade advisories,
                from ct-trade-advisories. Renders null when none outstanding
                so the sidebar isn't padded with an empty card. */}
            <TradeAdvisoriesStrip />
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

        {/* James vs Claude — head-to-head comparison of disagreements. Full
            width so the paired cards have room for rationale side-by-side.
            Replaced the old DisagreementPanel (April 2026). */}
        <JamesVsClaude variant="command" onPostView={scrollToPostView} />

        {/* Post-a-view form — target of the "Post your view" header button
            and the JamesVsClaude CTA. Wrapped in an id'd section so
            scrollToPostView can find it and the pulse ring can land here. */}
        <div id="co-post-view" className="pt-2 rounded-md">
          <JamesViewForm />
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
