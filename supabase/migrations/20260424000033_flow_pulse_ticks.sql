-- FlowPulse Phase 1 — time-series snapshots.
--
-- ct_flow_pulse() returns the current directional imbalance. Phase 1 captures
-- that output every 5 min into ct_flow_pulse_ticks so by the weekend we have
-- a full intraday series to render sparklines against. Phase 2 (weekend)
-- builds the UI — see project_co_trader_flow_pulse_phase2.md.
--
-- Storage footprint: 10 tickers × 78 ticks/RTH day = ~780 rows/day. Trivial.

SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS public.ct_flow_pulse_ticks (
  id                      BIGSERIAL PRIMARY KEY,
  tick_time               TIMESTAMPTZ NOT NULL DEFAULT now(),
  ticker                  TEXT NOT NULL,
  window_min              INT NOT NULL,
  calls_count             INTEGER NOT NULL,
  puts_count              INTEGER NOT NULL,
  calls_otm_count         INTEGER NOT NULL,
  calls_itm_count         INTEGER NOT NULL,
  puts_otm_count          INTEGER NOT NULL,
  puts_itm_count          INTEGER NOT NULL,
  calls_premium           NUMERIC NOT NULL DEFAULT 0,
  puts_premium            NUMERIC NOT NULL DEFAULT 0,
  call_put_ratio          NUMERIC,
  premium_net             NUMERIC NOT NULL DEFAULT 0,
  cp_ratio_baseline_30d   NUMERIC,
  cp_ratio_deviation      NUMERIC,
  is_unusual              BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_ct_flow_pulse_ticks_ticker_time
  ON public.ct_flow_pulse_ticks (ticker, tick_time DESC);

CREATE INDEX IF NOT EXISTS idx_ct_flow_pulse_ticks_time
  ON public.ct_flow_pulse_ticks (tick_time DESC);

ALTER TABLE public.ct_flow_pulse_ticks ENABLE ROW LEVEL SECURITY;

CREATE POLICY ct_flow_pulse_ticks_read ON public.ct_flow_pulse_ticks
  FOR SELECT TO authenticated USING (true);

CREATE POLICY ct_flow_pulse_ticks_service ON public.ct_flow_pulse_ticks
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Capture function — called by cron. Inserts one row per watchlist ticker
-- using the 60-min window (captures immediate directional state, not the full
-- today aggregate — that gives sparkline resolution for intraday shifts).
CREATE OR REPLACE FUNCTION public.ct_flow_pulse_capture()
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public, extensions
AS $fn$
DECLARE
  v_inserted INTEGER := 0;
  v_window INT := 60;
BEGIN
  INSERT INTO public.ct_flow_pulse_ticks (
    tick_time, ticker, window_min,
    calls_count, puts_count,
    calls_otm_count, calls_itm_count, puts_otm_count, puts_itm_count,
    calls_premium, puts_premium,
    call_put_ratio, premium_net,
    cp_ratio_baseline_30d, cp_ratio_deviation, is_unusual
  )
  SELECT
    now(), ticker, v_window,
    calls_count, puts_count,
    calls_otm_count, calls_itm_count, puts_otm_count, puts_itm_count,
    calls_premium, puts_premium,
    call_put_ratio, premium_net,
    cp_ratio_baseline_30d, cp_ratio_deviation, COALESCE(is_unusual, FALSE)
  FROM public.ct_flow_pulse(v_window, NULL);

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END
$fn$;

GRANT EXECUTE ON FUNCTION public.ct_flow_pulse_capture() TO authenticated, service_role;

-- Cron — every 5 min during RTH weekdays, direct plpgsql call (no HTTP).
DO $$
BEGIN
  PERFORM cron.unschedule('ct-flow-pulse-capture');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'ct-flow-pulse-capture',
  '*/5 13-20 * * 1-5',
  $cron$SELECT public.ct_flow_pulse_capture()$cron$
);
