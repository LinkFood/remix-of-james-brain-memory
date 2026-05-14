-- =============================================================================
-- Ship 9a — alarm tier threshold recalibration after 5/1 corpus shift.
--
-- Context
-- -------
-- The signature_watcher tier thresholds were calibrated against a corpus that
-- the 2026-05-01 flag-grader silent-exit class-kill (commit c951c59) later
-- revealed was polluted. Pre-fix grader treated option price as spot for
-- detector_alarm + specialist sources, producing absurd "+3693% win" outcomes
-- that inflated peak_contract_pct in ct_contract_tracks. ct_signature_magnitude_stats
-- (median_peak_pct, p75_peak_pct, p90_peak_pct) is computed as percentiles over
-- those peak_contract_pct values, so the pre-fix corpus carried medians clustered
-- near 1.0+ (the polluted ceiling).
--
-- The 5/1 fix wiped 51 corrupt grades + reset their flags, then drained ~1300
-- backlog flags with honest grading. From 2026-05-04 onward, ct_signature_alarm_log
-- shows the honest distribution:
--
--   Pre-5/2 (n=1000, polluted): P50=0.755, P75=0.939, P95=1.378, max=1.379
--   Post-5/4 (n=158, honest):   P50=0.000, P75=0.007, P95=0.017, max=0.031
--
-- The old tier thresholds (silver 0.50 / gold 1.0 / silver-alone 2.0) now sit
-- 30-100x above the empirical ceiling. Gold has not fired structurally since
-- 5/4. Bronze fires only via the score>=80 score-alone path. The signature-axis
-- of every tier predicate is effectively dead.
--
-- Resolution
-- ----------
-- Recalibrate each peak_pct floor to a fixed quantile of the post-5/4
-- distribution. UPDATE existing ct_config rows (the wiring already exists from
-- 20260427000060_alarm_tiers.sql per Tenet 16). Old keys
-- signature_alarm_min_peak_pct / signature_alarm_min_n stay at legacy values --
-- they are referenced by the v1 single-threshold path, not the tier evaluator.
--
-- Empirical anchors (post-5/4 n=158):
--   bronze_min_peak_pct: 0.50 -> 0.003   (~P60 — selective but reachable)
--   silver_min_peak_pct: 0.50 -> 0.008   (~P80 — combined-with-score tier)
--   gold_min_peak_pct:   1.0  -> 0.015   (~P95 — both-layers-strong ceiling)
--   silver_high_sig_peak_pct: 2.0 -> 0.025  (~P99 — true signature-alone exception)
--
-- n thresholds unchanged: n distribution is bimodal (0 vs 25+); when nonzero,
-- P50=25 / P75=50. The legacy bronze=3 / silver=5 / gold=10 still gate the
-- "matched a real signature class" condition cleanly.
--
-- Score thresholds unchanged: ct_scored_flow.score is computed independently
-- of peak_contract_pct and was not affected by the grader fix.
-- =============================================================================

SET search_path = public, extensions;

-- Bronze floor — UI glow only, no Slack.
UPDATE public.ct_config
  SET value = '0.003'::jsonb,
      description = 'Bronze tier signature floor (recalibrated 2026-05-14 — Ship 9a — to post-5/1 corpus P60). UI glow only, no Slack.',
      updated_at = now()
  WHERE key = 'signature_alarm_bronze_min_peak_pct';

-- Silver combined floor.
UPDATE public.ct_config
  SET value = '0.008'::jsonb,
      description = 'Silver tier combined signature median floor (recalibrated 2026-05-14 — Ship 9a — to post-5/1 corpus P80). Combined with score >= 70.',
      updated_at = now()
  WHERE key = 'signature_alarm_silver_min_peak_pct';

-- Gold floor — both layers strong.
UPDATE public.ct_config
  SET value = '0.015'::jsonb,
      description = 'Gold tier signature median floor (recalibrated 2026-05-14 — Ship 9a — to post-5/1 corpus P95). Both layers strong.',
      updated_at = now()
  WHERE key = 'signature_alarm_gold_min_peak_pct';

-- Silver-alone exceptional — signature without score support.
UPDATE public.ct_config
  SET value = '0.025'::jsonb,
      description = 'Silver tier signature-alone exceptional floor (recalibrated 2026-05-14 — Ship 9a — to post-5/1 corpus P99). True sig-only exception.',
      updated_at = now()
  WHERE key = 'signature_alarm_silver_high_sig_peak_pct';

-- Sanity check — log the new values for migration audit trail.
DO $body$
DECLARE
  bronze_v jsonb;
  silver_v jsonb;
  gold_v jsonb;
  sig_alone_v jsonb;
BEGIN
  SELECT value INTO bronze_v FROM public.ct_config WHERE key = 'signature_alarm_bronze_min_peak_pct';
  SELECT value INTO silver_v FROM public.ct_config WHERE key = 'signature_alarm_silver_min_peak_pct';
  SELECT value INTO gold_v   FROM public.ct_config WHERE key = 'signature_alarm_gold_min_peak_pct';
  SELECT value INTO sig_alone_v FROM public.ct_config WHERE key = 'signature_alarm_silver_high_sig_peak_pct';
  RAISE NOTICE 'Ship 9a recalibration applied — bronze=%, silver=%, gold=%, silver_high_sig=%',
    bronze_v, silver_v, gold_v, sig_alone_v;
END $body$;
