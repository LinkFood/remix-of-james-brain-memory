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

export interface CtEvent {
  id: string;
  _type: 'observation' | 'flag' | 'alert';
  instruments: string[];
  direction: string | null;
  conviction: number | null;
  horizon: string | null;
  glance: string[] | null;
  full_reasoning: string | null;
  alert_trigger: string | null;
  created_at: string;
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
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as Heartbeat | null;
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
        supabase.from('ct_observations').select('id, instruments, direction, glance, observation, created_at').order('created_at', { ascending: false }).limit(limit),
        supabase.from('ct_flags').select('id, instruments, direction, conviction, horizon, glance, full_reasoning, created_at').order('created_at', { ascending: false }).limit(limit),
        supabase.from('ct_alerts').select('id, instruments, direction, conviction, horizon, alert_trigger, glance, full_reasoning, created_at').order('created_at', { ascending: false }).limit(limit),
      ]);
      const items: CtEvent[] = [];
      for (const r of (obs.data ?? []) as Array<Record<string, unknown>>) items.push({ _type: 'observation', id: r.id as string, instruments: (r.instruments as string[]) ?? [], direction: (r.direction as string) ?? null, conviction: null, horizon: null, glance: (r.glance as string[]) ?? null, full_reasoning: (r.observation as string) ?? null, alert_trigger: null, created_at: r.created_at as string });
      for (const r of (flags.data ?? []) as Array<Record<string, unknown>>) items.push({ _type: 'flag', id: r.id as string, instruments: (r.instruments as string[]) ?? [], direction: (r.direction as string) ?? null, conviction: (r.conviction as number) ?? null, horizon: (r.horizon as string) ?? null, glance: (r.glance as string[]) ?? null, full_reasoning: (r.full_reasoning as string) ?? null, alert_trigger: null, created_at: r.created_at as string });
      for (const r of (alerts.data ?? []) as Array<Record<string, unknown>>) items.push({ _type: 'alert', id: r.id as string, instruments: (r.instruments as string[]) ?? [], direction: (r.direction as string) ?? null, conviction: (r.conviction as number) ?? null, horizon: (r.horizon as string) ?? null, glance: (r.glance as string[]) ?? null, full_reasoning: (r.full_reasoning as string) ?? null, alert_trigger: (r.alert_trigger as string) ?? null, created_at: r.created_at as string });
      items.sort((a, b) => b.created_at.localeCompare(a.created_at));
      return items.slice(0, limit);
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
        .select('id, instrument, news_headline, news_source, news_url, claude_take, impact, significance, created_at')
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
      const { data, error } = await supabase
        .from('ct_dark_pool_prints')
        .select('id, ticker, size, price, notional_value, executed_at, ingested_at')
        .order('ingested_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as DarkPoolPrint[];
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
    queryKey: ['ct_gex_timeseries', ticker, hours],
    refetchInterval: 60_000,
    queryFn: async () => {
      const since = new Date(Date.now() - hours * 3600_000).toISOString();
      const { data, error } = await supabase
        .from('ct_gex_timeseries')
        .select('ticker, snapshot_at, strike, call_gex, put_gex, net_gex, underlying_price, is_atm_band')
        .eq('ticker', ticker)
        .gte('snapshot_at', since)
        .order('snapshot_at', { ascending: true })
        .order('strike', { ascending: true })
        .limit(10000);
      if (error) throw error;
      return (data ?? []) as GexTimeseriesRow[];
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
