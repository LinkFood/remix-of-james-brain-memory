-- Fix: to_char format templates failed with "multiple decimal points".
-- Rewrite summary with plain concat + round + sign prefix.

CREATE OR REPLACE FUNCTION public.ct_top_edge_priors(
  p_max_priors  INT     DEFAULT 8,
  p_min_n       INT     DEFAULT 30,
  p_min_abs_t   NUMERIC DEFAULT 3.0,
  p_lookback    INT     DEFAULT 7
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
  summary           TEXT
)
LANGUAGE sql STABLE
AS $$
  SELECT
    ea.signal_type,
    ea.signal_subtype,
    ea.direction,
    ea.conviction_bucket,
    ea.horizon_mins,
    ea.n,
    ea.mean_alpha_pct,
    ea.hit_rate,
    ea.t_stat,
    ea.signal_type || '/' || ea.signal_subtype || '/' || ea.direction
      || '@' || ea.horizon_mins::text || 'm: α'
      || CASE WHEN ea.mean_alpha_pct >= 0 THEN '+' ELSE '' END
      || round(ea.mean_alpha_pct, 2)::text || '%, hit '
      || round(ea.hit_rate * 100)::text || '%, n='
      || ea.n::text || ', t='
      || CASE WHEN ea.t_stat >= 0 THEN '+' ELSE '' END
      || round(ea.t_stat, 1)::text
      AS summary
  FROM public.ct_edge_attribution ea
  WHERE ea.lookback_days = p_lookback
    AND ea.n >= p_min_n
    AND ea.mean_alpha_pct IS NOT NULL
    AND ea.mean_alpha_pct > 0
    AND ABS(ea.t_stat) >= p_min_abs_t
  ORDER BY ABS(ea.t_stat) DESC
  LIMIT p_max_priors;
$$;
