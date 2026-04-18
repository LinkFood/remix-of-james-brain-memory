/**
 * Co-trader data hooks — queries ct_* tables with realtime subscriptions.
 * All RLS-authenticated. Single user, so we don't filter by user_id.
 */
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface Heartbeat {
  id: string;
  status_line: string;
  watching: string[];
  current_reads: Record<string, unknown>;
  created_at: string;
}

export interface Thesis {
  id: string;
  instrument: string;
  direction: string;
  conviction: number;
  up_case: string;
  down_case: string;
  watching: string | null;
  rationale: string | null;
  updated_at: string;
}

export interface CtSelfAssessment {
  confidence?: number;
  reasoning_quality?: number;
  key_evidence?: string;
  kill_conditions?: string;
  what_could_go_wrong?: string;
}

export interface TradeSetup {
  instrument?: string;
  strategy?: 'long_call' | 'long_put' | 'short_call' | 'short_put' | 'spread' | 'iron_condor' | 'other' | string;
  strike?: number;
  expiry?: string;
  dte?: number;
  type?: 'call' | 'put' | string;
  entry_condition?: string;
  entry_level?: number | null;
  stop_condition?: string;
  stop_level?: number | null;
  target_level?: number | null;
  target_rationale?: string;
  size_r?: number;
  max_pain_anchor?: number | null;
  rationale?: string;
  caveats?: string | null;
  [k: string]: unknown;
}

export interface ExpectedMove {
  low_pct: number;
  high_pct: number;
  confidence_pct: number;
  horizon_hrs: number;
}

export interface CtEvent {
  id: string;
  _type: 'observation' | 'flag' | 'alert';
  instruments: string[];
  direction: string | null;
  conviction: number | null;
  horizon: string | null;
  horizon_end?: string | null;
  glance: string[] | null;
  full_reasoning: string | null;
  alert_trigger: string | null;
  self_assessment: CtSelfAssessment | null;
  trade_setup?: TradeSetup | null;
  expected_move?: ExpectedMove | null;
  entry_prices?: Record<string, number | null> | null;
  created_at: string;
}

export interface CtSelfRegrade {
  id: string;
  subject_type: 'observation' | 'flag' | 'alert';
  subject_id: string;
  original_confidence: number | null;
  original_reasoning_quality: number | null;
  retrospective_confidence: number | null;
  retrospective_reasoning_quality: number | null;
  what_i_got_right: string | null;
  what_i_got_wrong: string | null;
  how_id_rewrite: string | null;
  grader_verdict: string | null;
  regraded_at: string;
}

export interface NewsItem {
  id: string;
  instrument: string;
  news_headline: string;
  news_source: string | null;
  news_url: string | null;
  claude_take: string;
  impact: string;
  significance: number;
  /** Structured directional read for the ticker: positive | negative | neutral. May be null on legacy rows. */
  sentiment: 'positive' | 'negative' | 'neutral' | null;
  /** 1 = tepid, 5 = seismic. Null on legacy rows. */
  sentiment_magnitude: number | null;
  /** 1-sentence numbers-first justification. Null on legacy rows. */
  sentiment_reasoning: string | null;
  created_at: string;
}


export interface Report {
  id: string;
  report_type: string;
  period_start: string;
  period_end: string;
  summary: string;
  decomposition: unknown;
  rabbit_hole: string;
  scorecard: unknown;
  self_assessment: string;
  created_at: string;
}

export function useLatestHeartbeat() {
  return useQuery<Heartbeat | null>({
    queryKey: ['ct_latest_heartbeat'],
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ct_heartbeats')
        .select('id, status_line, watching, current_reads, created_at')
        .neq('prompt_version', 'mcp-verify')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as Heartbeat | null;
    },
  });
}

/**
 * Today's session heartbeats (ordered ascending). Used by MarketBanner to:
 *   - anchor intraday Δ (first price of session vs latest)
 *   - detect regime flips within session (e.g. gamma regime inverted mid-day)
 * One query, no UW cost — heartbeats already hold _snapshot per cycle.
 */
export function useSessionHeartbeats() {
  return useQuery<Heartbeat[]>({
    queryKey: ['ct_session_heartbeats'],
    refetchInterval: 60_000,
    queryFn: async () => {
      // Anchor to start of "today" in ET-ish terms. Using UTC midnight is fine
      // for this — the session starts at 13:30 UTC, so anything after 00:00
      // UTC today will include the session. Pre-open heartbeats are welcome
      // as anchors.
      const sinceIso = new Date(new Date().setUTCHours(0, 0, 0, 0)).toISOString();
      const { data, error } = await supabase
        .from('ct_heartbeats')
        .select('id, status_line, watching, current_reads, created_at')
        .neq('prompt_version', 'mcp-verify')
        .gte('created_at', sinceIso)
        .order('created_at', { ascending: true })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as Heartbeat[];
    },
  });
}

/**
 * Latest ct_attention_stream row with attention_score >= threshold, within window.
 * Powers the HOT pill — "drop-what-you're-doing" signal distilled to one line.
 */
export interface AttentionStreamRow {
  kind: 'observation' | 'flag' | 'alert' | 'heartbeat';
  id: string;
  created_at: string;
  attention_score: number | null;
  summary: string | null;
}

export function useTopAttention(minutesBack = 30, minScore = 60) {
  return useQuery<AttentionStreamRow | null>({
    queryKey: ['ct_top_attention', minutesBack, minScore],
    refetchInterval: 30_000,
    queryFn: async () => {
      const since = new Date(Date.now() - minutesBack * 60_000).toISOString();
      const { data, error } = await supabase
        .from('ct_attention_stream')
        .select('kind, id, created_at, attention_score, summary')
        .gte('created_at', since)
        .gte('attention_score', minScore)
        .order('attention_score', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as AttentionStreamRow | null;
    },
  });
}

export function useTheses() {
  return useQuery<Thesis[]>({
    queryKey: ['ct_theses'],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ct_theses')
        .select('id, instrument, direction, conviction, up_case, down_case, watching, rationale, updated_at');
      if (error) throw error;
      return (data ?? []) as Thesis[];
    },
  });
}

