-- Cron schedules for the 4 new UW MCP ingesters shipped 2026-04-23.

-- Trigger RPCs
CREATE OR REPLACE FUNCTION public.trigger_ct_interval_flow_ingester()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
AS $fn$ SELECT public._ct_post('ct-interval-flow-ingester'); $fn$;

CREATE OR REPLACE FUNCTION public.trigger_ct_technicals_ingester()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
AS $fn$ SELECT public._ct_post('ct-technicals-ingester'); $fn$;

CREATE OR REPLACE FUNCTION public.trigger_ct_options_screener_ingester()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
AS $fn$ SELECT public._ct_post('ct-options-screener-ingester'); $fn$;

CREATE OR REPLACE FUNCTION public.trigger_ct_prediction_smart_money_ingester()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
AS $fn$ SELECT public._ct_post('ct-prediction-smart-money-ingester'); $fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_interval_flow_ingester()           TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.trigger_ct_technicals_ingester()              TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.trigger_ct_options_screener_ingester()        TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.trigger_ct_prediction_smart_money_ingester()  TO authenticated, service_role;

-- Schedules
DO $$
BEGIN
  -- Interval flow — every 15 min during RTH (14:00-20:00 UTC = 10am-4pm ET)
  PERFORM cron.unschedule('ct-interval-flow-ingester')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-interval-flow-ingester');
  PERFORM cron.schedule(
    'ct-interval-flow-ingester',
    '*/15 14-20 * * 1-5',
    $body$ SELECT public.trigger_ct_interval_flow_ingester(); $body$
  );

  -- Technicals — every 30 min during RTH + post-close snapshot at 21:05 UTC
  PERFORM cron.unschedule('ct-technicals-ingester')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-technicals-ingester');
  PERFORM cron.schedule(
    'ct-technicals-ingester',
    '*/30 14-21 * * 1-5',
    $body$ SELECT public.trigger_ct_technicals_ingester(); $body$
  );

  -- Options screener — every 30 min during RTH
  PERFORM cron.unschedule('ct-options-screener-ingester')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-options-screener-ingester');
  PERFORM cron.schedule(
    'ct-options-screener-ingester',
    '*/30 14-20 * * 1-5',
    $body$ SELECT public.trigger_ct_options_screener_ingester(); $body$
  );

  -- Prediction smart money — daily at 8:00 UTC (leaderboard moves slow)
  PERFORM cron.unschedule('ct-prediction-smart-money-ingester')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-prediction-smart-money-ingester');
  PERFORM cron.schedule(
    'ct-prediction-smart-money-ingester',
    '0 8 * * *',
    $body$ SELECT public.trigger_ct_prediction_smart_money_ingester(); $body$
  );

  -- Bump VIX cadence too — RTH mid-session capture at 15:00 + 18:30 UTC on
  -- top of the existing 21:05 close-of-day.
  PERFORM cron.unschedule('ct-vix-capture-midday')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-vix-capture-midday');
  PERFORM cron.schedule(
    'ct-vix-capture-midday',
    '0 15 * * 1-5',
    $body$ SELECT public._ct_post('ct-vix-capture'); $body$
  );
  PERFORM cron.unschedule('ct-vix-capture-late')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-vix-capture-late');
  PERFORM cron.schedule(
    'ct-vix-capture-late',
    '30 18 * * 1-5',
    $body$ SELECT public._ct_post('ct-vix-capture'); $body$
  );
END $$;
