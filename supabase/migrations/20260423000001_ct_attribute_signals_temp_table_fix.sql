-- Fix for ct-attribute-signals-nightly cron failures since 2026-04-22 22:40 UTC.
-- The cron runs ct_attribute_signals(7), ct_attribute_signals(14), and
-- ct_attribute_signals(30) in one SELECT — all three execute in one
-- transaction. Each call does CREATE TEMP TABLE tmp_returns ON COMMIT DROP,
-- and ON COMMIT DROP only fires at transaction commit. The second call
-- fails with "relation tmp_returns already exists".
--
-- Fix: DROP TABLE explicitly at function end so the function is safe to
-- call repeatedly within one transaction.

CREATE OR REPLACE FUNCTION public.ct_attribute_signals(
  p_lookback_days INT DEFAULT 30
) RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  v_count INT;
BEGIN
  DELETE FROM public.ct_edge_attribution WHERE lookback_days = p_lookback_days;

  -- Safety: if an earlier aborted call left the temp table around
  -- (shouldn't happen with ON COMMIT DROP, but belt + suspenders).
  DROP TABLE IF EXISTS tmp_returns;

  CREATE TEMP TABLE tmp_returns ON COMMIT DROP AS
  WITH events AS (
    SELECT *
    FROM public.ct_signal_events
    WHERE event_ts >= now() - make_interval(days => p_lookback_days)
      AND direction IN ('bullish','bearish')
      AND instrument IN ('SPY','QQQ','IWM','AAPL','MSFT','NVDA','META','GOOGL','AMZN','TSLA','GLD','USO')
  ),
  horizons(h) AS (VALUES (5),(15),(30),(60),(240),(390))
  SELECT
    e.signal_type, e.signal_subtype, e.direction, e.conviction_bucket,
    e.instrument, h.h AS horizon_mins,
    CASE e.direction WHEN 'bullish' THEN fr.alpha_pct  ELSE -fr.alpha_pct  END AS signed_alpha,
    CASE e.direction WHEN 'bullish' THEN fr.return_pct ELSE -fr.return_pct END AS signed_return,
    fr.spy_return_pct
  FROM events e
  CROSS JOIN horizons h
  CROSS JOIN LATERAL public.ct_forward_return(e.instrument, e.event_ts, h.h) fr
  WHERE fr.valid AND fr.alpha_pct IS NOT NULL;

  -- Aggregate (instrument='')
  INSERT INTO public.ct_edge_attribution (
    signal_type, signal_subtype, direction, conviction_bucket, instrument,
    horizon_mins, lookback_days,
    n, mean_alpha_pct, median_alpha_pct, stddev_alpha_pct, hit_rate, sharpe, t_stat,
    mean_return_pct, mean_spy_return_pct
  )
  SELECT
    signal_type, signal_subtype, direction, conviction_bucket, '',
    horizon_mins, p_lookback_days,
    count(*),
    round(avg(signed_alpha)::numeric, 4),
    round(percentile_cont(0.5) WITHIN GROUP (ORDER BY signed_alpha)::numeric, 4),
    round(stddev_samp(signed_alpha)::numeric, 4),
    round(avg((signed_alpha > 0)::int::numeric), 4),
    CASE WHEN stddev_samp(signed_alpha) > 0
         THEN round((avg(signed_alpha) / stddev_samp(signed_alpha))::numeric, 4) END,
    CASE WHEN stddev_samp(signed_alpha) > 0 AND count(*) > 1
         THEN round((avg(signed_alpha) / (stddev_samp(signed_alpha) / sqrt(count(*))))::numeric, 4) END,
    round(avg(signed_return)::numeric, 4),
    round(avg(spy_return_pct)::numeric, 4)
  FROM tmp_returns
  GROUP BY signal_type, signal_subtype, direction, conviction_bucket, horizon_mins;

  -- Per-ticker (instrument = actual ticker)
  INSERT INTO public.ct_edge_attribution (
    signal_type, signal_subtype, direction, conviction_bucket, instrument,
    horizon_mins, lookback_days,
    n, mean_alpha_pct, median_alpha_pct, stddev_alpha_pct, hit_rate, sharpe, t_stat,
    mean_return_pct, mean_spy_return_pct
  )
  SELECT
    signal_type, signal_subtype, direction, conviction_bucket, instrument,
    horizon_mins, p_lookback_days,
    count(*),
    round(avg(signed_alpha)::numeric, 4),
    round(percentile_cont(0.5) WITHIN GROUP (ORDER BY signed_alpha)::numeric, 4),
    round(stddev_samp(signed_alpha)::numeric, 4),
    round(avg((signed_alpha > 0)::int::numeric), 4),
    CASE WHEN stddev_samp(signed_alpha) > 0
         THEN round((avg(signed_alpha) / stddev_samp(signed_alpha))::numeric, 4) END,
    CASE WHEN stddev_samp(signed_alpha) > 0 AND count(*) > 1
         THEN round((avg(signed_alpha) / (stddev_samp(signed_alpha) / sqrt(count(*))))::numeric, 4) END,
    round(avg(signed_return)::numeric, 4),
    round(avg(spy_return_pct)::numeric, 4)
  FROM tmp_returns
  GROUP BY signal_type, signal_subtype, direction, conviction_bucket, instrument, horizon_mins
  HAVING count(*) >= 5;

  SELECT count(*) INTO v_count FROM public.ct_edge_attribution WHERE lookback_days = p_lookback_days;

  -- Drop the temp table explicitly so a subsequent call within the same
  -- transaction (e.g. the nightly cron that runs 7d + 14d + 30d) can
  -- recreate it without collision.
  DROP TABLE IF EXISTS tmp_returns;

  RETURN v_count;
END $$;