export function useRecentEvents(limit = 20) {
  const qc = useQueryClient();

  useEffect(() => {
    const chan = supabase
      .channel('ct_events')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ct_observations' }, () => qc.invalidateQueries({ queryKey: ['ct_events'] }))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ct_flags' }, () => qc.invalidateQueries({ queryKey: ['ct_events'] }))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ct_alerts' }, () => qc.invalidateQueries({ queryKey: ['ct_events'] }))
      .subscribe();
    return () => { supabase.removeChannel(chan); };
  }, [qc]);

  return useQuery<CtEvent[]>({
    queryKey: ['ct_events', limit],
    refetchInterval: 30_000,
    queryFn: async () => {
      const [obs, flags, alerts] = await Promise.all([
        supabase.from('ct_observations').select('id, instruments, direction, glance, observation, self_assessment, created_at').order('created_at', { ascending: false }).limit(limit),
        supabase.from('ct_flags').select('id, instruments, direction, conviction, horizon, horizon_end, glance, full_reasoning, self_assessment, trade_setup, expected_move, entry_prices, created_at').order('created_at', { ascending: false }).limit(limit),
        supabase.from('ct_alerts').select('id, instruments, direction, conviction, horizon, horizon_end, alert_trigger, glance, full_reasoning, self_assessment, trade_setup, expected_move, entry_prices, created_at').order('created_at', { ascending: false }).limit(limit),
      ]);
      const items: CtEvent[] = [];
      for (const r of (obs.data ?? []) as Array<Record<string, unknown>>) items.push({ _type: 'observation', id: r.id as string, instruments: (r.instruments as string[]) ?? [], direction: (r.direction as string) ?? null, conviction: null, horizon: null, horizon_end: null, glance: (r.glance as string[]) ?? null, full_reasoning: (r.observation as string) ?? null, alert_trigger: null, self_assessment: (r.self_assessment as CtSelfAssessment) ?? null, trade_setup: null, created_at: r.created_at as string });
      for (const r of (flags.data ?? []) as Array<Record<string, unknown>>) items.push({ _type: 'flag', id: r.id as string, instruments: (r.instruments as string[]) ?? [], direction: (r.direction as string) ?? null, conviction: (r.conviction as number) ?? null, horizon: (r.horizon as string) ?? null, horizon_end: (r.horizon_end as string) ?? null, glance: (r.glance as string[]) ?? null, full_reasoning: (r.full_reasoning as string) ?? null, alert_trigger: null, self_assessment: (r.self_assessment as CtSelfAssessment) ?? null, trade_setup: (r.trade_setup as TradeSetup) ?? null, expected_move: (r.expected_move as ExpectedMove) ?? null, entry_prices: (r.entry_prices as Record<string, number | null>) ?? null, created_at: r.created_at as string });
      for (const r of (alerts.data ?? []) as Array<Record<string, unknown>>) items.push({ _type: 'alert', id: r.id as string, instruments: (r.instruments as string[]) ?? [], direction: (r.direction as string) ?? null, conviction: (r.conviction as number) ?? null, horizon: (r.horizon as string) ?? null, horizon_end: (r.horizon_end as string) ?? null, glance: (r.glance as string[]) ?? null, full_reasoning: (r.full_reasoning as string) ?? null, alert_trigger: (r.alert_trigger as string) ?? null, self_assessment: (r.self_assessment as CtSelfAssessment) ?? null, trade_setup: (r.trade_setup as TradeSetup) ?? null, expected_move: (r.expected_move as ExpectedMove) ?? null, entry_prices: (r.entry_prices as Record<string, number | null>) ?? null, created_at: r.created_at as string });
      items.sort((a, b) => b.created_at.localeCompare(a.created_at));
      return items.slice(0, limit);
    },
  });
}

/**
 * Active trade setups — flags/alerts inside their horizon window, ungraded,
 * with a concrete trade_setup payload. Sorted by conviction desc, then recency.
 */
export function useActiveTradeSetups(limit = 5) {
  const qc = useQueryClient();

  useEffect(() => {
    const chan = supabase
      .channel('ct_active_setups')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ct_flags' }, () => qc.invalidateQueries({ queryKey: ['ct_active_trade_setups'] }))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ct_alerts' }, () => qc.invalidateQueries({ queryKey: ['ct_active_trade_setups'] }))
      .subscribe();
    return () => { supabase.removeChannel(chan); };
  }, [qc]);

  return useQuery<CtEvent[]>({
    queryKey: ['ct_active_trade_setups', limit],
    refetchInterval: 30_000,
    queryFn: async () => {
      const nowIso = new Date().toISOString();
      const [flags, alerts] = await Promise.all([
        supabase
          .from('ct_flags')
          .select('id, instruments, direction, conviction, horizon, horizon_end, glance, full_reasoning, self_assessment, trade_setup, expected_move, entry_prices, created_at')
          .is('grade_id', null)
          .not('trade_setup', 'is', null)
          .gt('horizon_end', nowIso)
          .order('conviction', { ascending: false })
          .order('created_at', { ascending: false })
          .limit(limit * 2),
        supabase
          .from('ct_alerts')
          .select('id, instruments, direction, conviction, horizon, horizon_end, alert_trigger, glance, full_reasoning, self_assessment, trade_setup, expected_move, entry_prices, created_at')
          .is('grade_id', null)
          .not('trade_setup', 'is', null)
          .gt('horizon_end', nowIso)
          .order('created_at', { ascending: false })
          .limit(limit * 2),
      ]);
      const items: CtEvent[] = [];
      for (const r of (flags.data ?? []) as Array<Record<string, unknown>>) items.push({ _type: 'flag', id: r.id as string, instruments: (r.instruments as string[]) ?? [], direction: (r.direction as string) ?? null, conviction: (r.conviction as number) ?? null, horizon: (r.horizon as string) ?? null, horizon_end: (r.horizon_end as string) ?? null, glance: (r.glance as string[]) ?? null, full_reasoning: (r.full_reasoning as string) ?? null, alert_trigger: null, self_assessment: (r.self_assessment as CtSelfAssessment) ?? null, trade_setup: (r.trade_setup as TradeSetup) ?? null, expected_move: (r.expected_move as ExpectedMove) ?? null, entry_prices: (r.entry_prices as Record<string, number | null>) ?? null, created_at: r.created_at as string });
      for (const r of (alerts.data ?? []) as Array<Record<string, unknown>>) items.push({ _type: 'alert', id: r.id as string, instruments: (r.instruments as string[]) ?? [], direction: (r.direction as string) ?? null, conviction: (r.conviction as number) ?? null, horizon: (r.horizon as string) ?? null, horizon_end: (r.horizon_end as string) ?? null, glance: (r.glance as string[]) ?? null, full_reasoning: (r.full_reasoning as string) ?? null, alert_trigger: (r.alert_trigger as string) ?? null, self_assessment: (r.self_assessment as CtSelfAssessment) ?? null, trade_setup: (r.trade_setup as TradeSetup) ?? null, expected_move: (r.expected_move as ExpectedMove) ?? null, entry_prices: (r.entry_prices as Record<string, number | null>) ?? null, created_at: r.created_at as string });
      items.sort((a, b) => b.created_at.localeCompare(a.created_at));
      // DEDUPE: show only setups that match the latest alert's direction
      // per (instrument set). When Claude flips bullish→bearish on SPY
      // with a new ALERT, prior bullish setups are structurally invalidated
      // and shouldn't compete for attention.
      const latestDirByKey = new Map<string, string>();
      for (const it of items) {
        const key = (it.instruments ?? []).slice().sort().join(',');
        if (!latestDirByKey.has(key) && it.direction) latestDirByKey.set(key, it.direction);
      }
      const filtered = items.filter(it => {
        const key = (it.instruments ?? []).slice().sort().join(',');
        const latestDir = latestDirByKey.get(key);
        // Keep if this setup's direction matches the latest direction for that instrument set
        // OR if it's on a different instrument set
        return !latestDir || it.direction === latestDir;
      });
      // Now sort the filtered set by conviction desc, recency desc
      filtered.sort((a, b) => {
        const cb = (b.conviction ?? 0) - (a.conviction ?? 0);
        if (cb !== 0) return cb;
        return b.created_at.localeCompare(a.created_at);
      });
      return filtered.slice(0, limit);
    },
  });
}

export function useRecentNews(limit = 20) {
  return useQuery<NewsItem[]>({
    queryKey: ['ct_news', limit],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ct_news_analyses')
        .select('id, instrument, news_headline, news_source, news_url, claude_take, impact, significance, sentiment, sentiment_magnitude, sentiment_reasoning, created_at')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as NewsItem[];
    },
  });
}


export function useLatestRecap() {
  return useQuery<Report | null>({
    queryKey: ['ct_latest_recap'],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ct_reports')
        .select('id, report_type, period_start, period_end, summary, decomposition, rabbit_hole, scorecard, self_assessment, created_at')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as Report | null;
    },
  });
}

