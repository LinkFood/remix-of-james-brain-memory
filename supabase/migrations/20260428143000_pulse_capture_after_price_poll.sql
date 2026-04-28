-- Sequence ct-flow-pulse-capture AFTER ct-price-live-poll so spots are fresh.
--
-- Bug caught live 2026-04-28 9:35 ET: /tape rendered empty + Flow Butterfly
-- empty at the open. Root cause: ct-price-live-poll (HTTP edge function, takes
-- ~5-10s) and ct-flow-pulse-capture (direct plpgsql, runs in ~50ms) were both
-- scheduled at every-N-minutes starting minute 0. Pulse fired first, ran fast
-- against stale ct_ticker_snapshots, INNER JOIN on spot dropped every ticker
-- whose snapshot hadn't yet been refreshed for the new session. Pulse wrote
-- all-zero ticks, the cached series the UI reads.
--
-- Two changes:
--   1. Move pulse capture from `*/5 13-20` to `1-58/5 13-20` (= minutes 1, 6,
--      11, 16, 21, 26, 31, 36, 41, 46, 51, 56). Each fire is 1 min after the
--      every-2-min price-poll lane (which fires at 0, 2, 4...). Same 12 fires
--      per RTH hour — just shifted off the price-poll boundary.
--   2. Replace ct_flow_pulse() with a LEFT JOIN version. Even if spot is NULL
--      the pulse aggregates total counts + premium correctly (only OTM/ITM
--      bucketing degrades, which is acceptable). One missing snapshot row no
--      longer zeros the entire ticker.
--
-- Memory: feedback_pulse_capture_open_race.md
SET search_path = public, extensions;

-- ---- Reschedule the capture cron ----
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-flow-pulse-capture') THEN
    PERFORM cron.unschedule('ct-flow-pulse-capture');
  END IF;
END
$cron$;

SELECT cron.schedule(
  'ct-flow-pulse-capture',
  '1-58/5 13-20 * * 1-5',
  $cron$SELECT public.ct_flow_pulse_capture()$cron$
);

