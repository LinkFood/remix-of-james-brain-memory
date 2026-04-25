-- ct_print_grades — directional outcome ledger for raw UW flow prints.
--
-- Why this exists
--   ct_flow_alerts holds 40k+ raw UW prints with no ground truth on whether
--   they paid off. Co-Trader's specialists score from these prints; the
--   scorer learned to detect VOLATILITY (MFE ≈ MAE across 4,300+ events)
--   instead of DIRECTION. This grader flips that — every print is graded
--   at multiple horizons against UNDERLYING price movement so we can mine
--   signatures that actually have directional edge.
--
-- Tenet 4 (ground-up, no band-aids): grading_method column is set today to
-- 'underlying_v1' so a future 'contract_v1' (option-price grading) can be
-- inserted alongside without re-grading or schema churn. (alert_id, horizon,
-- grading_method) is the natural key.
--
-- Tenet 5 (progress independent of P&L): grading runs on every UW print,
-- regardless of whether Claude flagged it. The dataset grows even on
-- flagless days.
--
-- Tenet 7 (every number tunable): horizon thresholds live in ct_config
-- (print_grade_threshold_*), NOT in code. Grader reads them every run.
--
-- Schema notes
--   - grade text is enum-by-convention: 'WIN' | 'LOSS' | 'FLAT'.
--   - actual_move_pct is signed (positive = up, negative = down) on the
--     UNDERLYING.
--   - magnitude_pct is the absolute move regardless of direction (useful for
--     volatility-vs-direction analysis later).
--   - threshold_used is recorded per row so a threshold change in ct_config
--     doesn't silently invalidate historical grades.

SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS public.ct_print_grades (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id              text NOT NULL,
  ticker                text NOT NULL,
  horizon               text NOT NULL,                  -- '30m' | '2h' | 'eod' | 'plus1d'
  print_time            timestamptz NOT NULL,
  horizon_time          timestamptz NOT NULL,
  predicted_direction   text NOT NULL,                  -- 'up' | 'down'
  predicted_source      text NOT NULL,                  -- 'opening_buy_call' | 'opening_buy_put' | 'aggressive_ask_call' | 'aggressive_ask_put' | 'aggressive_bid_call' | 'aggressive_bid_put'
  underlying_at_print   numeric,
  underlying_at_horizon numeric,
  actual_move_pct       numeric,                        -- signed % move of underlying (decimal, NOT percentage points)
  grade                 text NOT NULL,                  -- 'WIN' | 'LOSS' | 'FLAT'
  magnitude_pct         numeric,                        -- absolute |move|
  threshold_used        numeric,                        -- WIN/FLAT threshold at grade time
  grading_method        text NOT NULL DEFAULT 'underlying_v1',
  graded_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (alert_id, horizon, grading_method)
);

CREATE INDEX IF NOT EXISTS ct_print_grades_ticker_horizon
  ON public.ct_print_grades (ticker, horizon, graded_at DESC);

CREATE INDEX IF NOT EXISTS ct_print_grades_alert_id
  ON public.ct_print_grades (alert_id);

CREATE INDEX IF NOT EXISTS ct_print_grades_grade_ticker
  ON public.ct_print_grades (grade, ticker, graded_at DESC);

ALTER TABLE public.ct_print_grades ENABLE ROW LEVEL SECURITY;

CREATE POLICY ct_print_grades_authread ON public.ct_print_grades
  FOR SELECT TO authenticated USING (true);

CREATE POLICY ct_print_grades_svcall ON public.ct_print_grades
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ct_print_grades IS
  'Directional grades for every UW flow print at 30m / 2h / eod / plus1d horizons. Underlying-price grading (v1); contract-price grading (v2) layers in alongside via grading_method.';

-- ---------------------------------------------------------------------------
-- ct_config seeds — tunable horizon thresholds.
-- Decimal fractions, NOT percentage points: 0.001 = 0.1%, 0.005 = 0.5%.
-- ---------------------------------------------------------------------------
INSERT INTO public.ct_config (key, value, description, category, min_value, max_value, default_value) VALUES
  ('print_grade_threshold_30m', '0.001'::jsonb,
    '|move| threshold for WIN/LOSS at 30m horizon. Below = FLAT. Decimal fraction (0.001 = 0.1%).',
    'print_grader', 0.0, 0.05, '0.001'::jsonb),
  ('print_grade_threshold_2h', '0.003'::jsonb,
    '|move| threshold for WIN/LOSS at 2h horizon. Below = FLAT. Decimal fraction (0.003 = 0.3%).',
    'print_grader', 0.0, 0.05, '0.003'::jsonb),
  ('print_grade_threshold_eod', '0.005'::jsonb,
    '|move| threshold for WIN/LOSS at end-of-day horizon. Below = FLAT. Decimal fraction (0.005 = 0.5%).',
    'print_grader', 0.0, 0.05, '0.005'::jsonb),
  ('print_grade_threshold_plus1d', '0.008'::jsonb,
    '|move| threshold for WIN/LOSS at +1 trading day horizon. Below = FLAT. Decimal fraction (0.008 = 0.8%).',
    'print_grader', 0.0, 0.05, '0.008'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- pg_cron schedule — every 30 min, always (grading needs to catch up
-- post-close + on weekends so plus1d horizons close out).
-- ---------------------------------------------------------------------------
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-print-grader') THEN
    PERFORM cron.unschedule('ct-print-grader');
  END IF;

  PERFORM cron.schedule(
    'ct-print-grader',
    '*/30 * * * *',
    $body$SELECT public.invoke_edge_function('ct-print-grader', '{}'::jsonb);$body$
  );
END
$cron$;
