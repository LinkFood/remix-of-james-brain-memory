-- Ship 1 (v2) — recalibrate grader.alarm_win_pct / alarm_loss_pct to empirical P75.
--
-- Background: prior values (50/50/40/30/20 win, 30/30/25/20/15 loss) were tuned
-- against the 5/02 calibration window (4-day, 1,395 grades). The forensic 5/2
-- corpus shift and 12 days of post-corpus tape have moved the realized peak
-- distribution. Under prior bars only ~13.6% of qualifying flags grade WIN —
-- too tight against the realized peak distribution, blanking out the WIN signal
-- at the short end and starving the grader feedback loop.
--
-- Phase A method (terminal-Claude, 2026-05-14):
--   Pulled every ct_contract_tracks row with peak_contract_pct IS NOT NULL and
--   first_tracked_at >= 2026-05-07 (7d window). n=2,359 rows, bucketed into the
--   grader's 5-bucket DTE shape (0dte / 1_3d / 4_14d / 15_45d / 46d_plus),
--   computed percentile_cont(0.75) per bucket on the decimal peak_contract_pct
--   distribution. Converted to percent-int to match ct_config storage shape.
--
-- Per-bucket Phase A result (n / P75 decimal / P75 percent-int):
--   0dte      n=199  P75=0.1261  →  13
--   1_3d      n=322  P75=0.0984  →  10
--   4_14d     n=564  P75=0.0483  →   5
--   15_45d    n=404  P75=0.0045  →   0  (FLOORED to 5 — see below)
--   46d_plus  n=870  P75=0.0000  →   0  (FLOORED to 5 — see below)
--
-- 5-bucket-canonical decision: computed against the grader's 5-bucket DTE shape
-- rather than translating from the 4-bucket ct_contract_threshold_distribution
-- RPC. The 4-bucket short=1-7d folds the 1_3d high-vol scalp regime together
-- with the 4_14d swing regime — different distributions, not safely poolable.
-- Ship 1 makes 5-bucket canonical and updates the RPC overload in companion
-- migration to match. Granularity gain aligns the calibration probe with the
-- production grader.
--
-- Long-end floor (15_45d, 46d_plus): empirical P75 ≈ 0 because contracts that
-- far out don't develop within the 7d tracking window — peak quote rarely
-- exceeds print. Setting WIN bar at 0pct would grade every positive tick as WIN,
-- inverting the grade semantic. Floored both long buckets at 5pct as a
-- meaningful-move sentinel — preserves WIN semantic without overstating bar
-- against a degenerate distribution. Wider-window re-derivation for the long
-- end is queued for Ship 9 post-D2.2.
--
-- Loss bar: held to ~0.6 of new WIN per bucket (slightly compressed at the
-- long end to keep loss bar above noise floor). Approx values:
--   0dte:     13 × 0.6 ≈ 8
--   1_3d:     10 × 0.6 ≈ 6
--   4_14d:     5 × 0.6 ≈ 3
--   15_45d:    5 × 0.6 ≈ 3
--   46d_plus:  5 × 0.6 ≈ 3
--
-- Companion warden invariant (threshold_calibration_drift_detector, migration
-- 20260514191934) reads these values vs live ct_contract_threshold_distribution
-- output weekly and surfaces drift > warden_threshold_drift_max_pct (default
-- 0.20 = 20pct).
--
-- Tier-threshold values (signature_watcher category) NOT touched in this ship —
-- Ship 9 (post-5/2-corpus Phase A) addresses them separately per captain brief.

SET search_path = public, extensions;

-- Recalibrate grader.alarm_win_pct.* to empirical P75 (long end floored at 5pct)
INSERT INTO public.ct_config (key, value, description, category, default_value) VALUES
  ('grader.alarm_win_pct.0dte', '13'::jsonb,
    'Contract-axis grader: peak pct threshold for 0DTE win. Empirical P75 over n=199 tracks 5/07-5/14 (Ship 1 5/14).',
    'grader', '13'::jsonb),
  ('grader.alarm_win_pct.1_3d', '10'::jsonb,
    'Contract-axis grader: peak pct threshold for 1-3d win. Empirical P75 over n=322 tracks 5/07-5/14 (Ship 1 5/14).',
    'grader', '10'::jsonb),
  ('grader.alarm_win_pct.4_14d', '5'::jsonb,
    'Contract-axis grader: peak pct threshold for 4-14d win. Empirical P75 over n=564 tracks 5/07-5/14 (Ship 1 5/14).',
    'grader', '5'::jsonb),
  ('grader.alarm_win_pct.15_45d', '5'::jsonb,
    'Contract-axis grader: peak pct threshold for 15-45d win. Empirical P75=0.45pct over n=404 floored to 5pct meaningful-move sentinel (Ship 1 5/14).',
    'grader', '5'::jsonb),
  ('grader.alarm_win_pct.46d_plus', '5'::jsonb,
    'Contract-axis grader: peak pct threshold for 46d+ win. Empirical P75=0.00pct over n=870 floored to 5pct meaningful-move sentinel (Ship 1 5/14).',
    'grader', '5'::jsonb),
  ('grader.alarm_loss_pct.0dte', '8'::jsonb,
    'Contract-axis grader: drawdown pct threshold for 0DTE loss. ~0.6 of new WIN bar (Ship 1 5/14).',
    'grader', '8'::jsonb),
  ('grader.alarm_loss_pct.1_3d', '6'::jsonb,
    'Contract-axis grader: drawdown pct threshold for 1-3d loss. ~0.6 of new WIN bar (Ship 1 5/14).',
    'grader', '6'::jsonb),
  ('grader.alarm_loss_pct.4_14d', '3'::jsonb,
    'Contract-axis grader: drawdown pct threshold for 4-14d loss. ~0.6 of new WIN bar (Ship 1 5/14).',
    'grader', '3'::jsonb),
  ('grader.alarm_loss_pct.15_45d', '3'::jsonb,
    'Contract-axis grader: drawdown pct threshold for 15-45d loss. ~0.6 of new WIN bar (Ship 1 5/14).',
    'grader', '3'::jsonb),
  ('grader.alarm_loss_pct.46d_plus', '3'::jsonb,
    'Contract-axis grader: drawdown pct threshold for 46d+ loss. ~0.6 of new WIN bar (Ship 1 5/14).',
    'grader', '3'::jsonb)
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value,
      description = EXCLUDED.description,
      updated_at = now();

-- Drift-detector ceiling (Tenet 16 — threshold lives in DB, not warden code)
INSERT INTO public.ct_config (key, value, description, category, default_value) VALUES
  ('warden_threshold_drift_max_pct', '0.20'::jsonb,
    'Max relative drift fraction between configured grader thresholds and empirical P75 before threshold_calibration_drift_detector fires WARN. Default 0.20 = 20pct (Ship 1 5/14).',
    'warden', '0.20'::jsonb)
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value,
      description = EXCLUDED.description,
      updated_at = now();
