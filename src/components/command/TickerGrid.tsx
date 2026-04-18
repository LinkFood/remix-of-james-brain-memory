import { memo, useMemo, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  useLatestHeartbeat,
  useTheses,
  useRecentEvents,
  useSessionHeartbeats,
  useTickerDensity,
  type Heartbeat,
  type TickerDensityEntry,
} from '@/hooks/useCoTraderData';
import { useGexRadar, type GexComboVerdict, type GexRadarTicker } from '@/hooks/useGexRadar';
import {
  useNetPremiumCumulative,
  type NetPremCumTicker,
} from '@/hooks/useNetPremiumCumulative';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { GexMiniChart } from './GexMiniChart';

const INDEX_FALLBACK = new Set(['SPY', 'QQQ', 'IWM']);

interface Wall {
  strike: number;
  gex: number;
  distance_pct: number;
}

interface CondensedTicker {
  ticker: string;
  price: number | null;
  call_wall: number | null;
  put_wall: number | null;
  gamma_flip: number | null;
  regime?: 'positive' | 'negative' | 'unknown';
  call_walls?: Wall[];
  put_walls?: Wall[];
  net_gamma_oi: number | null;
  total_call_gamma_oi: number | null;
  total_put_gamma_oi: number | null;
  put_call_volume_ratio: number | null;
  day_put_call_ratio: number | null;
  near_atm_strike_count: number;
  near_atm_strikes?: Array<{ strike: number; call_gex: number; put_gex: number; net: number }>;
}

const LABELS: Record<string, { group: string; note?: string }> = {
  SPY: { group: 'Index' }, QQQ: { group: 'Index' }, IWM: { group: 'Index' },
  AAPL: { group: 'Mag7' }, MSFT: { group: 'Mag7' }, GOOGL: { group: 'Mag7' },
  AMZN: { group: 'Mag7' }, META: { group: 'Mag7' }, NVDA: { group: 'Mag7' }, TSLA: { group: 'Mag7' },
  GLD:  { group: 'Macro', note: 'gold proxy' },
  USO:  { group: 'Macro', note: 'oil proxy' },
};

function fmtLarge(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(2);
}

function fmtPrice(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  return n >= 100 ? n.toFixed(2) : n.toFixed(2);
}

function directionColor(d: string | undefined | null): string {
  switch (d) {
    case 'bullish':     return 'bg-green-500/15 text-green-400 border-green-500/30';
    case 'bearish':     return 'bg-red-500/15 text-red-400 border-red-500/30';
    case 'neutral':     return 'bg-muted/50 text-muted-foreground border-muted';
    case 'volatility':  return 'bg-amber-500/15 text-amber-400 border-amber-500/30';
    default:            return 'bg-muted/30 text-muted-foreground/70';
  }
}

// ──────────────── density helpers (spec items 1-6) ────────────────

/** James's TS palette — same as AlwaysOnFlagStrip for non-LEAN combos. */
const COMBO_PALETTE: Record<string, { bg: string; label: string } | null> = {
  URGENT:          { bg: '#FF5252', label: 'URGENT' },
  'A+ BULLISH':    { bg: '#00E676', label: 'A+ BULLISH' },
  'A+ BEARISH':    { bg: '#FF5252', label: 'A+ BEARISH' },
  'SQUEEZE SETUP': { bg: '#d08030', label: 'SQUEEZE' },
  BATTLEGROUND:    { bg: '#e8d840', label: 'BATTLEGROUND' },
  'LEAN BULLISH':  null,
  'LEAN BEARISH':  null,
  NEUTRAL:         null,
};

function comboSeverity(combo: GexComboVerdict | null | undefined): number {
  switch (combo) {
    case 'URGENT':         return 95;
    case 'A+ BULLISH':     return 85;
    case 'A+ BEARISH':     return 85;
    case 'SQUEEZE SETUP':  return 70;
    case 'BATTLEGROUND':   return 55;
    default:               return 0;
  }
}

