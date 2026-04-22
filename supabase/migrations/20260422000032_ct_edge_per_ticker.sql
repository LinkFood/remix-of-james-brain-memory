-- Per-ticker attribution. Same buckets, split by instrument so we can see
-- whether a signal works on SPY but not TSLA, or vice versa. Empty string
-- "" in instrument column = aggregate row (sums across all tickers); any
-- real ticker = that ticker only. Sentinel keeps the unique constraint clean.

ALTER TABLE public.ct_edge_attribution
  ADD COLUMN IF NOT EXISTS instrument TEXT NOT NULL DEFAULT '';

-- Drop old unique, add wider one that includes instrument
ALTER TABLE public.ct_edge_attribution
  DROP CONSTRAINT IF EXISTS ct_edge_attribution_signal_type_signal_subtype_direction_co_key;

ALTER TABLE public.ct_edge_attribution
  ADD CONSTRAINT ct_edge_attribution_unique
  UNIQUE (signal_type, signal_subtype, direction, conviction_bucket, horizon_mins, lookback_days, instrument);

-- Redefine the attribute RPC to write both aggregate rows (instrument='')
-- AND per-ticker rows in the same transaction. Aggregates stay the default
-- on /edge; per-ticker surfaces when a ticker is selected.

CREATE OR REPLACE FUNCTION public.ct_attribute_signals(
  p_lookback_days INT DEFAULT 30
) RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  v_count INT;
BEGIN
  DELETE FROM public.ct_edge_attribution WHERE lookback_days = p_lookback_days;

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
  HAVING count(*) >= 5;  -- don't bloat with n<5 per-ticker rows

  GET DIAGNOSTICS v_count = ROW_COUNT;
  -- v_count only captures the last INSERT; report total rows written
  SELECT count(*) INTO v_count FROM public.ct_edge_attribution WHERE lookback_days = p_lookback_days;
  RETURN v_count;
END $$;

-- Extend ct_top_edge_priors to accept an optional ticker filter; aggregate rows
-- still returned by default (instrument = '').

CREATE OR REPLACE FUNCTION public.ct_top_edge_priors(
  p_max_priors  INT     DEFAULT 8,
  p_min_n       INT     DEFAULT 30,
  p_min_abs_t   NUMERIC DEFAULT 3.0,
  p_lookback    INT     DEFAULT 7,
  p_instrument  TEXT    DEFAULT ''
) RETURNS TABLE (
  signal_type       TEXT,
  signal_subtype    TEXT,
  direction         TEXT,
  conviction_bucket TEXT,
  horizon_mins      INT,
  n                 INT,
  mean_alpha_pct    NUMERIC,
  hit_rate          NUMERIC,
  t_stat            NUMERIC,
  instrument        TEXT,
  summary           TEXT
)
LANGUAGE sql STABLE
AS $$
  SELECT
    ea.signal_type, ea.signal_subtype, ea.direction, ea.conviction_bucket,
    ea.horizon_mins, ea.n, ea.mean_alpha_pct, ea.hit_rate, ea.t_stat,
    ea.instrument,
    ea.signal_type || '/' || ea.signal_subtype || '/' || ea.direction
      || '@' || ea.horizon_mins::text || 'm'
      || CASE WHEN ea.instrument <> '' THEN ' [' || ea.instrument || ']' ELSE '' END
      || ': α' || CASE WHEN ea.mean_alpha_pct >= 0 THEN '+' ELSE '' END
      || round(ea.mean_alpha_pct, 2)::text || '%, hit '
      || round(ea.hit_rate * 100)::text || '%, n='
      || ea.n::text || ', t='
      || CASE WHEN ea.t_stat >= 0 THEN '+' ELSE '' END
      || round(ea.t_stat, 1)::text
      AS summary
  FROM public.ct_edge_attribution ea
  WHERE ea.lookback_days = p_lookback
    AND ea.instrument = p_instrument
    AND ea.n >= p_min_n
    AND ea.mean_alpha_pct IS NOT NULL
    AND ea.mean_alpha_pct > 0
    AND ABS(ea.t_stat) >= p_min_abs_t
  ORDER BY ABS(ea.t_stat) DESC
  LIMIT p_max_priors;
$$;
