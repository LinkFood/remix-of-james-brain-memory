/**
 * MarketBanner — Market State banner at top of CommandStation.
 *
 * ─── AUDIT (2026-04-17) ────────────────────────────────────────────────────
 * What the previous banner displayed:
 *   - SPX regime pill (+/-Γ + %-distance vs flip)
 *   - Claude's status_line (one line)
 *   - Scalar grid: SPX price, Gamma Flip, Net Γ, Tide (C-P), Call Walls × 3,
 *     Put Walls × 3
 *   - GexMiniChart (SPX near-ATM distribution)
 *   - "last pulse" timestamp
 *
 * Data available in _snapshot but NOT shown:
 *   - per_ticker[SPY|QQQ|IWM|…] — full price + wall + regime state for every
 *     watched ticker. The banner was SPX-only while the snapshot had ~12
 *     tickers already condensed.
 *   - per_ticker[T].put_call_volume_ratio + day_put_call_ratio — real P/C.
 *   - spx_macro.near_atm_strike_count / raw_strike_count (diagnostic, skip).
 *   - market_tide.timestamp (tide freshness, skip — we have last-pulse).
 *
 * Data available elsewhere (no new UW calls) but not wired in:
 *   - ct_heartbeats history for today → (a) first-of-session price anchor for
 *     Δ vs open, (b) regime-flip detection across the session.
 *   - ct_theses.updated_at for SPX/SPY → "posture since" clock on the macro
 *     read (how long Claude's current thesis has held).
 *   - ct_attention_stream top row last 30min → HOT pill surfacing Claude's
 *     highest-salience recent event as a one-line callout.
 *
 * What was cramped / hard to read at a glance:
 *   - The regime pill + status_line + 6-column scalar grid + mini-chart stacked
 *     vertically pushed total height. The "critical read" (what is SPX doing,
 *     what is Claude watching, what just fired) wasn't visible together in
 *     <1s — eyes had to scan top-to-bottom.
 *   - SPY/QQQ/IWM prices — the three tickers a trader actually looks at first
 *     — were completely absent from the banner. They lived only in TickerGrid
 *     further down the page.
 *   - Walls were shown as bare strike numbers with no % distance, duplicating
 *     the info that TickerGrid already renders more clearly.
 *
 * What a trader wants FIRST glance (in priority order):
 *   1. Index tape — SPY / QQQ / IWM / SPX price + Δ-since-open
 *   2. Regime — are we above/below gamma flip? Was it breached intraday?
 *   3. Claude's macro read (status_line) + how long it's been this posture
 *   4. HOT — the single highest-attention event in the last 30min
 *   5. Key levels — gamma flip strike, top call/put wall
 *
 * Missing data that would require NEW UW calls (for James to sequence later):
 *   - VIX level + 1d change (NOT in _snapshot today — need market/state or
 *     similar UW endpoint, or a poll of a vix chain).
 *   - Breadth / advance-decline across the S&P (requires UW market-breadth
 *     or a separate dataset).
 *   - Sector leader / laggard (needs sector ETFs in the watchlist + a rank).
 *   - Put/Call ratio for SPX (spx_macro has no PCR today — only per_ticker
 *     instruments with options_volume calls have PCR populated).
 *
 * ─── IMPROVEMENTS MADE ──────────────────────────────────────────────────────
 *   1. Three-column layout: TAPE | REGIME | CLAUDE'S READ — horizontal density
 *      replaces vertical stacking. Same overall vertical footprint.
 *   2. TAPE segment: SPX + SPY/QQQ/IWM prices with Δ-since-open (first
 *      heartbeat of session as anchor). tabular-nums, coloured by sign.
 *   3. REGIME segment: gamma flip strike, top CW1 + PW1 with % distance,
 *      Net Γ, and a "FLIP BREACHED" pill if the session toggled regime state
 *      (crossed gamma flip intraday — high-signal event for dealer flow).
 *   4. CLAUDE'S READ segment: status_line + "posture XhYm" chip anchored to
 *      SPX/SPY thesis updated_at, plus the HOT pill from ct_attention_stream
 *      (top attention_score ≥ 60 in last 30min) with kind-badge.
 *   5. GexMiniChart moved inside REGIME as a compact inline bar — same
 *      component, smaller visual weight so the three segments stay equal.
 *
 * No new UW calls. All data sourced from existing hooks + ct_heartbeats /
 * ct_theses / ct_attention_stream tables.
 * ───────────────────────────────────────────────────────────────────────────
 */
