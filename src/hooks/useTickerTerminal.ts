/**
 * useTickerTerminal — single-round-trip drill-down feed for <TickerTerminal />.
 *
 * Accepts ANY ticker symbol (not just the watched 12). Missing data → empty
 * results; the page renders the same, just with empty strips for whatever the
 * watcher doesn't cover.
 *
 * One batched Promise.all across 7 independent ct_* reads, 30s refresh. No
 * new UW calls here — LinkGexDeep owns the only UW surface on the page
 * (option-contracts + spot-exposures, 2 calls).
 */
import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type {
  Heartbeat,
  FlowAlert,
  DarkPoolPrint,
  NewsItem,
  CtTradeRow,
  CtEvent,
  CtSelfAssessment,
  TradeSetup,
  ExpectedMove,
} from './useCoTraderData';

// ─── types ──────────────────────────────────────────────────────────────

/** Per-heartbeat snapshot of this ticker's live state (from _snapshot.per_ticker[T]). */
export interface TickerHeartbeatPoint {
  created_at: string;
  price: number | null;
  regime: 'positive' | 'negative' | 'unknown' | null;
  net_gamma_oi: number | null;
  gamma_flip: number | null;
  call_wall: number | null;
  put_wall: number | null;
}

/** One sample of the attention-history chart — rolled up per 15-min bucket. */
export interface AttentionPoint {
  /** Bucket start (ISO). */
  t: string;
  /** Max attention score in this bucket. */
  score: number;
  /** How many obs/flags/alerts fell in this bucket. */
  events: number;
}

export interface GradedEventRow {
  grade_id: string;
  subject_type: 'flag' | 'alert' | 'james_view';
  subject_id: string;
  verdict: 'right' | 'wrong' | 'ambiguous' | 'partial';
  actual_return_pct: number;
  actual_direction: 'bullish' | 'bearish' | 'flat';
  claimed_direction: string;
  graded_at: string;
  calibration_delta: number | null;
}

export interface TickerTerminalData {
  /** Ticker as entered, upper-cased. */
  ticker: string;

  /** True when the watcher has at least one heartbeat snapshot for this ticker. */
  isWatched: boolean;

  /** Header / sparkline. */
  header: {
    /** Latest price from the newest heartbeat that mentions this ticker. */
    price: number | null;
    /** First price of today's session, for daily change. */
    sessionOpen: number | null;
    /** price - sessionOpen. */
    change: number | null;
    /** (price - sessionOpen) / sessionOpen * 100. */
    changePct: number | null;
    /** Current gamma regime from the latest snapshot. */
    regime: 'positive' | 'negative' | 'unknown' | null;
    /** ISO of the latest snapshot read. */
    updatedAt: string | null;
  };

  /** Today's heartbeat samples for this ticker — drives the sparkline. */
  sparkline: TickerHeartbeatPoint[];

  /** 7d attention rollup buckets (oldest → newest). */
  attentionHistory: AttentionPoint[];

  /** Recent flow alerts for this ticker (last 30). */
  flowAlerts: FlowAlert[];

  /** Recent dark-pool prints for this ticker (last 30). */
  darkPoolPrints: DarkPoolPrint[];

  /** Recent news analyses for this ticker (last 10). */
  news: NewsItem[];

  /** Graded alerts/flags on this ticker — past verdict timeline. */
  gradedAlerts: GradedEventRow[];

  /** Open paper-trade positions on this instrument. */
  openPositions: CtTradeRow[];

  /** Last 5 obs/flag/alerts mentioning this ticker — full glance. */
  recentReads: CtEvent[];
}

interface Options {
  /** Days back for attention history + graded alerts. Default 7. */
  daysBack?: number;
}

// ─── helpers ────────────────────────────────────────────────────────────

function toBucketKey(iso: string, bucketMinutes: number): string {
  const t = Date.parse(iso);
  const bucketMs = bucketMinutes * 60_000;
  const rounded = Math.floor(t / bucketMs) * bucketMs;
  return new Date(rounded).toISOString();
}