-- ---- Replace the RPC with LEFT JOIN on spots ----
CREATE OR REPLACE FUNCTION public.ct_flow_pulse(
  p_window_min INT DEFAULT 360,
  p_ticker     TEXT DEFAULT NULL
)
RETURNS TABLE(
  ticker                TEXT,
  calls_count           INTEGER,
  puts_count            INTEGER,
  calls_otm_count       INTEGER,
  calls_itm_count       INTEGER,
  puts_otm_count        INTEGER,
  puts_itm_count        INTEGER,
  calls_premium         NUMERIC,
  puts_premium          NUMERIC,
  call_put_ratio        NUMERIC,
  premium_net           NUMERIC,
  cp_ratio_baseline_30d NUMERIC,
  cp_ratio_deviation    NUMERIC,
  is_unusual            BOOLEAN
)
LANGUAGE sql STABLE
SET search_path = public, extensions
AS $$
  WITH wl AS (
    SELECT UNNEST(ARRAY['SPY','QQQ','IWM','AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA']) AS t
  ),
  targets AS (
    SELECT t FROM wl
    WHERE p_ticker IS NULL OR t = UPPER(p_ticker)
  ),
  spots AS (
    SELECT s.ticker, s.spot
    FROM public.ct_ticker_snapshots s
    WHERE s.ticker IN (SELECT t FROM targets)
  ),
  -- Current window: p_window_min back from now. LEFT JOIN spots so missing
  -- spot does not drop the row (only OTM/ITM bucketing degrades to 0).
  cur AS (
    SELECT
      sf.ticker,
      substring(sf.option_symbol, length(sf.option_symbol) - 8, 1) AS side_char,
      sf.strike,
      sf.premium,
      sp.spot
    FROM public.ct_scored_flow sf
    LEFT JOIN spots sp ON sp.ticker = sf.ticker
    WHERE sf.event_ts >= now() - (p_window_min || ' min')::interval
      AND sf.classification IN ('opening_buy','opening_sell')
      AND sf.ticker IN (SELECT t FROM targets)
      AND sf.option_symbol IS NOT NULL
      AND length(sf.option_symbol) >= 9
      AND sf.strike IS NOT NULL
  ),
  cur_agg AS (
    SELECT
      c.ticker,
      COUNT(*) FILTER (WHERE c.side_char = 'C')::INTEGER AS calls_count,
      COUNT(*) FILTER (WHERE c.side_char = 'P')::INTEGER AS puts_count,
      COUNT(*) FILTER (WHERE c.side_char = 'C' AND c.spot IS NOT NULL AND c.strike >= c.spot * 0.995)::INTEGER AS calls_otm_count,
      COUNT(*) FILTER (WHERE c.side_char = 'C' AND c.spot IS NOT NULL AND c.strike <  c.spot * 0.995)::INTEGER AS calls_itm_count,
      COUNT(*) FILTER (WHERE c.side_char = 'P' AND c.spot IS NOT NULL AND c.strike <= c.spot * 1.005)::INTEGER AS puts_otm_count,
      COUNT(*) FILTER (WHERE c.side_char = 'P' AND c.spot IS NOT NULL AND c.strike >  c.spot * 1.005)::INTEGER AS puts_itm_count,
      COALESCE(SUM(c.premium) FILTER (WHERE c.side_char = 'C'), 0)::NUMERIC AS calls_premium,
      COALESCE(SUM(c.premium) FILTER (WHERE c.side_char = 'P'), 0)::NUMERIC AS puts_premium
    FROM cur c
    GROUP BY c.ticker
  ),
  hist AS (
    SELECT
      sf.ticker,
      date_trunc('day', sf.event_ts) AS day_bucket,
      substring(sf.option_symbol, length(sf.option_symbol) - 8, 1) AS side_char
    FROM public.ct_scored_flow sf
    WHERE sf.event_ts >= now() - INTERVAL '30 days'
      AND sf.event_ts <  now() - (p_window_min || ' min')::interval
      AND sf.classification IN ('opening_buy','opening_sell')
      AND sf.ticker IN (SELECT t FROM targets)
      AND sf.option_symbol IS NOT NULL
      AND length(sf.option_symbol) >= 9
  ),
  hist_daily AS (
    SELECT
      h.ticker,
      h.day_bucket,
      COUNT(*) FILTER (WHERE h.side_char = 'C')::NUMERIC AS day_calls,
      COUNT(*) FILTER (WHERE h.side_char = 'P')::NUMERIC AS day_puts
    FROM hist h
    GROUP BY h.ticker, h.day_bucket
  ),
  hist_base AS (
    SELECT
      hd.ticker,
      AVG(hd.day_calls / GREATEST(hd.day_puts, 1))::NUMERIC AS baseline_ratio,
      SUM(hd.day_calls + hd.day_puts)::INTEGER AS baseline_events
    FROM hist_daily hd
    WHERE hd.day_calls >= 5 AND hd.day_puts >= 5
    GROUP BY hd.ticker
  )
  SELECT
    tg.t AS ticker,
    COALESCE(ca.calls_count, 0) AS calls_count,
    COALESCE(ca.puts_count, 0)  AS puts_count,
    COALESCE(ca.calls_otm_count, 0) AS calls_otm_count,
    COALESCE(ca.calls_itm_count, 0) AS calls_itm_count,
    COALESCE(ca.puts_otm_count, 0)  AS puts_otm_count,
    COALESCE(ca.puts_itm_count, 0)  AS puts_itm_count,
    COALESCE(ca.calls_premium, 0)   AS calls_premium,
    COALESCE(ca.puts_premium, 0)    AS puts_premium,
    (COALESCE(ca.calls_count, 0)::NUMERIC
      / GREATEST(COALESCE(ca.puts_count, 0), 1)) AS call_put_ratio,
    (COALESCE(ca.calls_premium, 0) - COALESCE(ca.puts_premium, 0)) AS premium_net,
    hb.baseline_ratio AS cp_ratio_baseline_30d,
    CASE
      WHEN hb.baseline_ratio IS NULL OR hb.baseline_ratio = 0 THEN NULL
      ELSE (COALESCE(ca.calls_count, 0)::NUMERIC
            / GREATEST(COALESCE(ca.puts_count, 0), 1))
           / hb.baseline_ratio
    END AS cp_ratio_deviation,
    (
      hb.baseline_ratio IS NOT NULL
      AND hb.baseline_ratio > 0
      AND (COALESCE(ca.calls_count, 0) + COALESCE(ca.puts_count, 0)) >= 20
      AND COALESCE(hb.baseline_events, 0) >= 20
      AND (
        ((COALESCE(ca.calls_count, 0)::NUMERIC
            / GREATEST(COALESCE(ca.puts_count, 0), 1)) / hb.baseline_ratio) >= 2.0
        OR
        ((COALESCE(ca.calls_count, 0)::NUMERIC
            / GREATEST(COALESCE(ca.puts_count, 0), 1)) / hb.baseline_ratio) <= 0.5
      )
    ) AS is_unusual
  FROM targets tg
  LEFT JOIN cur_agg ca  ON ca.ticker = tg.t
  LEFT JOIN hist_base hb ON hb.ticker = tg.t
  ORDER BY tg.t;
$$;

GRANT EXECUTE ON FUNCTION public.ct_flow_pulse(INT, TEXT) TO authenticated, service_role;