export interface FlowAlert {
  id: string;
  ticker: string;
  option_symbol: string | null;
  strike: number | null;
  expiry: string | null;
  side: string | null;
  is_ask: boolean | null;
  is_otm: boolean | null;
  size: number | null;
  premium: number | null;
  price: number | null;
  underlying_price: number | null;
  executed_at: string | null;
  alert_type: string | null;
  size_gt_oi: boolean | null;
  ingested_at: string;
  raw?: Record<string, unknown>;
}

export interface DarkPoolPrint {
  id: string;
  ticker: string;
  size: number;
  price: number;
  notional_value: number;
  executed_at: string | null;
  ingested_at: string;
}

export interface SweepCluster {
  id: string;
  ticker: string;
  window_start: string;
  window_end: string;
  sweep_count: number;
  total_premium: number;
  dominant_side: 'call' | 'put' | 'mixed';
  largest_single_premium: number;
  call_count: number;
  put_count: number;
  attention_score: number;
  created_at: string;
}

export interface RegimeInversion {
  id: string;
  created_at: string;
  session_date: string;
  ticker: string;
  prev_regime: 'positive' | 'negative';
  new_regime: 'positive' | 'negative';
  prev_net_gamma: number | null;
  new_net_gamma: number | null;
  flip_level: number | null;
  spot_at_flip: number | null;
  attention_score: number;
}

export interface DpCluster {
  id: string;
  ticker: string;
  window_start: string;
  window_end: string;
  print_count: number;
  total_notional: number;
  largest_single_notional: number;
  attention_score: number;
  created_at: string;
  session_date: string;
}

/**
 * Recent dark-pool clusters — always-on flag pattern emitted by ct-dp-cluster.
 * Sibling of useSweepClusters. Pulls the last `windowMinutes` minutes
 * (default 15) sorted newest-first, capped at `limit` (default 5).
 */
export function useDpClusters(limit = 5, windowMinutes = 15) {
  return useQuery<DpCluster[]>({
    queryKey: ['ct_dp_clusters', limit, windowMinutes],
    refetchInterval: 60_000,
    queryFn: async () => {
      const cutoff = new Date(Date.now() - windowMinutes * 60_000).toISOString();
      const { data, error } = await supabase
        .from('ct_dp_clusters')
        .select('id, ticker, window_start, window_end, print_count, total_notional, largest_single_notional, attention_score, created_at, session_date')
        .gte('created_at', cutoff)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as DpCluster[];
    },
  });
}

/**
 * Recent sweep clusters — always-on flag pattern emitted by ct-sweep-cluster.
 * Pulls the last `windowMinutes` minutes (default 15) sorted newest-first,
 * capped at `limit` (default 5) for the strip display.
 */
export function useSweepClusters(limit = 5, windowMinutes = 15) {
  return useQuery<SweepCluster[]>({
    queryKey: ['ct_sweep_clusters', limit, windowMinutes],
    refetchInterval: 60_000,
    queryFn: async () => {
      const cutoff = new Date(Date.now() - windowMinutes * 60_000).toISOString();
      const { data, error } = await supabase
        .from('ct_sweep_clusters')
        .select('id, ticker, window_start, window_end, sweep_count, total_premium, dominant_side, largest_single_premium, call_count, put_count, attention_score, created_at')
        .gte('created_at', cutoff)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as SweepCluster[];
    },
  });
}

/**
 * Recent gamma regime inversions — dealer regime flip (positive<->negative),
 * written by ct-regime-watch off ct_heartbeats. Structural session-scale
 * event, always attention 80. Pulls the last `windowMinutes` minutes
 * (default 60), newest-first, capped at `limit` (default 5).
 */
export function useRegimeInversions(limit = 5, windowMinutes = 60) {
  return useQuery<RegimeInversion[]>({
    queryKey: ['ct_regime_inversions', limit, windowMinutes],
    refetchInterval: 60_000,
    queryFn: async () => {
      const cutoff = new Date(Date.now() - windowMinutes * 60_000).toISOString();
      const { data, error } = await supabase
        .from('ct_regime_inversions')
        .select('id, created_at, session_date, ticker, prev_regime, new_regime, prev_net_gamma, new_net_gamma, flip_level, spot_at_flip, attention_score')
        .gte('created_at', cutoff)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as RegimeInversion[];
    },
  });
}

export interface IvShift {
  id: string;
  created_at: string;
  session_date: string;
  ticker: string;
  prev_rank: number | null;
  new_rank: number | null;
  delta: number;
  direction: 'up' | 'down';
  attention_score: number;
  ref_day: string;
}

/**
 * Recent day-over-day IV rank shifts — always-on flag pattern emitted by
 * ct-iv-shift-watch off ct_iv_rank_daily. Daily cadence (21:05 UTC weekdays).
 * Pulls the last `hoursBack` hours (default 48h — covers "today + yesterday"
 * so a shift stays visible on the strip across the next trading day),
 * newest-first, capped at `limit` (default 5).
 */