function attentionTier(score: number): { bar: string; label: string } {
  if (score >= 80) return { bar: 'bg-red-500',    label: 'critical' };
  if (score >= 60) return { bar: 'bg-orange-500', label: 'hot' };
  if (score >= 30) return { bar: 'bg-amber-500',  label: 'warm' };
  return               { bar: 'bg-muted-foreground/40', label: 'quiet' };
}

function fmtMoneyShort(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

/**
 * 1) Attention meter — top-right 0–100 bar, tier color. Tooltip explains the
 * source (combo verdict or attention stream score, whichever wins).
 */
const AttentionMeter = memo(function AttentionMeter({
  score,
  comboVerdict,
}: {
  score: number;
  comboVerdict: GexComboVerdict | null;
}) {
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const tier = attentionTier(clamped);
  const tipText = comboScoreReason(score, comboVerdict);
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className="flex flex-col items-end gap-0.5 cursor-help"
            aria-label={`attention ${clamped}`}
          >
            <span className="text-[9px] font-mono tabular-nums text-muted-foreground/80 leading-none">
              {clamped}
            </span>
            <div className="w-10 h-1 rounded-full bg-muted/40 overflow-hidden">
              <div
                className={`h-full ${tier.bar} transition-all`}
                style={{ width: `${clamped}%` }}
              />
            </div>
          </div>
        </TooltipTrigger>
        <TooltipContent side="left" className="bg-black/95 border-white/10 text-white px-2 py-1 text-[10px]">
          {tipText}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
});

function comboScoreReason(score: number, combo: GexComboVerdict | null): string {
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  if (combo && COMBO_PALETTE[combo]) {
    return `attention ${clamped} — ${COMBO_PALETTE[combo]?.label} converging signals`;
  }
  return `attention ${clamped} — recent obs/flag activity`;
}

/**
 * 2) Combo verdict pill — non-LEAN only. Click → open LinkGex Deep Sheet.
 */
const ComboPill = memo(function ComboPill({
  combo,
  ticker,
  onOpenDeep,
}: {
  combo: GexComboVerdict;
  ticker: string;
  onOpenDeep?: (t: string) => void;
}) {
  const palette = COMBO_PALETTE[combo];
  if (!palette) return null;
  return (
    <button
      type="button"
      onClick={() => onOpenDeep?.(ticker)}
      className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-bold tracking-wide hover:brightness-110 focus:outline-none focus:ring-1 focus:ring-white/30 transition-all"
      style={{ background: palette.bg, color: '#000' }}
      aria-label={`${ticker} ${palette.label} — open deep view`}
    >
      {palette.label}
    </button>
  );
});

/**
 * 3) Cluster badges — sweeps / DP / γflip. Hover reveals sum premium / notional.
 * Unicode glyphs only (no new lucide icons per spec constraint).
 */
const ClusterBadges = memo(function ClusterBadges({
  density,
}: {
  density: TickerDensityEntry;
}) {
  const items: Array<{ key: string; glyph: string; count: string; tip: string; cls: string }> = [];
  if (density.sweeps.count > 0) {
    const sideLabel = density.sweeps.lastSide ?? 'mixed';
    items.push({
      key: 'sweeps',
      glyph: '◉',
      count: String(density.sweeps.count),
      tip: `${density.sweeps.count} sweep${density.sweeps.count === 1 ? '' : 's'} today · ${fmtMoneyShort(density.sweeps.premium)} · ${sideLabel}`,
      cls:
        density.sweeps.lastSide === 'call'
          ? 'text-green-400'
          : density.sweeps.lastSide === 'put'
          ? 'text-red-400'
          : 'text-violet-400',
    });
  }
  if (density.dps.count > 0) {
    items.push({
      key: 'dp',
      glyph: '◼',
      count: String(density.dps.count),
      tip: `${density.dps.count} dark-pool print${density.dps.count === 1 ? '' : 's'} today · ${fmtMoneyShort(density.dps.notional)}`,
      cls: 'text-sky-400',
    });
  }
  if (density.regimeFlipped) {
    items.push({
      key: 'flip',
      glyph: 'γ',
      count: 'flip',
      tip: 'gamma regime inverted today',
      cls: 'text-yellow-400',
    });
  }
  if (items.length === 0) return null;
  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex items-center gap-1.5 text-[10px] leading-none">
        {items.map(it => (
          <Tooltip key={it.key}>
            <TooltipTrigger asChild>
              <span
                className={`inline-flex items-center gap-0.5 cursor-help ${it.cls}`}
                aria-label={it.tip}
              >
                <span className="font-bold">{it.glyph}</span>
                <span className="font-mono tabular-nums text-foreground/85">{it.count}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="bg-black/95 border-white/10 text-white px-2 py-1 text-[10px]">
              {it.tip}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  );
});

/**
 * 4) Intraday price sparkline — ~30px tall, full width. Sourced from
 * today's ct_heartbeats._snapshot.per_ticker[T].price (one point per HB).
 * Falls back to flat line at current price if history is empty.
 */
const PriceSparkline = memo(function PriceSparkline({
  points,
  currentPrice,
}: {
  points: number[];
  currentPrice: number | null;
}) {
  const height = 30;
  const width = 200; // viewBox — scales via preserveAspectRatio='none'
  if (!points || points.length < 2) {
    // Flat line at current price (or centered dash if no price).
    const y = height / 2;
    return (
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="w-full h-[30px]"
        aria-label="price timeline unavailable"
      >
        <line
          x1={0}
          x2={width}
          y1={y}
          y2={y}
          stroke="currentColor"
          strokeWidth={1}
          className="text-muted-foreground/30"
          strokeDasharray="2 3"
        />
        {currentPrice != null && (
          <circle cx={width - 2} cy={y} r={1.5} className="fill-muted-foreground/50" />
        )}
      </svg>
    );
  }

  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const path = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * width;
      const y = height - ((p - min) / range) * (height - 4) - 2;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  const first = points[0];
  const last = points[points.length - 1];
  const positive = last >= first;
  const colorClass = positive ? 'text-green-500' : 'text-red-500';

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="w-full h-[30px]"
      aria-label={`intraday price ${positive ? 'up' : 'down'}`}
    >
      <path d={path} fill="none" stroke="currentColor" strokeWidth={1.25} className={colorClass} />
    </svg>
  );
});

/**
 * 5) Cumulative call/put net strip — 2px bar, green if net calls dominate, red
 * if puts dominate. Width proportional to whichever side wins (as share of
 * total absolute premium).
 */
const NetPremStrip = memo(function NetPremStrip({
  lastPoint,
}: {
  lastPoint: NetPremCumTicker['points'][number] | null;
}) {
  if (!lastPoint) {
    return <div className="w-full h-[2px] bg-muted/30" aria-label="no net-premium data" />;
  }
  const callP = lastPoint.cum_call_prem ?? 0;
  const putP = lastPoint.cum_put_prem ?? 0;
  const total = Math.abs(callP) + Math.abs(putP);
  if (total === 0) {
    return <div className="w-full h-[2px] bg-muted/30" aria-label="no net-premium today" />;
  }
  const callsDominate = callP >= putP;
  const dominantShare = (callsDominate ? callP : putP) / total; // 0..1
  const pct = Math.round(dominantShare * 100);
  const cls = callsDominate ? 'bg-green-500' : 'bg-red-500';
  const label = callsDominate ? 'calls dominant' : 'puts dominant';
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="w-full h-[2px] bg-muted/20 cursor-help" aria-label={label}>
            <div
              className={`h-full ${cls} transition-all`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="bg-black/95 border-white/10 text-white px-2 py-1 text-[10px]">
          {`${label} · calls ${fmtMoneyShort(callP)} · puts ${fmtMoneyShort(putP)}`}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
});

/**
 * 6) Claude's last note — truncated italic caption. Click → scrolls to
 * EventFeed (DOM id 'co-event-feed').
 */
const LastNote = memo(function LastNote({
  note,
}: {
  note: TickerDensityEntry['lastNote'];
}) {
  const scroll = useCallback(() => {
    if (typeof document === 'undefined') return;
    document.getElementById('co-event-feed')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);
  if (!note || !note.text) return null;
  return (
    <button
      type="button"
      onClick={scroll}
      className="w-full text-left text-[10px] italic text-muted-foreground/80 hover:text-foreground/90 truncate transition-colors"
      title={note.text}
    >
      <span className="text-muted-foreground/60 uppercase tracking-wider not-italic mr-1">
        {note.kind === 'alert' ? 'alert' : note.kind === 'flag' ? 'flag' : 'obs'}
      </span>
      “{note.text}”
    </button>
  );
});

// Extract today's per-ticker price series from session heartbeats.
function buildPriceHistory(heartbeats: Heartbeat[] | undefined): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  if (!heartbeats) return out;
  for (const hb of heartbeats) {
    const snap = (hb.current_reads as Record<string, unknown> | undefined)?._snapshot as
      | Record<string, unknown>
      | undefined;
    const perTicker = (snap?.per_ticker as Record<string, { price?: number | null }> | undefined) ?? {};
    for (const [ticker, state] of Object.entries(perTicker)) {
      const p = state?.price;
      if (typeof p === 'number' && Number.isFinite(p)) {
        (out[ticker] ??= []).push(p);
      }
    }
  }
  return out;
}

function RegimeLine({ regime, price, flip }: { regime?: 'positive' | 'negative' | 'unknown'; price: number | null; flip: number | null }) {
  if (!regime || regime === 'unknown' || price == null || flip == null) return null;
  const pos = regime === 'positive';
  const distPct = ((price - flip) / flip) * 100;
  return (
    <div className={`flex items-center justify-between text-[10px] mb-1 px-1 py-0.5 rounded ${pos ? 'bg-green-500/10 text-green-400' : 'bg-amber-500/10 text-amber-400'}`}>
      <span className="font-semibold uppercase tracking-wider">
        {pos ? '+Γ · mean-revert' : '−Γ · momentum'}
      </span>
      <span className="text-foreground/60">
        {distPct >= 0 ? '+' : ''}{distPct.toFixed(1)}% vs flip
      </span>
    </div>
  );
}

function WallsRow({ label, walls, price, kind }: { label: string; walls: Wall[]; price: number | null; kind: 'call' | 'put' }) {
  if (walls.length === 0) {
    return <div className="text-muted-foreground/50">{label}: —</div>;
  }
  const color = kind === 'call' ? 'text-orange-400' : 'text-blue-400';
  return (
    <div className="flex items-center gap-1 overflow-hidden">
      <span className={`text-muted-foreground shrink-0 w-8 ${color}`}>{label}</span>
      {walls.slice(0, 3).map((w, i) => {
        const dist = price ? ((w.strike - price) / price) * 100 : 0;
        return (
          <span key={i} className="flex items-baseline gap-0.5 shrink-0">
            <span className="text-foreground/90 font-medium">${fmtPrice(w.strike)}</span>
            <span className="text-muted-foreground/60 text-[9px]">
              {dist >= 0 ? '+' : ''}{dist.toFixed(1)}%
            </span>
          </span>
        );
      })}
    </div>
  );
}

interface TickerGridProps {
  /**
   * Optional: parent-owned handler that opens the shared LinkGex Deep Sheet.
   * Wired from CommandStation. When omitted, combo pills are rendered but
   * do nothing on click (graceful fallback).
   */
  onOpenDeep?: (ticker: string) => void;
}

export function TickerGrid({ onOpenDeep }: TickerGridProps = {}) {
  const { data: heartbeat } = useLatestHeartbeat();
  const { data: sessionHeartbeats } = useSessionHeartbeats();
  const { data: theses } = useTheses();
  const { data: events } = useRecentEvents(10);
  const { data: density } = useTickerDensity();
  // Reuses cached gex-radar query (no extra network round trip) — same key
  // shape AlwaysOnFlagStrip / ColdOpen use.
  const { data: gex } = useGexRadar(['SPY', 'QQQ', 'IWM'], 30);
  const { data: netPrem } = useNetPremiumCumulative();
  const [showAll, setShowAll] = useState(false);

  // Per-ticker verdicts map (only non-null for radar tickers; others get null).
  const gexByTicker = useMemo(() => {
    const m = new Map<string, GexRadarTicker>();
    for (const t of gex?.tickers ?? []) m.set(t.ticker.toUpperCase(), t);
    return m;
  }, [gex]);

  // Per-ticker price history from session heartbeats — single pass.
  const priceHistoryByTicker = useMemo(() => buildPriceHistory(sessionHeartbeats), [sessionHeartbeats]);

  // Per-ticker latest net-prem cumulative point.
  const netPremByTicker = useMemo(() => {
    const m = new Map<string, NetPremCumTicker['points'][number] | null>();
    for (const t of netPrem?.tickers ?? []) {
      const last = t.points && t.points.length > 0 ? t.points[t.points.length - 1] : null;
      m.set(t.ticker.toUpperCase(), last);
    }
    return m;
  }, [netPrem]);

  const allTickers = useMemo(() => {
    const snap = (heartbeat?.current_reads as Record<string, unknown> | undefined)?._snapshot as Record<string, unknown> | undefined;
    const perTicker = (snap?.per_ticker ?? {}) as Record<string, CondensedTicker>;
    const thesesMap = new Map<string, ReturnType<typeof Object>>();
    for (const t of theses ?? []) thesesMap.set(t.instrument, t);
    return Object.entries(perTicker)
      .sort(([a], [b]) => {
        const groupOrder = ['Index', 'Mag7', 'Macro'];
        const ga = groupOrder.indexOf(LABELS[a]?.group ?? '');
        const gb = groupOrder.indexOf(LABELS[b]?.group ?? '');
        if (ga !== gb) return ga - gb;
        return a.localeCompare(b);
      })
      .map(([ticker, state]) => ({ ticker, state, thesis: thesesMap.get(ticker) as { direction?: string; conviction?: number; up_case?: string; down_case?: string; watching?: string | null } | undefined }));
  }, [heartbeat, theses]);

  /**
   * Relevance filter: show only tickers that are (a) mentioned in any active
   * observation/flag/alert OR (b) currently in negative gamma regime (momentum
   * / dealer-hedging cascade risk). If the filter yields zero, fall back to
   * indexes. "Show all 12" toggle reveals the full grid.
   */
  const mentioned = useMemo(() => {
    const s = new Set<string>();
    for (const e of events ?? []) {
      for (const i of e.instruments ?? []) s.add(i.toUpperCase());
    }
    return s;
  }, [events]);

  const tickers = useMemo(() => {
    if (showAll) return allTickers;
    const filtered = allTickers.filter(({ ticker, state }) =>
      mentioned.has(ticker) || state.regime === 'negative'
    );
    if (filtered.length === 0) {
      const indexOnly = allTickers.filter(({ ticker }) => INDEX_FALLBACK.has(ticker));
      return indexOnly.length > 0 ? indexOnly : allTickers;
    }
    return filtered;
  }, [allTickers, mentioned, showAll]);

  if (allTickers.length === 0) {
    return (
      <Card className="p-6 text-center text-muted-foreground text-sm">
        No ticker state yet. Watcher cron fires next at weekday 13:00 UTC.
      </Card>
    );
  }

  const hidden = allTickers.length - tickers.length;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
        <span>
          {showAll
            ? `Showing all ${allTickers.length} watched`
            : `Showing ${tickers.length} of ${allTickers.length} — mentioned in reads or short-gamma`}
        </span>
        {(hidden > 0 || showAll) && (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto h-6 px-2 text-[10px] uppercase tracking-wider"
            onClick={() => setShowAll(v => !v)}
          >
            {showAll ? 'trim to relevant' : `show all ${allTickers.length}`}
          </Button>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
      {tickers.map(({ ticker, state, thesis }) => {
        const T = ticker.toUpperCase();
        const label = LABELS[ticker];
        const price = state.price;
        const tickerDensity = density?.[T] ?? null;
        const gexRow = gexByTicker.get(T) ?? null;
        const combo = gexRow?.verdicts?.combo ?? null;
        const comboIsStructural = combo ? !!COMBO_PALETTE[combo] : false;

        // Attention = max(stream score, combo severity) so a strong combo
        // (e.g. A+ BULLISH) always reads as "loud" even without observation
        // chatter yet.
        const attentionRaw = Math.max(
          tickerDensity?.maxAttention ?? 0,
          comboSeverity(combo),
        );

        const priceHistory = priceHistoryByTicker[T] ?? priceHistoryByTicker[ticker] ?? [];
        const netPremPoint = netPremByTicker.get(T) ?? null;

        return (
          <Card key={ticker} className="p-3 hover:border-primary/40 transition-colors">
            <div className="flex items-baseline justify-between mb-1">
              <div className="flex items-baseline gap-2 min-w-0">
                <Link
                  to={`/ticker/${T}`}
                  className="text-lg font-bold text-foreground hover:text-primary focus:outline-none focus:ring-2 focus:ring-white/30 rounded-sm transition-colors"
                  title={`Open ${T} terminal`}
                >
                  {ticker}
                </Link>
                {label && (
                  <span className="text-[10px] text-muted-foreground/80 uppercase tracking-wide truncate">
                    {label.group}{label.note ? ` · ${label.note}` : ''}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-base font-semibold text-foreground">${fmtPrice(price)}</span>
                <AttentionMeter score={attentionRaw} comboVerdict={combo} />
              </div>
            </div>

            {/* 2) Combo verdict pill + 3) cluster badges — tight row under header */}
            {(comboIsStructural || tickerDensity) && (
              <div className="flex items-center gap-2 mb-1.5 min-h-[14px]">
                {comboIsStructural && combo && (
                  <ComboPill combo={combo} ticker={T} onOpenDeep={onOpenDeep} />
                )}
                {tickerDensity && <ClusterBadges density={tickerDensity} />}
              </div>
            )}

            <RegimeLine regime={state.regime} price={state.price} flip={state.gamma_flip} />

            <GexMiniChart strikes={state.near_atm_strikes ?? []} price={price} flip={state.gamma_flip} />

            <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px] mt-1.5 mb-1">
              <WallsRow label="Calls" walls={state.call_walls ?? (state.call_wall ? [{strike: state.call_wall, gex: 0, distance_pct: 0}] : [])} price={state.price} kind="call" />
              <WallsRow label="Puts" walls={state.put_walls ?? (state.put_wall ? [{strike: state.put_wall, gex: 0, distance_pct: 0}] : [])} price={state.price} kind="put" />
            </div>

            <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
              <span>Flip <span className="text-foreground/80 font-medium">${fmtPrice(state.gamma_flip)}</span></span>
              <span>Net Γ <span className={`font-medium ${(state.net_gamma_oi ?? 0) >= 0 ? 'text-green-500' : 'text-red-500'}`}>{fmtLarge(state.net_gamma_oi)}</span></span>
            </div>

            {thesis ? (
              <div className="space-y-1 pt-2 border-t border-border">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${directionColor(thesis.direction)}`}>
                    {thesis.direction?.toUpperCase()}
                  </Badge>
                  {thesis.conviction != null && (
                    <span className="text-[10px] text-muted-foreground">conv {thesis.conviction}/5</span>
                  )}
                </div>
                {thesis.up_case && (
                  <div className="text-[11px] text-green-400/90">↑ {thesis.up_case}</div>
                )}
                {thesis.down_case && (
                  <div className="text-[11px] text-red-400/90">↓ {thesis.down_case}</div>
                )}
              </div>
            ) : (
              <div className="text-[10px] text-muted-foreground/60 italic pt-2 border-t border-border">
                no thesis yet
              </div>
            )}

            {/* 4) Intraday price sparkline */}
            <div className="mt-2">
              <PriceSparkline points={priceHistory} currentPrice={price} />
            </div>

            {/* 5) Cumulative call/put net strip (2px) */}
            <NetPremStrip lastPoint={netPremPoint} />

            {/* 6) Claude's last note — hidden if none */}
            {tickerDensity?.lastNote && (
              <div className="pt-1.5">
                <LastNote note={tickerDensity.lastNote} />
              </div>
            )}
          </Card>
        );
      })}
      </div>
    </div>
  );
}