function extractHeartbeatPoint(
  hb: Heartbeat,
  T: string,
): TickerHeartbeatPoint | null {
  const snap = (hb.current_reads as Record<string, unknown> | undefined)?._snapshot as
    | Record<string, unknown>
    | undefined;
  const perTicker = (snap?.per_ticker as Record<string, Record<string, unknown>> | undefined) ?? {};
  const state = perTicker[T] ?? perTicker[T.toLowerCase()];
  if (!state) return null;
  const price = typeof state.price === 'number' ? (state.price as number) : null;
  if (price === null && state.regime == null) return null;
  return {
    created_at: hb.created_at,
    price,
    regime: (state.regime as TickerHeartbeatPoint['regime']) ?? null,
    net_gamma_oi: typeof state.net_gamma_oi === 'number' ? (state.net_gamma_oi as number) : null,
    gamma_flip: typeof state.gamma_flip === 'number' ? (state.gamma_flip as number) : null,
    call_wall: typeof state.call_wall === 'number' ? (state.call_wall as number) : null,
    put_wall: typeof state.put_wall === 'number' ? (state.put_wall as number) : null,
  };
}

/**
 * Batched fetch — 7 queries in one Promise.all. Returns organized-by-section.
 */
export function useTickerTerminal(
  rawTicker: string | undefined,
  { daysBack = 7 }: Options = {},
) {
  const ticker = (rawTicker ?? '').toUpperCase().trim();
  const qc = useQueryClient();

  // Realtime invalidation on new attention-producing rows (obs/flags/alerts)
  // and flow alerts so the terminal reflects fresh events between polls.
  useEffect(() => {
    if (!ticker) return;
    const chan = supabase
      .channel(`ct_ticker_terminal_${ticker}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ct_observations' }, () =>
        qc.invalidateQueries({ queryKey: ['ct_ticker_terminal', ticker] }),
      )
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ct_flags' }, () =>
        qc.invalidateQueries({ queryKey: ['ct_ticker_terminal', ticker] }),
      )
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ct_alerts' }, () =>
        qc.invalidateQueries({ queryKey: ['ct_ticker_terminal', ticker] }),
      )
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ct_flow_alerts' }, () =>
        qc.invalidateQueries({ queryKey: ['ct_ticker_terminal', ticker] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(chan);
    };
  }, [qc, ticker]);

  return useQuery<TickerTerminalData>({
    queryKey: ['ct_ticker_terminal', ticker, daysBack],
    enabled: !!ticker,
    refetchInterval: 30_000,
    staleTime: 15_000,
    queryFn: async () => {
      if (!ticker) {
        // Should not be reached (enabled gate), but keep the contract.
        return emptyData(ticker);
      }

      const now = Date.now();
      const todayStart = new Date(new Date().setUTCHours(0, 0, 0, 0)).toISOString();
      const attentionSince = new Date(now - daysBack * 86400_000).toISOString();
      const attentionSinceDate = attentionSince.slice(0, 10);

      // ── 7 parallel queries (+1 deferred grade fetch via ids) ──
      const [
        heartbeatsQ,   // 1. sparkline + header
        obsQ,          // 2a. attention history + recent reads (observations)
        flagsQ,        // 2b. attention history + recent reads (flags)
        alertsQ,       // 2c. attention history + recent reads (alerts)
        flowQ,         // 3. ct_flow_alerts
        dpQ,           // 4. ct_dark_pool_prints
        newsQ,         // 5. ct_news_analyses
        gradesQ,       // 6. ct_grades (joined to flags/alerts subject_ids)
        tradesQ,       // 7. ct_trades status=open
      ] = await Promise.all([
        supabase
          .from('ct_heartbeats')
          .select('id, status_line, watching, current_reads, created_at')
          .neq('prompt_version', 'mcp-verify')
          .gte('created_at', todayStart)
          .order('created_at', { ascending: true })
          .limit(300),
        supabase
          .from('ct_observations')
          .select('id, instruments, direction, glance, observation, self_assessment, attention_score, created_at')
          .contains('instruments', [ticker])
          .gte('created_at', attentionSince)
          .order('created_at', { ascending: false })
          .limit(300),
        supabase
          .from('ct_flags')
          .select('id, instruments, direction, conviction, horizon, horizon_end, glance, full_reasoning, self_assessment, trade_setup, expected_move, entry_prices, attention_score, created_at')
          .contains('instruments', [ticker])
          .gte('created_at', attentionSince)
          .order('created_at', { ascending: false })
          .limit(300),
        supabase
          .from('ct_alerts')
          .select('id, instruments, direction, conviction, horizon, horizon_end, alert_trigger, glance, full_reasoning, self_assessment, trade_setup, expected_move, entry_prices, attention_score, created_at')
          .contains('instruments', [ticker])
          .gte('created_at', attentionSince)
          .order('created_at', { ascending: false })
          .limit(300),
        supabase
          .from('ct_flow_alerts')
          .select('id, ticker, option_symbol, strike, expiry, side, is_ask, is_otm, size, premium, price, underlying_price, executed_at, alert_type, size_gt_oi, ingested_at, raw')
          .eq('ticker', ticker)
          .order('ingested_at', { ascending: false })
          .limit(30),
        supabase
          .from('ct_dark_pool_prints')
          .select('id, ticker, size, price, notional_value, executed_at, ingested_at')
          .eq('ticker', ticker)
          .order('ingested_at', { ascending: false })
          .limit(30),
        supabase
          .from('ct_news_analyses')
          .select('id, instrument, news_headline, news_source, news_url, claude_take, impact, significance, created_at')
          .eq('instrument', ticker)
          .order('created_at', { ascending: false })
          .limit(10),
        supabase
          .from('ct_grades')
          .select('id, subject_type, subject_id, instrument, claimed_direction, actual_direction, actual_return_pct, verdict, calibration_delta, graded_at')
          .eq('instrument', ticker)
          .gte('graded_at', attentionSinceDate)
          .order('graded_at', { ascending: false })
          .limit(50),
        supabase
          .from('ct_trades')
          .select('*')
          .eq('instrument', ticker)
          .eq('status', 'open')
          .order('opened_at', { ascending: false })
          .limit(20),
      ]);

      // Surface the first failure — don't let one bad query silently zero out
      // every strip.
      if (heartbeatsQ.error) throw heartbeatsQ.error;
      if (obsQ.error)        throw obsQ.error;
      if (flagsQ.error)      throw flagsQ.error;
      if (alertsQ.error)     throw alertsQ.error;
      if (flowQ.error)       throw flowQ.error;
      if (dpQ.error)         throw dpQ.error;
      if (newsQ.error)       throw newsQ.error;
      if (gradesQ.error)     throw gradesQ.error;
      if (tradesQ.error)     throw tradesQ.error;

      // ── sparkline + header ──────────────────────────────────────────
      const heartbeats = (heartbeatsQ.data ?? []) as Heartbeat[];
      const sparkline: TickerHeartbeatPoint[] = [];
      for (const hb of heartbeats) {
        const pt = extractHeartbeatPoint(hb, ticker);
        if (pt) sparkline.push(pt);
      }
      const isWatched = sparkline.length > 0;
      const last = sparkline.length > 0 ? sparkline[sparkline.length - 1] : null;
      const first = sparkline.length > 0 ? sparkline[0] : null;
      const price = last?.price ?? null;
      const sessionOpen = first?.price ?? null;
      const change = price !== null && sessionOpen !== null ? price - sessionOpen : null;
      const changePct =
        price !== null && sessionOpen !== null && sessionOpen !== 0
          ? ((price - sessionOpen) / sessionOpen) * 100
          : null;

      // ── recent obs/flags/alerts + attention history ─────────────────
      type RowWithScore = {
        kind: 'observation' | 'flag' | 'alert';
        row: Record<string, unknown>;
      };
      const mergedEvents: RowWithScore[] = [];
      for (const r of (obsQ.data ?? []) as Array<Record<string, unknown>>) mergedEvents.push({ kind: 'observation', row: r });
      for (const r of (flagsQ.data ?? []) as Array<Record<string, unknown>>) mergedEvents.push({ kind: 'flag', row: r });
      for (const r of (alertsQ.data ?? []) as Array<Record<string, unknown>>) mergedEvents.push({ kind: 'alert', row: r });
      mergedEvents.sort((a, b) =>
        ((b.row.created_at as string) ?? '').localeCompare((a.row.created_at as string) ?? ''),
      );

      // Recent reads (top 5 by recency).
      const recentReads: CtEvent[] = mergedEvents.slice(0, 5).map(({ kind, row }) => ({
        _type: kind,
        id: row.id as string,
        instruments: (row.instruments as string[]) ?? [],
        direction: (row.direction as string) ?? null,
        conviction: (row.conviction as number) ?? null,
        horizon: (row.horizon as string) ?? null,
        horizon_end: (row.horizon_end as string) ?? null,
        glance: (row.glance as string[]) ?? null,
        full_reasoning:
          kind === 'observation'
            ? ((row.observation as string) ?? null)
            : ((row.full_reasoning as string) ?? null),
        alert_trigger: (row.alert_trigger as string) ?? null,
        self_assessment: (row.self_assessment as CtSelfAssessment) ?? null,
        trade_setup: (row.trade_setup as TradeSetup) ?? null,
        expected_move: (row.expected_move as ExpectedMove) ?? null,
        entry_prices: (row.entry_prices as Record<string, number | null>) ?? null,
        created_at: row.created_at as string,
      }));

      // Attention history — bucket into 2hr windows over daysBack so a 7d
      // chart is ~84 points. Aggregate max score + event count per bucket.
      const BUCKET_MIN = 120;
      const buckets = new Map<string, { score: number; events: number }>();
      for (const { row } of mergedEvents) {
        const score = Number(row.attention_score ?? 0);
        if (!Number.isFinite(score) || score <= 0) continue;
        const key = toBucketKey(row.created_at as string, BUCKET_MIN);
        const cur = buckets.get(key) ?? { score: 0, events: 0 };
        if (score > cur.score) cur.score = score;
        cur.events += 1;
        buckets.set(key, cur);
      }
      const attentionHistory: AttentionPoint[] = [...buckets.entries()]
        .map(([t, v]) => ({ t, score: v.score, events: v.events }))
        .sort((a, b) => a.t.localeCompare(b.t));

      // ── graded alerts ───────────────────────────────────────────────
      const gradedAlerts: GradedEventRow[] = ((gradesQ.data ?? []) as Array<Record<string, unknown>>).map(g => ({
        grade_id: g.id as string,
        subject_type: g.subject_type as GradedEventRow['subject_type'],
        subject_id: g.subject_id as string,
        verdict: g.verdict as GradedEventRow['verdict'],
        actual_return_pct: Number(g.actual_return_pct ?? 0),
        actual_direction: g.actual_direction as GradedEventRow['actual_direction'],
        claimed_direction: (g.claimed_direction as string) ?? '',
        graded_at: g.graded_at as string,
        calibration_delta: (g.calibration_delta as number | null) ?? null,
      }));

      return {
        ticker,
        isWatched,
        header: {
          price,
          sessionOpen,
          change,
          changePct,
          regime: last?.regime ?? null,
          updatedAt: last?.created_at ?? null,
        },
        sparkline,
        attentionHistory,
        flowAlerts: (flowQ.data ?? []) as FlowAlert[],
        darkPoolPrints: (dpQ.data ?? []) as DarkPoolPrint[],
        news: (newsQ.data ?? []) as NewsItem[],
        gradedAlerts,
        openPositions: (tradesQ.data ?? []) as CtTradeRow[],
        recentReads,
      } satisfies TickerTerminalData;
    },
  });
}

function emptyData(ticker: string): TickerTerminalData {
  return {
    ticker,
    isWatched: false,
    header: {
      price: null,
      sessionOpen: null,
      change: null,
      changePct: null,
      regime: null,
      updatedAt: null,
    },
    sparkline: [],
    attentionHistory: [],
    flowAlerts: [],
    darkPoolPrints: [],
    news: [],
    gradedAlerts: [],
    openPositions: [],
    recentReads: [],
  };
}