import { useMemo } from 'react';
import {
  useLatestHeartbeat,
  useSessionHeartbeats,
  useTheses,
  useTopAttention,
} from '@/hooks/useCoTraderData';
import { Card } from '@/components/ui/card';
import { Activity, TrendingUp, TrendingDown, Minus, Flame, Clock, AlertTriangle } from 'lucide-react';
import { GexMiniChart } from './GexMiniChart';

interface Wall { strike: number; gex: number; distance_pct: number }

interface CondensedMacro {
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
  near_atm_strikes?: Array<{ strike: number; call_gex: number; put_gex: number; net: number }>;
}

interface CondensedTicker extends CondensedMacro {
  ticker: string;
}

type Snapshot = {
  per_ticker?: Record<string, CondensedTicker>;
  spx_macro?: CondensedMacro;
  market_tide?: {
    net_call_premium: number | null;
    net_put_premium: number | null;
    net_volume: number | null;
    timestamp: string | null;
  };
};

// ──────── formatters ────────

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
  return n.toFixed(2);
}

function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

function relativeTime(iso: string): string {
  const d = Date.now() - Date.parse(iso);
  const m = Math.floor(d / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function postureDuration(iso: string): string {
  const d = Date.now() - Date.parse(iso);
  const m = Math.floor(d / 60_000);
  if (m < 1) return 'fresh';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem ? `${h}h${rem}m` : `${h}h`;
  const days = Math.floor(h / 24);
  return `${days}d${h % 24}h`;
}

function deltaColor(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || Math.abs(n) < 0.01) return 'text-muted-foreground';
  return n > 0 ? 'text-green-500' : 'text-red-500';
}

// ──────── tape row ────────

function TapeCell({ label, price, delta }: { label: string; price: number | null; delta: number | null }) {
  return (
    <div className="flex items-baseline justify-between gap-2 min-w-0">
      <span className="text-[10px] text-muted-foreground uppercase tracking-wider shrink-0">{label}</span>
      <div className="flex items-baseline gap-1.5 font-mono tabular-nums">
        <span className="text-foreground font-semibold text-sm">{fmtPrice(price)}</span>
        <span className={`text-[10px] ${deltaColor(delta)}`}>{fmtPct(delta)}</span>
      </div>
    </div>
  );
}

// ──────── main ────────

const TAPE_TICKERS: Array<{ key: string; label: string }> = [
  { key: '__SPX__', label: 'SPX' },
  { key: 'SPY', label: 'SPY' },
  { key: 'QQQ', label: 'QQQ' },
  { key: 'IWM', label: 'IWM' },
];

export function MarketBanner() {
  const { data: heartbeat, isLoading } = useLatestHeartbeat();
  const { data: sessionBeats } = useSessionHeartbeats();
  const { data: theses } = useTheses();
  const { data: hot } = useTopAttention(30, 60);

  const snap = (heartbeat?.current_reads as Record<string, unknown> | undefined)?._snapshot as Snapshot | undefined;
  const macro = snap?.spx_macro;
  const perTicker = snap?.per_ticker ?? {};
  const tide = snap?.market_tide;

  const netPremium = (tide?.net_call_premium ?? 0) - (tide?.net_put_premium ?? 0);
  const tideDirection: 'bull' | 'bear' | 'neutral' =
    Math.abs(netPremium) < 10_000_000 ? 'neutral' : netPremium > 0 ? 'bull' : 'bear';

  const flipDistPct = macro?.price && macro?.gamma_flip
    ? ((macro.price - macro.gamma_flip) / macro.gamma_flip) * 100
    : null;
  const regime = macro?.regime ?? 'unknown';

  // ─── session anchors: first-of-session price per ticker + regime history ───
  const { anchors, flipBreached } = useMemo(() => {
    const anchors: Record<string, number | null> = {};
    const regimes: Array<'positive' | 'negative' | 'unknown'> = [];
    for (const hb of sessionBeats ?? []) {
      const s = (hb.current_reads as Record<string, unknown> | undefined)?._snapshot as Snapshot | undefined;
      if (!s) continue;
      // first non-null spx price
      const spxP = s.spx_macro?.price ?? null;
      if (anchors.__SPX__ === undefined && spxP != null) anchors.__SPX__ = spxP;
      for (const [t, st] of Object.entries(s.per_ticker ?? {})) {
        if (anchors[t] === undefined && st.price != null) anchors[t] = st.price;
      }
      if (s.spx_macro?.regime) regimes.push(s.spx_macro.regime);
    }
    const sawPositive = regimes.includes('positive');
    const sawNegative = regimes.includes('negative');
    const flipBreached = sawPositive && sawNegative;
    return { anchors, flipBreached };
  }, [sessionBeats]);

  const priceFor = (key: string): number | null => {
    if (key === '__SPX__') return macro?.price ?? null;
    return perTicker[key]?.price ?? null;
  };
  const deltaFor = (key: string): number | null => {
    const p = priceFor(key);
    const a = anchors[key];
    if (p == null || a == null || a === 0) return null;
    return ((p - a) / a) * 100;
  };

  // ─── posture age from ct_theses ───
  const macroThesis = useMemo(() => {
    if (!theses) return null;
    // prefer SPX, fall back to SPY
    return (
      theses.find(t => t.instrument === 'SPX') ??
      theses.find(t => t.instrument === 'SPY') ??
      null
    );
  }, [theses]);

  return (
    <Card className="p-4 bg-gradient-to-br from-muted/50 to-background border-border">
      <div className="flex items-center gap-2 mb-3">
        <Activity className="w-4 h-4 text-primary" />
        <h2 className="text-sm font-semibold text-foreground">Market State</h2>
        {heartbeat && (
          <span className="text-xs text-muted-foreground ml-auto font-mono tabular-nums">
            pulse {relativeTime(heartbeat.created_at)}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="text-muted-foreground text-sm">loading…</div>
      ) : !heartbeat ? (
        <div className="text-muted-foreground text-sm">no heartbeat yet — cron fires weekdays 13:00-20:59 UTC</div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[1.1fr_1.4fr_1.5fr] gap-3">

          {/* ═══ SEGMENT 1 · TAPE ═══ */}
          <div className="space-y-1.5 border-r-0 lg:border-r border-border/60 lg:pr-3">
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Tape</span>
              <span className="text-[9px] text-muted-foreground/60">Δ since open</span>
            </div>
            <div className="space-y-1">
              {TAPE_TICKERS.map(({ key, label }) => (
                <TapeCell key={key} label={label} price={priceFor(key)} delta={deltaFor(key)} />
              ))}
            </div>
            {tide && (
              <div className="flex items-center justify-between gap-2 pt-1.5 mt-1 border-t border-border/40">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Tide</span>
                <span className={`text-[11px] font-mono tabular-nums font-semibold flex items-center gap-1 ${tideDirection === 'bull' ? 'text-green-500' : tideDirection === 'bear' ? 'text-red-500' : 'text-muted-foreground'}`}>
                  {tideDirection === 'bull' ? <TrendingUp className="w-3 h-3" /> : tideDirection === 'bear' ? <TrendingDown className="w-3 h-3" /> : <Minus className="w-3 h-3" />}
                  {fmtLarge(netPremium)}
                </span>
              </div>
            )}
          </div>

          {/* ═══ SEGMENT 2 · REGIME ═══ */}
          <div className="space-y-1.5 border-r-0 lg:border-r border-border/60 lg:pr-3">
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Regime · SPX</span>
              {flipBreached && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0 rounded text-[9px] font-semibold uppercase tracking-wider bg-amber-500/15 text-amber-400 border border-amber-500/30">
                  <AlertTriangle className="w-2.5 h-2.5" />
                  flip breached
                </span>
              )}
            </div>
            {regime !== 'unknown' && flipDistPct !== null ? (
              <div className={`flex items-center justify-between px-2 py-1 rounded-md text-xs font-semibold ${
                regime === 'positive'
                  ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                  : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
              }`}>
                <span className="font-mono">
                  {regime === 'positive' ? '+Γ · mean-revert' : '−Γ · momentum'}
                </span>
                <span className="text-foreground/70 font-mono tabular-nums text-[11px]">
                  {fmtPct(flipDistPct)} vs flip
                </span>
              </div>
            ) : (
              <div className="text-xs text-muted-foreground px-2 py-1">regime unknown</div>
            )}

            <div className="grid grid-cols-3 gap-2 text-[10px] font-mono tabular-nums pt-1">
              <div>
                <div className="text-muted-foreground uppercase tracking-wider text-[9px]">Flip</div>
                <div className="text-foreground font-semibold">{fmtPrice(macro?.gamma_flip ?? null)}</div>
              </div>
              <div>
                <div className="text-orange-400/80 uppercase tracking-wider text-[9px]">CW1</div>
                <div className="text-foreground font-semibold">
                  {fmtPrice(macro?.call_walls?.[0]?.strike ?? macro?.call_wall ?? null)}
                  {macro?.call_walls?.[0]?.distance_pct != null && (
                    <span className="text-muted-foreground/60 ml-1 text-[9px]">
                      {fmtPct(macro.call_walls[0].distance_pct, 1)}
                    </span>
                  )}
                </div>
              </div>
              <div>
                <div className="text-blue-400/80 uppercase tracking-wider text-[9px]">PW1</div>
                <div className="text-foreground font-semibold">
                  {fmtPrice(macro?.put_walls?.[0]?.strike ?? macro?.put_wall ?? null)}
                  {macro?.put_walls?.[0]?.distance_pct != null && (
                    <span className="text-muted-foreground/60 ml-1 text-[9px]">
                      {fmtPct(macro.put_walls[0].distance_pct, 1)}
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between text-[10px] pt-1">
              <span className="text-muted-foreground uppercase tracking-wider text-[9px]">Net Γ</span>
              <span className={`font-mono tabular-nums font-semibold ${(macro?.net_gamma_oi ?? 0) >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                {fmtLarge(macro?.net_gamma_oi ?? null)}
              </span>
            </div>

            <div className="pt-1">
              <GexMiniChart
                strikes={macro?.near_atm_strikes ?? []}
                price={macro?.price ?? null}
                flip={macro?.gamma_flip ?? null}
              />
            </div>
          </div>

          {/* ═══ SEGMENT 3 · CLAUDE'S READ ═══ */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Claude's read</span>
              {macroThesis && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0 rounded text-[9px] font-mono tabular-nums bg-muted/50 text-muted-foreground border border-border">
                  <Clock className="w-2.5 h-2.5" />
                  posture {postureDuration(macroThesis.updated_at)}
                </span>
              )}
            </div>
            <p className="text-xs text-foreground/90 font-medium leading-relaxed line-clamp-3">
              {heartbeat.status_line}
            </p>

            {hot && (
              <div className="flex items-start gap-1.5 px-2 py-1.5 rounded-md bg-red-500/8 border border-red-500/25 mt-1">
                <Flame className="w-3 h-3 text-red-400 mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-wider">
                    <span className="text-red-400 font-semibold">hot · {hot.kind}</span>
                    <span className="text-muted-foreground font-mono tabular-nums">
                      {hot.attention_score}/100 · {relativeTime(hot.created_at)}
                    </span>
                  </div>
                  <div className="text-[11px] text-foreground/90 leading-snug line-clamp-2 mt-0.5">
                    {hot.summary ?? '—'}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
