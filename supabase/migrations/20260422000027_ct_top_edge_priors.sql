-- ct_top_edge_priors: returns the handful of signals that cleared multi-
-- comparison significance, pre-formatted for injection into Claude's prompts.
-- Called by _shared/edgePriors.ts on every generator/watcher turn.
--
-- Defaults: top 8 signals, n>=30, |t_stat|>=3.0 (survives Bonferroni over
-- ~80 buckets at p<0.001). Callers can override.

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
    format(
      '%s/%s/%s@%sm: α%s%%, hit %s%%, n=%s, t=%s',
      ea.signal_type,
      ea.signal_subtype,
      ea.direction,
      ea.horizon_mins::text,
      to_char(ea.mean_alpha_pct, 'FM+0.00;-0.00'),
      to_char(ea.hit_rate * 100, 'FM0'),
      ea.n::text,
      to_char(ea.t_stat, 'FM+0.0;-0.0')
    ) AS summary
  FROM public.ct_edge_attribution ea
  WHERE ea.lookback_days = p_lookback
    AND ea.n >= p_min_n
    AND ea.mean_alpha_pct IS NOT NULL
    AND ea.mean_alpha_pct > 0
    AND ABS(ea.t_stat) >= p_min_abs_t
  ORDER BY ABS(ea.t_stat) DESC
  LIMIT p_max_priors;
$$;

GRANT EXECUTE ON FUNCTION public.ct_top_edge_priors(INT, INT, NUMERIC, INT)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.ct_top_edge_priors IS
  'Top empirical priors from ct_edge_attribution for prompt injection. Only returns signals with positive α and |t|>=3 (Bonferroni-ish for ~80 buckets).';
