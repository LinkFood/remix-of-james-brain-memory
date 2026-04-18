/**
 * useDrawdownAlerts — today's ct_drawdown_alerts rows.
 *
 * Rows are inserted by the ct-drawdown-watch cron when the book breaches
 * WARN (-1% intraday) or URGENT (-2% intraday OR -3% from HWM) thresholds.
 * Dedupe is via UNIQUE(session_date, tier) — at most one WARN and one URGENT
 * per session.
 *
 * 60s refresh — matches BookEquityCurve cadence.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface DrawdownAlertRow {
  id: string;
  session_date: string;
  tier: 'warn' | 'urgent';
  intraday_pnl_pct: number;
  drawdown_from_hwm_pct: number;
  equity_at_trigger: number;
  created_at: string;
}

export function useDrawdownAlerts() {
  return useQuery<DrawdownAlertRow[]>({
    queryKey: ['ct_drawdown_alerts_today'],
    refetchInterval: 60_000,
    queryFn: async () => {
      const today = new Date().toISOString().slice(0, 10);
      const { data, error } = await supabase
        .from('ct_drawdown_alerts')
        .select('id, session_date, tier, intraday_pnl_pct, drawdown_from_hwm_pct, equity_at_trigger, created_at')
        .eq('session_date', today)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data ?? []) as DrawdownAlertRow[];
    },
  });
}
