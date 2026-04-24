-- v2 Ticker Baselines Nightly Rollup
--
-- Populates ct_ticker_baselines used by ct_scored_flow's size_vs_adv factor (10%
-- of composite score). Runs post-close at 22:45 UTC and writes one row per
-- ticker per day for the 10-ticker watchlist.
--
-- Notes on data sources:
--  * ct_sweeps.snapshot_at drives sweep stats window (last 30 days).
--  * ct_flow_alerts uses COALESCE(ingested_at, executed_at); ingested_at is
--    reliably populated, executed_at is sometimes null.
--  * ct_ticker_snapshots is a cache overwritten per refresh (one row per
--    ticker, no history). "iv_rank_30d" therefore reflects the CURRENT iv_rank,
--    not a rolling mean. Documented here and in the function body so nobody
--    is surprised by the column semantics.

CREATE OR REPLACE FUNCTION public.ct_rollup_ticker_baselines(p_as_of DATE DEFAULT CURRENT_DATE)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_count INTEGER := 0;
  v_wl TEXT[] := ARRAY['SPY','QQQ','IWM','AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA'];
  v_start TIMESTAMPTZ := p_as_of::timestamp - INTERVAL '30 days';
  v_end   TIMESTAMPTZ := p_as_of::timestamp;
BEGIN
  -- NOTE: iv_rank_30d below is CURRENT iv_rank, not a 30-day mean.
  -- ct_ticker_snapshots has one row per ticker (cache, overwritten on refresh).
  -- Adjust when a historical iv_rank table lands.
  WITH sweep_stats AS (
    SELECT
      ticker,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY premium) AS median_prem,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY premium) AS p90_prem,
      count(*)::numeric / GREATEST(extract(epoch FROM (v_end - v_start)) / 3600, 1) AS hourly_count,
      count(*) FILTER (WHERE premium >= 500000) AS whale_count,
      sum(COALESCE(volume, 0))::bigint AS sweep_volume
    FROM public.ct_sweeps
    WHERE ticker = ANY(v_wl)
      AND snapshot_at >= v_start
      AND snapshot_at < v_end
    GROUP BY ticker
  ),
  flow_stats AS (
    SELECT
      ticker,
      count(*) AS flow_count,
      sum(COALESCE(volume, 0))::bigint AS flow_volume
    FROM public.ct_flow_alerts
    WHERE ticker = ANY(v_wl)
      AND COALESCE(ingested_at, executed_at) >= v_start
      AND COALESCE(ingested_at, executed_at) < v_end
    GROUP BY ticker
  ),
  iv_stats AS (
    SELECT ticker, avg(iv_rank::numeric) AS avg_iv_rank
    FROM public.ct_ticker_snapshots
    WHERE ticker = ANY(v_wl)
    GROUP BY ticker
  )
  INSERT INTO public.ct_ticker_baselines (
    ticker, baseline_date,
    median_sweep_premium, p90_sweep_premium,
    avg_sweep_count_hourly, avg_flow_alerts_daily,
    avg_whale_count_daily, options_adv_30d, iv_rank_30d
  )
  SELECT
    w.t,
    p_as_of,
    COALESCE(s.median_prem, 0),
    COALESCE(s.p90_prem, 0),
    COALESCE(s.hourly_count, 0),
    COALESCE(f.flow_count::numeric / 30, 0),
    COALESCE(s.whale_count::numeric / 30, 0),
    -- options ADV = avg daily total contract volume across sweeps + flow alerts
    (COALESCE(s.sweep_volume, 0) + COALESCE(f.flow_volume, 0))::numeric / 30,
    COALESCE(iv.avg_iv_rank, 0)
  FROM unnest(v_wl) AS w(t)
  LEFT JOIN sweep_stats s  ON s.ticker  = w.t
  LEFT JOIN flow_stats  f  ON f.ticker  = w.t
  LEFT JOIN iv_stats    iv ON iv.ticker = w.t
  ON CONFLICT (ticker, baseline_date) DO UPDATE SET
    median_sweep_premium    = EXCLUDED.median_sweep_premium,
    p90_sweep_premium       = EXCLUDED.p90_sweep_premium,
    avg_sweep_count_hourly  = EXCLUDED.avg_sweep_count_hourly,
    avg_flow_alerts_daily   = EXCLUDED.avg_flow_alerts_daily,
    avg_whale_count_daily   = EXCLUDED.avg_whale_count_daily,
    options_adv_30d         = EXCLUDED.options_adv_30d,
    iv_rank_30d             = EXCLUDED.iv_rank_30d,
    computed_at             = now();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

GRANT EXECUTE ON FUNCTION public.ct_rollup_ticker_baselines(DATE) TO authenticated, service_role;

-- Schedule the nightly rollup at 22:45 UTC every day.
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-ticker-baselines-nightly') THEN
    PERFORM cron.unschedule('ct-ticker-baselines-nightly');
  END IF;

  PERFORM cron.schedule(
    'ct-ticker-baselines-nightly',
    '45 22 * * *',
    $body$ SELECT public.ct_rollup_ticker_baselines(); $body$
  );
END
$cron$;