export function useIvShifts(limit = 5, hoursBack = 48) {
  return useQuery<IvShift[]>({
    queryKey: ['ct_iv_shifts', limit, hoursBack],
    refetchInterval: 5 * 60_000,
    queryFn: async () => {
      const cutoff = new Date(Date.now() - hoursBack * 3600_000).toISOString();
      const { data, error } = await supabase
        .from('ct_iv_shifts')
        .select('id, created_at, session_date, ticker, prev_rank, new_rank, delta, direction, attention_score, ref_day')
        .gte('created_at', cutoff)
        .order('attention_score', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as IvShift[];
    },
  });
}

export function useFlowAlerts(limit = 50) {
  return useQuery<FlowAlert[]>({
    queryKey: ['ct_flow_alerts', limit],
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ct_flow_alerts')
        .select('id, ticker, option_symbol, strike, expiry, side, is_ask, is_otm, size, premium, price, underlying_price, executed_at, alert_type, size_gt_oi, ingested_at, raw')
        .order('ingested_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as FlowAlert[];
    },
  });
}

export function useDarkPoolPrints(limit = 30) {
  return useQuery<DarkPoolPrint[]>({
    queryKey: ['ct_dark_pool_prints', limit],
    refetchInterval: 30_000,
    queryFn: async () => {
      // Filter to >=$500K at query level to kill the USO flood of tiny prints,
      // pull a wider window, then distribute across tickers (top 3 per ticker)
      // before trimming to `limit`. Keeps any single ticker from dominating.
      const { data, error } = await supabase
        .from('ct_dark_pool_prints')
        .select('id, ticker, size, price, notional_value, executed_at, ingested_at')
        .gte('notional_value', 500_000)
        .order('ingested_at', { ascending: false })
        .limit(Math.max(limit * 4, 120));
      if (error) throw error;
      const rows = (data ?? []) as DarkPoolPrint[];

      // Cap each ticker at 3 of its most-recent prints so no single ticker floods.
      const perTickerCap = 3;
      const counts = new Map<string, number>();
      const distributed: DarkPoolPrint[] = [];
      for (const r of rows) {
        const c = counts.get(r.ticker) ?? 0;
        if (c >= perTickerCap) continue;
        counts.set(r.ticker, c + 1);
        distributed.push(r);
        if (distributed.length >= limit) break;
      }
      return distributed;
    },
  });
}

/**
 * Manual trigger via RPC — for "run now" buttons on the dashboard.
 */
export async function triggerCoTrader(fn: 'watcher' | 'grader' | 'news_ingester' | 'eod_recap' | 'lessons_curator' | 'flow_ingester' | 'event_calendar_ingester' | 'disagreement_materializer' | 'morning_brief' | 'eod_positioning'): Promise<{ ok: boolean; error?: string }> {
  const rpcName = `trigger_ct_${fn}`;
  const { error } = await supabase.rpc(rpcName);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// ============================================================================
// Disagreements — James vs Claude collisions on the same instrument/horizon
// ============================================================================
export interface Disagreement {
  id: string;
  instrument: string;
  horizon: string;
  horizon_end: string;
  james_view_id: string;
  claude_flag_id: string;
  james_direction: string;
  claude_direction: string;
  resolution: 'pending' | 'claude_right' | 'james_right' | 'both_wrong' | 'both_right' | 'ambiguous';
  resolution_detail: string | null;
  resolved_at: string | null;
  created_at: string;
}

export function useDisagreements(limit = 20) {
  return useQuery<Disagreement[]>({
    queryKey: ['ct_disagreements', limit],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ct_disagreements')
        .select('id, instrument, horizon, horizon_end, james_view_id, claude_flag_id, james_direction, claude_direction, resolution, resolution_detail, resolved_at, created_at')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as Disagreement[];
    },
  });
}

// ============================================================================
// Disagreements — DETAILED pair view (james view + claude flag + both grades)
// Client-side join. One query per table, keyed-lookup assembly.
// Three parallel selects (disagreements -> then james_views + flags + grades
// by id) is cleaner than a heavy SQL function and avoids another migration.
// ============================================================================
export interface DisagreementPair {
  disagreement: Disagreement;
  james: {
    id: string;
    direction: string;
    conviction: number;
    rationale: string | null;
    created_at: string;
    grade: DisagreementGrade | null;
  } | null;
  claude: {
    id: string;
    direction: string;
    conviction: number;
    glance: string[] | null;
    full_reasoning: string | null;
    created_at: string;
    grade: DisagreementGrade | null;
  } | null;
  winner: 'james' | 'claude' | 'tie' | 'both_wrong' | 'pending';
  actual_return_pct: number | null;
}

export interface DisagreementGrade {
  id: string;
  verdict: 'right' | 'wrong' | 'ambiguous' | 'partial';
  actual_return_pct: number;
  actual_direction: 'bullish' | 'bearish' | 'flat';
}

function deriveWinner(
  resolution: Disagreement['resolution'],
  jamesGrade: DisagreementGrade | null,
  claudeGrade: DisagreementGrade | null,
): DisagreementPair['winner'] {
  // Trust the materializer's resolution first — it has the canonical call
  // when both grades are in.
  if (resolution === 'james_right') return 'james';
  if (resolution === 'claude_right') return 'claude';
  if (resolution === 'both_right' || resolution === 'ambiguous') return 'tie';
  if (resolution === 'both_wrong') return 'both_wrong';
  // pending fallback: if both grades landed but resolution hasn't caught up,
  // derive from verdicts. If either grade is missing, still pending.
  if (!jamesGrade || !claudeGrade) return 'pending';
  const jRight = jamesGrade.verdict === 'right';
  const cRight = claudeGrade.verdict === 'right';
  if (jRight && !cRight) return 'james';
  if (cRight && !jRight) return 'claude';
  if (jRight && cRight) return 'tie';
  return 'both_wrong';
}

export function useDisagreementsDetailed(daysBack = 7, limit = 50) {
  return useQuery<DisagreementPair[]>({
    queryKey: ['ct_disagreements_detailed', daysBack, limit],
    refetchInterval: 60_000,
    queryFn: async () => {
      const since = new Date(Date.now() - daysBack * 86400_000).toISOString();

      const { data: dRows, error: dErr } = await supabase
        .from('ct_disagreements')
        .select('id, instrument, horizon, horizon_end, james_view_id, claude_flag_id, james_direction, claude_direction, resolution, resolution_detail, resolved_at, created_at')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (dErr) throw dErr;
      const disagreements = (dRows ?? []) as Disagreement[];
      if (disagreements.length === 0) return [];

      const jamesIds = Array.from(new Set(disagreements.map(d => d.james_view_id)));
      const claudeIds = Array.from(new Set(disagreements.map(d => d.claude_flag_id)));

      const [jamesQ, claudeQ] = await Promise.all([
        supabase
          .from('ct_james_views')
          .select('id, direction, conviction, rationale, created_at, grade_id')
          .in('id', jamesIds),
        supabase
          .from('ct_flags')
          .select('id, direction, conviction, glance, full_reasoning, created_at, grade_id')
          .in('id', claudeIds),
      ]);
      if (jamesQ.error) throw jamesQ.error;
      if (claudeQ.error) throw claudeQ.error;

      type JamesRow = { id: string; direction: string; conviction: number; rationale: string | null; created_at: string; grade_id: string | null };
      type ClaudeRow = { id: string; direction: string; conviction: number; glance: string[] | null; full_reasoning: string | null; created_at: string; grade_id: string | null };
      const jamesRows = (jamesQ.data ?? []) as JamesRow[];
      const claudeRows = (claudeQ.data ?? []) as ClaudeRow[];

      const gradeIds = Array.from(new Set([
        ...jamesRows.map(r => r.grade_id).filter((x): x is string => !!x),
        ...claudeRows.map(r => r.grade_id).filter((x): x is string => !!x),
      ]));

      let gradeMap = new Map<string, DisagreementGrade>();
      if (gradeIds.length > 0) {
        const { data: gRows, error: gErr } = await supabase
          .from('ct_grades')
          .select('id, verdict, actual_return_pct, actual_direction')
          .in('id', gradeIds);
        if (gErr) throw gErr;
        for (const g of (gRows ?? []) as DisagreementGrade[]) gradeMap.set(g.id, g);
      }

      const jamesMap = new Map(jamesRows.map(r => [r.id, r]));
      const claudeMap = new Map(claudeRows.map(r => [r.id, r]));

      return disagreements.map(d => {
        const j = jamesMap.get(d.james_view_id) ?? null;
        const c = claudeMap.get(d.claude_flag_id) ?? null;
        const jGrade = j?.grade_id ? gradeMap.get(j.grade_id) ?? null : null;
        const cGrade = c?.grade_id ? gradeMap.get(c.grade_id) ?? null : null;
        const winner = deriveWinner(d.resolution, jGrade, cGrade);
        const actual_return_pct =
          cGrade?.actual_return_pct ?? jGrade?.actual_return_pct ?? null;
        return {
          disagreement: d,
          james: j
            ? { id: j.id, direction: j.direction, conviction: j.conviction, rationale: j.rationale, created_at: j.created_at, grade: jGrade }
            : null,
          claude: c
            ? { id: c.id, direction: c.direction, conviction: c.conviction, glance: c.glance, full_reasoning: c.full_reasoning, created_at: c.created_at, grade: cGrade }
            : null,
          winner,
          actual_return_pct,
        };
      });
    },
  });
}

export interface DisagreementScoreboard {
  james_wins: number;
  claude_wins: number;
  ties: number;
  both_wrong: number;
  pending: number;
  total: number;
}

/** Head-to-head scoreboard over the last N days. */
export function useDisagreementScoreboard(daysBack = 30) {
  return useQuery<DisagreementScoreboard>({
    queryKey: ['ct_disagreements_scoreboard', daysBack],
    refetchInterval: 60_000,
    queryFn: async () => {
      const since = new Date(Date.now() - daysBack * 86400_000).toISOString();
      const { data, error } = await supabase
        .from('ct_disagreements')
        .select('resolution')
        .gte('created_at', since)
        .limit(1000);
      if (error) throw error;
      const rows = (data ?? []) as Array<{ resolution: Disagreement['resolution'] }>;
      const sb: DisagreementScoreboard = {
        james_wins: 0, claude_wins: 0, ties: 0, both_wrong: 0, pending: 0, total: rows.length,
      };
      for (const r of rows) {
        if (r.resolution === 'james_right')     sb.james_wins++;
        else if (r.resolution === 'claude_right') sb.claude_wins++;
        else if (r.resolution === 'both_right' || r.resolution === 'ambiguous') sb.ties++;
        else if (r.resolution === 'both_wrong') sb.both_wrong++;
        else sb.pending++;
      }
      return sb;
    },
  });
}

/** Today's james_views — used to decide whether to nudge "post your view". */
export interface JamesViewRow {
  id: string;
  instrument: string;
  direction: string;
  created_at: string;
}

export function useTodayJamesViews() {
  return useQuery<JamesViewRow[]>({
    queryKey: ['ct_james_views_today'],
    refetchInterval: 60_000,
    queryFn: async () => {
      const todayStart = new Date(new Date().setUTCHours(0, 0, 0, 0)).toISOString();
      const { data, error } = await supabase
        .from('ct_james_views')
        .select('id, instrument, direction, created_at')
        .gte('created_at', todayStart)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as JamesViewRow[];
    },
  });
}

// ============================================================================
// Post a james_view directly from the browser
// ============================================================================
export interface PostJamesViewInput {
  instrument: string;
  direction: 'bullish' | 'bearish' | 'neutral' | 'volatility';
  conviction: number;
  horizon: '1h' | '4h' | 'EOD' | 'next-day' | 'weekly';
  rationale?: string;
}

function computeHorizonEnd(horizon: string, from = new Date()): Date {
  const d = new Date(from);
  switch (horizon) {
    case '1h':       d.setHours(d.getHours() + 1); return d;
    case '4h':       d.setHours(d.getHours() + 4); return d;
    case 'EOD':      d.setHours(21, 0, 0, 0); if (d <= from) d.setDate(d.getDate() + 1); return d;
    case 'next-day': d.setDate(d.getDate() + 1); d.setHours(21, 0, 0, 0); return d;
    case 'weekly':   d.setDate(d.getDate() + 7); return d;
    default:         d.setHours(d.getHours() + 4); return d;
  }
}

export async function postJamesView(input: PostJamesViewInput): Promise<{ ok: boolean; error?: string; id?: string }> {
  const { data: auth, error: authErr } = await supabase.auth.getUser();
  if (authErr || !auth?.user) return { ok: false, error: 'not signed in' };

  const horizon_end = computeHorizonEnd(input.horizon).toISOString();

  const { data, error } = await supabase
    .from('ct_james_views')
    .insert({
      user_id: auth.user.id,
      instrument: input.instrument.toUpperCase(),
      direction: input.direction,
      conviction: input.conviction,
      horizon: input.horizon,
      horizon_end,
      rationale: input.rationale?.trim() || null,
      source: 'web',
    })
    .select('id')
    .single();

  if (error) return { ok: false, error: error.message };
  return { ok: true, id: data?.id as string };
}

export interface CtEventRow {
  id: string;
  event_type: 'earnings' | 'fda' | 'econ';
  ticker: string | null;
  event_date: string;
  event_time: string | null;
  title: string | null;
  importance: number | null;
  fetched_at: string;
}

/** Next 24hr of events across all three types. */
export function useEventsToday() {
  return useQuery<CtEventRow[]>({
    queryKey: ['ct_events_today'],
    refetchInterval: 5 * 60_000,
    queryFn: async () => {
      const now = new Date();
      const todayStr = now.toISOString().slice(0, 10);
      const tomorrow = new Date(now.getTime() + 24 * 3600_000).toISOString().slice(0, 10);
      const { data, error } = await supabase
        .from('ct_events')
        .select('id, event_type, ticker, event_date, event_time, title, importance, fetched_at')
        .gte('event_date', todayStr)
        .lte('event_date', tomorrow)
        .order('event_date', { ascending: true })
        .order('event_time', { ascending: true, nullsFirst: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as CtEventRow[];
    },
  });
}

/** Upcoming events for a specific ticker (next 90 days). */
export function useEventsForTicker(ticker: string | null | undefined) {
  return useQuery<CtEventRow[]>({
    queryKey: ['ct_events_ticker', ticker],
    enabled: !!ticker,
    refetchInterval: 5 * 60_000,
    queryFn: async () => {
      if (!ticker) return [];
      const today = new Date().toISOString().slice(0, 10);
      const { data, error } = await supabase
        .from('ct_events')
        .select('id, event_type, ticker, event_date, event_time, title, importance, fetched_at')
        .eq('ticker', ticker)
        .gte('event_date', today)
        .order('event_date', { ascending: true })
        .order('event_time', { ascending: true, nullsFirst: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as CtEventRow[];
    },
  });
}

export interface NetPremiumTick {
  ticker: string;
  tick_timestamp: string;
  net_call_premium: number | null;
  net_put_premium: number | null;
  net_call_volume: number | null;
  net_put_volume: number | null;
  underlying_price: number | null;
}

/**
 * True intraday net-premium ticks from UW (written every ~3min by ct-flow-ingester).
 * Ordered ascending so callers can chart cumulative flow straight from the data.
 */
export function useNetPremiumTicks(ticker: string, hours = 4) {
  return useQuery<NetPremiumTick[]>({
    queryKey: ['ct_net_premium_ticks', ticker, hours],
    enabled: !!ticker,
    refetchInterval: 60_000,
    queryFn: async () => {
      if (!ticker) return [];
      const since = new Date(Date.now() - hours * 3600_000).toISOString();
      const { data, error } = await supabase
        .from('ct_net_premium_ticks')
        .select('ticker, tick_timestamp, net_call_premium, net_put_premium, net_call_volume, net_put_volume, underlying_price')
        .eq('ticker', ticker)
        .gte('tick_timestamp', since)
        .order('tick_timestamp', { ascending: true })
        .limit(2000);
      if (error) throw error;
      return (data ?? []) as NetPremiumTick[];
    },
  });
}

/** Distinct tickers currently streaming in ct_net_premium_ticks (last 24h). */
export function useNetPremiumTickers() {
  return useQuery<string[]>({
    queryKey: ['ct_net_premium_tickers'],
    refetchInterval: 5 * 60_000,
    queryFn: async () => {
      const since = new Date(Date.now() - 24 * 3600_000).toISOString();
      const { data, error } = await supabase
        .from('ct_net_premium_ticks')
        .select('ticker')
        .gte('tick_timestamp', since)
        .limit(5000);
      if (error) throw error;
      const seen = new Set<string>();
      for (const r of (data ?? []) as Array<{ ticker: string }>) seen.add(r.ticker);
      return Array.from(seen).sort();
    },
  });
}

export interface GexTimeseriesRow {
  ticker: string;
  snapshot_at: string;
  strike: number;
  call_gex: number | null;
  put_gex: number | null;
  net_gex: number | null;
  underlying_price: number | null;
  is_atm_band: boolean | null;
}

export function useGexTimeseries(ticker: string, hours = 4) {
  return useQuery<GexTimeseriesRow[]>({
    queryKey: ['ct_gex_timeseries_rpc', ticker, hours],
    refetchInterval: 60_000,
    queryFn: async () => {
      // Server-side distinct via ct_gex_heatmap RPC. Pulls LATEST 30 distinct
      // snapshot_at values and all ATM-band strikes for each. Avoids the
      // stale-pre-market-data bug where ORDER ASC + LIMIT on a 40K-row SPX
      // window returned only the earliest 14 snapshots.
      const { data, error } = await supabase.rpc('ct_gex_heatmap', {
        p_ticker: ticker,
        p_hours: hours,
        p_snapshots: 30,
        p_atm_only: true,
      });
      if (error) throw error;
      // RPC returns jsonb array (not setof rows) to bypass the 1000-row limit
      return (Array.isArray(data) ? data : []) as GexTimeseriesRow[];
    },
  });
}

export interface GreekFlowRow {
  ticker: string;
  tick_timestamp: string;
  net_call_delta: number | null;
  net_put_delta: number | null;
  net_call_vega: number | null;
  net_put_vega: number | null;
  total_delta_flow: number | null;
  total_vega_flow: number | null;
  underlying_price: number | null;
}

/** Per-minute greek flow for an index ticker (SPY/QQQ/IWM). Last N hours. */
export function useGreekFlow(ticker: 'SPY' | 'QQQ' | 'IWM', hours = 4) {
  return useQuery<GreekFlowRow[]>({
    queryKey: ['ct_greek_flow', ticker, hours],
    refetchInterval: 60_000,
    queryFn: async () => {
      const since = new Date(Date.now() - hours * 3600_000).toISOString();
      const { data, error } = await supabase
        .from('ct_greek_flow_minute')
        .select('ticker, tick_timestamp, net_call_delta, net_put_delta, net_call_vega, net_put_vega, total_delta_flow, total_vega_flow, underlying_price')
        .eq('ticker', ticker)
        .gte('tick_timestamp', since)
        .order('tick_timestamp', { ascending: true })
        .limit(5000);
      if (error) throw error;
      return (data ?? []) as GreekFlowRow[];
    },
  });
}

// ============================================================================
// Morning Brief — spoken pre-market brief (Claude script + ElevenLabs audio)
// ============================================================================
export interface MorningBrief {
  id: string;
  for_date: string;
  script: string;
  audio_url: string | null;
  duration_seconds: number | null;
  created_at: string;
}

// ============================================================================
// Ghost Trade Tape — Claude's graded calls as a paper P&L book.
// ============================================================================
export interface GhostPnlRow {
  source_type: 'flag' | 'alert';
  subject_id: string;
  instrument: string;
  direction: 'bullish' | 'bearish' | 'neutral' | 'volatility';
  conviction: number;
  horizon: string;
  opened_at: string;
  closed_at: string;
  actual_return_pct: number;
  signed_return_pct: number;
  verdict: 'right' | 'wrong' | 'ambiguous' | 'partial';
}

export interface GhostPnlAggregates {
  trades: number;
  cumulative_pct: number;
  win_rate: number;
  avg_win: number;
  avg_loss: number;
  sharpe_proxy: number;
}

export interface GhostPnlPoint {
  closed_at: string;
  cumulative_pct: number;
  signed_return_pct: number;
  instrument: string;
}

export function useGhostPnl(days = 30) {
  return useQuery<{ rows: GhostPnlRow[]; series: GhostPnlPoint[]; aggregates: GhostPnlAggregates }>({
    queryKey: ['ct_ghost_pnl', days],
    refetchInterval: 60_000,
    queryFn: async () => {
      const since = new Date(Date.now() - days * 24 * 3600_000).toISOString();
      const { data, error } = await supabase
        .from('ct_ghost_pnl')
        .select('source_type, subject_id, instrument, direction, conviction, horizon, opened_at, closed_at, actual_return_pct, signed_return_pct, verdict')
        .gte('closed_at', since)
        .order('closed_at', { ascending: true })
        .limit(2000);
      if (error) throw error;
      const rows = (data ?? []) as GhostPnlRow[];

      // Cumulative series (simple sum of signed returns — 1 unit per trade).
      let cum = 0;
      const series: GhostPnlPoint[] = rows.map((r) => {
        cum += r.signed_return_pct || 0;
        return {
          closed_at: r.closed_at,
          cumulative_pct: cum,
          signed_return_pct: r.signed_return_pct || 0,
          instrument: r.instrument,
        };
      });

      // Aggregates
      const trades = rows.length;
      const returns = rows.map((r) => r.signed_return_pct || 0);
      const wins = returns.filter((r) => r > 0);
      const losses = returns.filter((r) => r < 0);
      const win_rate = trades > 0 ? wins.length / trades : 0;
      const avg_win = wins.length > 0 ? wins.reduce((s, r) => s + r, 0) / wins.length : 0;
      const avg_loss = losses.length > 0 ? losses.reduce((s, r) => s + r, 0) / losses.length : 0;
      const cumulative_pct = cum;
      const mean = trades > 0 ? returns.reduce((s, r) => s + r, 0) / trades : 0;
      const variance = trades > 0 ? returns.reduce((s, r) => s + (r - mean) ** 2, 0) / trades : 0;
      const stddev = Math.sqrt(variance);
      const sharpe_proxy = stddev > 0 ? (mean / stddev) * Math.sqrt(trades) : 0;

      return {
        rows,
        series,
        aggregates: { trades, cumulative_pct, win_rate, avg_win, avg_loss, sharpe_proxy },
      };
    },
  });
}

export function useLatestMorningBrief() {
  return useQuery<MorningBrief | null>({
    queryKey: ['ct_latest_morning_brief'],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ct_morning_briefs')
        .select('id, for_date, script, audio_url, duration_seconds, created_at')
        .order('for_date', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as MorningBrief | null;
    },
  });
}

// ============================================================================
// Historical Recall — search Claude's memory (ct_embeddings + source rows)
// ============================================================================
export interface RecallHit {
  type: 'observation' | 'flag' | 'alert' | 'report' | 'news' | 'james_view' | 'thesis' | 'lesson';
  id: string;
  timestamp: string | null;
  instruments: string[];
  direction: string | null;
  conviction: number | null;
  glance: string[] | null;
  grade?: { verdict: string; actual_return_pct: number | null } | null;
  distance?: number;
}

export interface RecallResponse {
  hits: RecallHit[];
  mode: 'time' | 'semantic' | 'hybrid';
  duration_ms: number;
}

export function useHistoricalRecall(q?: string, instrument?: string) {
  const query = (q ?? '').trim();
  const instr = instrument?.trim().toUpperCase() || undefined;
  return useQuery<RecallResponse | null>({
    queryKey: ['ct_recall', query, instr],
    enabled: query.length > 0,
    staleTime: 30_000,
    queryFn: async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      const jwt = sessionData?.session?.access_token;
      if (!jwt) throw new Error('not signed in');

      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ct-recall`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, instrument: instr, kind: 'any' }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `recall failed (${res.status})`);
      return body as RecallResponse;
    },
  });
}

// ============================================================================
// EOD Positioning — Max Pain (per expiry) + IV Rank (daily) for watchlist.
// ============================================================================
export interface MaxPainRow {
  id: string;
  ticker: string;
  date: string;
  expiry: string | null;
  max_pain_strike: number | null;
  ingested_at: string;
}

export interface IvRankRow {
  id: string;
  ticker: string;
  date: string;
  iv_rank: number | null;
  iv_30d: number | null;
  iv_percentile: number | null;
  ingested_at: string;
}

/** Latest max-pain rows for a ticker — every expiry on the most recent date. */
export function useMaxPain(ticker: string) {
  return useQuery<MaxPainRow[]>({
    queryKey: ['ct_max_pain', ticker],
    enabled: !!ticker,
    refetchInterval: 5 * 60_000,
    queryFn: async () => {
      if (!ticker) return [];
      const { data: latest, error: le } = await supabase
        .from('ct_max_pain_daily')
        .select('date')
        .eq('ticker', ticker)
        .order('date', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (le) throw le;
      if (!latest?.date) return [];
      const { data, error } = await supabase
        .from('ct_max_pain_daily')
        .select('id, ticker, date, expiry, max_pain_strike, ingested_at')
        .eq('ticker', ticker)
        .eq('date', latest.date as string)
        .order('expiry', { ascending: true, nullsFirst: false });
      if (error) throw error;
      return (data ?? []) as MaxPainRow[];
    },
  });
}

/**
 * Retrospective self-regrade for a specific observation/flag/alert.
 * Returns null until the self-grader cron runs 2-24hr after creation.
 */
export function useSelfRegrade(
  subjectType: 'observation' | 'flag' | 'alert' | null | undefined,
  subjectId: string | null | undefined
) {
  return useQuery<CtSelfRegrade | null>({
    queryKey: ['ct_self_regrade', subjectType, subjectId],
    enabled: !!subjectType && !!subjectId,
    refetchInterval: 5 * 60_000,
    queryFn: async () => {
      if (!subjectType || !subjectId) return null;
      const { data, error } = await supabase
        .from('ct_self_regrades')
        .select('id, subject_type, subject_id, original_confidence, original_reasoning_quality, retrospective_confidence, retrospective_reasoning_quality, what_i_got_right, what_i_got_wrong, how_id_rewrite, grader_verdict, regraded_at')
        .eq('subject_type', subjectType)
        .eq('subject_id', subjectId)
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as CtSelfRegrade | null;
    },
  });
}

/** Claude's paper book — today's session. */
export interface CtBookRow {
  id: string;
  session_date: string;
  starting_balance: number;
  ending_balance: number | null;
  realized_pnl: number;
  unrealized_pnl: number;
  realized_pnl_pct: number;
  high_water_mark: number | null;
  trades_count: number;
  wins: number;
  losses: number;
  max_drawdown_pct: number;
  daily_recap: string | null;
  goal_hit: boolean | null;
}

export interface CtTradeRow {
  id: string;
  session_date: string;
  instrument: string;
  side: 'long' | 'short';
  size_pct: number;
  size_usd: number;
  entry_price: number;
  stop_price: number | null;
  target_price: number | null;
  thesis: string;
  conviction: number | null;
  status: 'planned' | 'open' | 'closed' | 'cancelled';
  opened_at: string | null;
  close_price: number | null;
  closed_at: string | null;
  close_reason: string | null;
  realized_pnl_pct: number | null;
  realized_pnl_usd: number | null;
  // Live unrealized P&L — written by ct-book-manager every 15min during RTH
  // for underlying trades. Options rows stay null (see migration
  // 20260419000010 — options P&L deferred). live_pnl_updated_at lets the UI
  // show a "(stale)" indicator when the book manager hasn't run in >20min.
  live_pnl_pct?: number | null;
  live_pnl_usd?: number | null;
  live_pnl_updated_at?: string | null;
  contract_type?: 'underlying' | 'call' | 'put';
  // Journal fields (migration 20260419000015). claude_notes is written by
  // ct-book-manager on close or ct-book-eod-close backfill. james_notes is
  // freeform user text edited live from Book.tsx.
  claude_notes?: string | null;
  james_notes?: string | null;
  journal_updated_at?: string | null;
  journal_version?: number | null;
  // Trade quality self-rating (migration 20260420000013). Claude grades the
  // SETUP at commit (pre, outcome-blind) and re-rates EXECUTION at close
  // (post, outcome-informed). quality_delta is a generated column
  // (post - pre) — the learning signal.
  pre_trade_quality?: number | null;
  pre_trade_quality_reasoning?: string | null;
  post_trade_quality?: number | null;
  post_trade_quality_reasoning?: string | null;
  quality_delta?: number | null;
}

export function useTodayBook() {
  return useQuery<CtBookRow | null>({
    queryKey: ['ct_book_today'],
    refetchInterval: 30_000,
    queryFn: async () => {
      const today = new Date().toISOString().slice(0, 10);
      const { data, error } = await supabase
        .from('ct_book')
        .select('*')
        .eq('session_date', today)
        .maybeSingle();
      if (error) throw error;
      return data as CtBookRow | null;
    },
  });
}

export function useTodayTrades() {
  return useQuery<CtTradeRow[]>({
    queryKey: ['ct_trades_today'],
    refetchInterval: 30_000,
    queryFn: async () => {
      const today = new Date().toISOString().slice(0, 10);
      const { data, error } = await supabase
        .from('ct_trades')
        .select('*')
        .eq('session_date', today)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data ?? []) as CtTradeRow[];
    },
  });
}

export function useBookHistory(days = 30) {
  return useQuery<CtBookRow[]>({
    queryKey: ['ct_book_history', days],
    refetchInterval: 5 * 60_000,
    queryFn: async () => {
      const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
      const { data, error } = await supabase
        .from('ct_book')
        .select('*')
        .gte('session_date', since)
        .order('session_date', { ascending: true });
      if (error) throw error;
      return (data ?? []) as CtBookRow[];
    },
  });
}

/** Per-trade action log — hold / cut / scale / flip decisions by book-manager. */
export interface CtTradeAction {
  id: string;
  trade_id: string;
  action: string;
  price: number | null;
  delta_size_pct: number | null;
  rationale: string | null;
  created_at: string;
}

export function useTradeActions(tradeId: string | null) {
  return useQuery<CtTradeAction[]>({
    queryKey: ['ct_trade_actions', tradeId],
    enabled: !!tradeId,
    refetchInterval: 30_000,
    queryFn: async () => {
      if (!tradeId) return [];
      const { data, error } = await supabase
        .from('ct_trade_actions')
        .select('*')
        .eq('trade_id', tradeId)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data ?? []) as CtTradeAction[];
    },
  });
}

export function useLatestBookRecap() {
  return useQuery<{ session_date: string; recap: string; what_worked: string | null; what_didnt: string | null; tomorrow_posture: string | null; pnl_pct: number | null } | null>({
    queryKey: ['ct_daily_recap_latest'],
    refetchInterval: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ct_daily_recaps')
        .select('session_date, recap, what_worked, what_didnt, tomorrow_posture, pnl_pct')
        .order('session_date', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

/** Today's pre-bell gauntlet predictions. Committed at 9:25 ET, graded through close. */
export interface PreBellPrediction {
  id: string;
  session_date: string;
  prediction_slot: 'spy_10am' | 'unusual_flow' | 'lagging_sector';
  prediction: Record<string, unknown>;
  rationale: string;
  confidence: number;
  committed_at: string;
  graded_at: string | null;
  verdict: 'right' | 'wrong' | 'partial' | 'ambiguous' | null;
  actual_outcome: Record<string, unknown> | null;
  calibration_delta: number | null;
}

export function useTodayGauntlet() {
  return useQuery<PreBellPrediction[]>({
    queryKey: ['ct_pre_bell_today'],
    refetchInterval: 60_000,
    queryFn: async () => {
      const today = new Date().toISOString().slice(0, 10);
      const { data, error } = await supabase
        .from('ct_pre_bell_predictions')
        .select('*')
        .eq('session_date', today)
        .order('prediction_slot');
      if (error) throw error;
      return (data ?? []) as PreBellPrediction[];
    },
  });
}

/** Recent self-corrections — surfaces Claude's hindsight on Scorecard. */
export function useRecentSelfCorrections(limit = 5) {
  return useQuery<CtSelfRegrade[]>({
    queryKey: ['ct_self_regrades_recent', limit],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ct_self_regrades')
        .select('id, subject_type, subject_id, original_confidence, original_reasoning_quality, retrospective_confidence, retrospective_reasoning_quality, what_i_got_right, what_i_got_wrong, how_id_rewrite, grader_verdict, regraded_at')
        .order('regraded_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as CtSelfRegrade[];
    },
  });
}

/** IV rank history for a ticker — most recent N days. */
export function useIvRank(ticker: string, days = 30) {
  return useQuery<IvRankRow[]>({
    queryKey: ['ct_iv_rank', ticker, days],
    enabled: !!ticker,
    refetchInterval: 5 * 60_000,
    queryFn: async () => {
      if (!ticker) return [];
      const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
      const { data, error } = await supabase
        .from('ct_iv_rank_daily')
        .select('id, ticker, date, iv_rank, iv_30d, iv_percentile, ingested_at')
        .eq('ticker', ticker)
        .gte('date', since)
        .order('date', { ascending: true });
      if (error) throw error;
      return (data ?? []) as IvRankRow[];
    },
  });
}

// ────────────────────────────────────────────────────────────────────────────
// useTickerDensity — single batched query that feeds TickerGrid card density.
//
// Powers (per ticker): attention meter, cluster badges (sweeps / DP / γflip),
// Claude's last note (latest obs/flag glance within 30 min). No UW calls, no
// per-card fan-out — one round trip across four tables then indexed by ticker.
// Grabs a generous 30-min / today's-session window so all cards can read from
// the shared result.
// ────────────────────────────────────────────────────────────────────────────

export interface TickerDensityEntry {
  /** Max attention score (0–100) observed for this ticker in the 30-min window. */
  maxAttention: number;
  /** Most recent obs/flag/alert for this ticker w/ glance + kind. */
  lastNote: {
    kind: 'observation' | 'flag' | 'alert';
    id: string;
    text: string;
    created_at: string;
    attention_score: number | null;
  } | null;
  /** Today's sweep cluster summary. */
  sweeps: { count: number; premium: number; lastSide: 'call' | 'put' | 'mixed' | null };
  /** Today's DP cluster summary. */
  dps: { count: number; notional: number };
  /** Any regime inversion for this ticker today? */
  regimeFlipped: boolean;
}

export type TickerDensityMap = Record<string, TickerDensityEntry>;

function emptyDensity(): TickerDensityEntry {
  return {
    maxAttention: 0,
    lastNote: null,
    sweeps: { count: 0, premium: 0, lastSide: null },
    dps: { count: 0, notional: 0 },
    regimeFlipped: false,
  };
}

/**
 * One query, mapped by ticker. Safe to memo — the map shape is stable and
 * only the rows inside refresh on the 30 s interval.
 */
export function useTickerDensity() {
  return useQuery<TickerDensityMap>({
    queryKey: ['ct_ticker_density'],
    refetchInterval: 30_000,
    queryFn: async () => {
      const now = Date.now();
      const since30 = new Date(now - 30 * 60_000).toISOString();
      const todayIso = new Date(now).toISOString().slice(0, 10);
      const todayStart = new Date(todayIso + 'T00:00:00.000Z').toISOString();

      const [obs, flags, alerts, sweeps, dps, regimes] = await Promise.all([
        supabase
          .from('ct_observations')
          .select('id, instruments, glance, observation, attention_score, created_at')
          .gte('created_at', since30)
          .order('created_at', { ascending: false })
          .limit(30),
        supabase
          .from('ct_flags')
          .select('id, instruments, glance, full_reasoning, attention_score, created_at')
          .gte('created_at', since30)
          .order('created_at', { ascending: false })
          .limit(30),
        supabase
          .from('ct_alerts')
          .select('id, instruments, glance, full_reasoning, attention_score, created_at')
          .gte('created_at', since30)
          .order('created_at', { ascending: false })
          .limit(30),
        supabase
          .from('ct_sweep_clusters')
          .select('ticker, sweep_count, total_premium, dominant_side, created_at')
          .gte('created_at', todayStart)
          .order('created_at', { ascending: false })
          .limit(200),
        supabase
          .from('ct_dp_clusters')
          .select('ticker, print_count, total_notional, created_at, session_date')
          .eq('session_date', todayIso)
          .limit(200),
        supabase
          .from('ct_regime_inversions')
          .select('ticker, session_date')
          .eq('session_date', todayIso)
          .limit(50),
      ]);

      const map: TickerDensityMap = {};
      const ensure = (t: string) => (map[t] ??= emptyDensity());

      // ── attention + lastNote: merge obs/flags/alerts ──
      type NoteRow = {
        kind: 'observation' | 'flag' | 'alert';
        id: string;
        instruments: string[] | null;
        text: string;
        attention_score: number | null;
        created_at: string;
      };
      const notes: NoteRow[] = [];
      for (const r of (obs.data ?? []) as Array<Record<string, unknown>>) {
        const glance = (r.glance as string[] | null) ?? null;
        const txt = glance?.[0]?.trim() || ((r.observation as string | null) ?? '').slice(0, 140);
        notes.push({
          kind: 'observation',
          id: r.id as string,
          instruments: (r.instruments as string[] | null) ?? null,
          text: txt,
          attention_score: (r.attention_score as number | null) ?? null,
          created_at: r.created_at as string,
        });
      }
      for (const r of (flags.data ?? []) as Array<Record<string, unknown>>) {
        const glance = (r.glance as string[] | null) ?? null;
        const txt = glance?.[0]?.trim() || ((r.full_reasoning as string | null) ?? '').slice(0, 140);
        notes.push({
          kind: 'flag',
          id: r.id as string,
          instruments: (r.instruments as string[] | null) ?? null,
          text: txt,
          attention_score: (r.attention_score as number | null) ?? null,
          created_at: r.created_at as string,
        });
      }
      for (const r of (alerts.data ?? []) as Array<Record<string, unknown>>) {
        const glance = (r.glance as string[] | null) ?? null;
        const txt = glance?.[0]?.trim() || ((r.full_reasoning as string | null) ?? '').slice(0, 140);
        notes.push({
          kind: 'alert',
          id: r.id as string,
          instruments: (r.instruments as string[] | null) ?? null,
          text: txt,
          attention_score: (r.attention_score as number | null) ?? null,
          created_at: r.created_at as string,
        });
      }
      // Sort newest first so the first hit per ticker is the "last note".
      notes.sort((a, b) => b.created_at.localeCompare(a.created_at));
      for (const n of notes) {
        for (const t of n.instruments ?? []) {
          const T = (t ?? '').toUpperCase();
          if (!T) continue;
          const bucket = ensure(T);
          if (n.attention_score != null && n.attention_score > bucket.maxAttention) {
            bucket.maxAttention = n.attention_score;
          }
          if (!bucket.lastNote) {
            bucket.lastNote = {
              kind: n.kind,
              id: n.id,
              text: n.text,
              created_at: n.created_at,
              attention_score: n.attention_score,
            };
          }
        }
      }

      // ── sweep clusters today ──
      for (const r of (sweeps.data ?? []) as Array<Record<string, unknown>>) {
        const T = ((r.ticker as string) ?? '').toUpperCase();
        if (!T) continue;
        const bucket = ensure(T);
        bucket.sweeps.count += (r.sweep_count as number) ?? 0;
        bucket.sweeps.premium += (r.total_premium as number) ?? 0;
        if (!bucket.sweeps.lastSide) {
          bucket.sweeps.lastSide = (r.dominant_side as 'call' | 'put' | 'mixed' | null) ?? null;
        }
      }

      // ── DP clusters today ──
      for (const r of (dps.data ?? []) as Array<Record<string, unknown>>) {
        const T = ((r.ticker as string) ?? '').toUpperCase();
        if (!T) continue;
        const bucket = ensure(T);
        bucket.dps.count += (r.print_count as number) ?? 0;
        bucket.dps.notional += (r.total_notional as number) ?? 0;
      }

      // ── regime inversions today ──
      for (const r of (regimes.data ?? []) as Array<Record<string, unknown>>) {
        const T = ((r.ticker as string) ?? '').toUpperCase();
        if (!T) continue;
        ensure(T).regimeFlipped = true;
      }

      return map;
    },
  });
}
