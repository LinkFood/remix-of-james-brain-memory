-- Fall back to 5m bars when 1m bars aren't available (events older than the
-- 1m retention window, ~7 days). Political trades and older news events were
-- previously non-attributable; with 5m bars back 60d they become usable.
--
-- Logic per lookup (entry/exit × ticker/SPY):
--   1. try 1m bar within event_ts + 10m window
--   2. if nothing, try 5m bar within event_ts + 15m window
--   returns close price of whichever landed first

CREATE OR REPLACE FUNCTION public.ct_forward_return(
  p_ticker       TEXT,
  p_event_ts     TIMESTAMPTZ,
  p_horizon_mins INT
) RETURNS TABLE (
  entry_price     NUMERIC,
  exit_price      NUMERIC,
  return_pct      NUMERIC,
  spy_entry       NUMERIC,
  spy_exit        NUMERIC,
  spy_return_pct  NUMERIC,
  alpha_pct       NUMERIC,
  entry_ts        TIMESTAMPTZ,
  exit_ts         TIMESTAMPTZ,
  valid           BOOLEAN
)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_target_ts TIMESTAMPTZ := p_event_ts + make_interval(mins => p_horizon_mins);
BEGIN
  RETURN QUERY
  WITH
    entry_1m AS (
      SELECT close AS px, ts FROM public.ct_price_bars
      WHERE ticker = p_ticker AND timeframe = '1m'
        AND ts >= p_event_ts AND ts < p_event_ts + INTERVAL '10 minutes'
      ORDER BY ts ASC LIMIT 1
    ),
    entry_5m AS (
      SELECT close AS px, ts FROM public.ct_price_bars
      WHERE ticker = p_ticker AND timeframe = '5m'
        AND ts >= p_event_ts - INTERVAL '5 minutes' AND ts < p_event_ts + INTERVAL '15 minutes'
      ORDER BY ts ASC LIMIT 1
    ),
    exit_1m AS (
      SELECT close AS px, ts FROM public.ct_price_bars
      WHERE ticker = p_ticker AND timeframe = '1m'
        AND ts >= v_target_ts AND ts < v_target_ts + INTERVAL '10 minutes'
      ORDER BY ts ASC LIMIT 1
    ),
    exit_5m AS (
      SELECT close AS px, ts FROM public.ct_price_bars
      WHERE ticker = p_ticker AND timeframe = '5m'
        AND ts >= v_target_ts - INTERVAL '5 minutes' AND ts < v_target_ts + INTERVAL '15 minutes'
      ORDER BY ts ASC LIMIT 1
    ),
    spy_entry_1m AS (
      SELECT close AS px FROM public.ct_price_bars
      WHERE ticker = 'SPY' AND timeframe = '1m'
        AND ts >= p_event_ts AND ts < p_event_ts + INTERVAL '10 minutes'
      ORDER BY ts ASC LIMIT 1
    ),
    spy_entry_5m AS (
      SELECT close AS px FROM public.ct_price_bars
      WHERE ticker = 'SPY' AND timeframe = '5m'
        AND ts >= p_event_ts - INTERVAL '5 minutes' AND ts < p_event_ts + INTERVAL '15 minutes'
      ORDER BY ts ASC LIMIT 1
    ),
    spy_exit_1m AS (
      SELECT close AS px FROM public.ct_price_bars
      WHERE ticker = 'SPY' AND timeframe = '1m'
        AND ts >= v_target_ts AND ts < v_target_ts + INTERVAL '10 minutes'
      ORDER BY ts ASC LIMIT 1
    ),
    spy_exit_5m AS (
      SELECT close AS px FROM public.ct_price_bars
      WHERE ticker = 'SPY' AND timeframe = '5m'
        AND ts >= v_target_ts - INTERVAL '5 minutes' AND ts < v_target_ts + INTERVAL '15 minutes'
      ORDER BY ts ASC LIMIT 1
    ),
    merged AS (
      SELECT
        COALESCE((SELECT px FROM entry_1m), (SELECT px FROM entry_5m)) AS t_entry_px,
        COALESCE((SELECT ts FROM entry_1m), (SELECT ts FROM entry_5m)) AS t_entry_ts,
        COALESCE((SELECT px FROM exit_1m),  (SELECT px FROM exit_5m))  AS t_exit_px,
        COALESCE((SELECT ts FROM exit_1m),  (SELECT ts FROM exit_5m))  AS t_exit_ts,
        COALESCE((SELECT px FROM spy_entry_1m), (SELECT px FROM spy_entry_5m)) AS s_entry_px,
        COALESCE((SELECT px FROM spy_exit_1m),  (SELECT px FROM spy_exit_5m))  AS s_exit_px
    )
  SELECT
    t_entry_px,
    t_exit_px,
    CASE WHEN t_entry_px IS NOT NULL AND t_exit_px IS NOT NULL
         THEN ROUND(((t_exit_px - t_entry_px) / t_entry_px) * 100, 4) END,
    s_entry_px,
    s_exit_px,
    CASE WHEN s_entry_px IS NOT NULL AND s_exit_px IS NOT NULL
         THEN ROUND(((s_exit_px - s_entry_px) / s_entry_px) * 100, 4) END,
    CASE WHEN t_entry_px IS NOT NULL AND t_exit_px IS NOT NULL
         AND s_entry_px IS NOT NULL AND s_exit_px IS NOT NULL
         THEN ROUND((((t_exit_px - t_entry_px) / t_entry_px)
                   - ((s_exit_px - s_entry_px) / s_entry_px)) * 100, 4) END,
    t_entry_ts,
    t_exit_ts,
    (t_entry_px IS NOT NULL AND t_exit_px IS NOT NULL)
  FROM merged;
END $$;
