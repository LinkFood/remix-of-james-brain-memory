-- ct_print_grades — add contract-axis grade columns (Phase C of contract grading).
--
-- Why this exists
--   ct_print_grades was designed v1 with grading_method='underlying_v1' rows
--   that store underlying_at_print / underlying_at_horizon. Phase C introduces
--   a parallel pass writing grading_method='contract_v1' rows, scored against
--   per-share contract-price movement at the same 30m / 2h / eod / +1d
--   horizons. Both methods share the (alert_id, horizon, grading_method)
--   natural key so they coexist without conflict.
--
--   Two new columns capture the contract-axis prices. They are nullable
--   because:
--     - underlying_v1 rows leave them null (legacy rows + future ones).
--     - contract_v1 rows leave underlying_at_print / underlying_at_horizon
--       null (no underlying lookup in that pass).
--
--   actual_move_pct, magnitude_pct, grade, threshold_used are REUSED — their
--   semantics shift based on grading_method. For contract_v1:
--     * actual_move_pct = (contract_at_horizon - contract_at_print) / contract_at_print
--     * grade WIN bar  = DTE-bucketed magnitude (asymmetric — the WIN
--       threshold differs by DTE bucket via ct_config.contract_grade_threshold_*).
--     * grade LOSS bar = fixed -50% drawdown via ct_config.contract_loss_threshold_pct.
--     * threshold_used = the WIN-axis DTE-bucket threshold at grade time.
--
-- Tenet 4 (ground-up, no band-aids): adding new columns to coexist with
--   underlying_v1 instead of overloading the existing two columns. Both
--   axes preserved forever, no implicit reinterpretation needed.
-- Tenet 7 (every number tunable): no thresholds in this migration —
--   contract_grade_threshold_* and contract_loss_threshold_pct already
--   seeded by 20260426000010_contract_tracks.sql.
--
-- NO new ct_config keys (Phase A's migration already seeded the contract
-- thresholds). NO new cron schedule (existing ct-print-grader schedule
-- covers the new pass — same function).

SET search_path = public, extensions;

ALTER TABLE public.ct_print_grades
  ADD COLUMN IF NOT EXISTS contract_at_print     numeric,
  ADD COLUMN IF NOT EXISTS contract_at_horizon   numeric;

COMMENT ON COLUMN public.ct_print_grades.contract_at_print IS
  'Per-share contract entry price at print time (contract_v1 rows only). Null on underlying_v1 rows.';
COMMENT ON COLUMN public.ct_print_grades.contract_at_horizon IS
  'Per-share contract price at the horizon timestamp (contract_v1 rows only). Null on underlying_v1 rows.';
