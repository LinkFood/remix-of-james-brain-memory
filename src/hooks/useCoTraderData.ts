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
export async function triggerCoTrader(fn: 'watcher' | 'grader' | 'news_ingester' | 'eod_recap' | 'lessons_curator' | 'flow_ingester'): Promise<{ ok: boolean; error?: string }> {
  const rpcName = `trigger_ct_${fn}`;
  const { error } = await supabase.rpc(rpcName);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
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
