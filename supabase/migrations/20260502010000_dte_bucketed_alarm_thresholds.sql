-- =============================================================================
-- 20260502010000_dte_bucketed_alarm_thresholds.sql
--
-- Replaces the flat 50%/30% peak/drawdown thresholds in computeAlarmOutcome
-- with per-DTE-bucket thresholds. Long-DTE contracts rarely move 50% intraday
-- (lower IV + time-decay drag), so the flat threshold under-counts wins on
-- 15-45d / 46+d flags. Strict win-rate distribution from 4-day calibration
-- window (Apr 25-28, 1,395 contract-axis grades):
--
--   0DTE   : 27.7%    (487 grades) — flat threshold reasonable; KEEP
--   1-3d   : 29.3%    (273 grades) — flat threshold reasonable; KEEP
--   4-14d  : 27.2%    (313 grades) — minor pull
--   15-45d : 21.9%    (237 grades) — bigger pull
--   46+d   : 12.9%    ( 85 grades) — biggest pull; widest CI (smallest bucket)
--
-- New thresholds calibrated to flatten strict-win-rate to ~25-30% across
-- buckets. Per Tenet 16, every number tunable via ct_config.
--
-- IMPORTANT: this migration does NOT change underlying-axis grading
-- (specialist + james_star). Those keep `grader.target_threshold_pct` flat.
-- C1 measurement-window noise = zero for this change.
--
-- Track-state-machine bug (3,465 WORKING / 0 REALIZED / 0 EXPIRED) which
-- distorts peak_contract_pct distribution is filed as a separate next-session
-- P0 — see docs/decisions/2026-05-02-weekend-build-cuts.md.
-- =============================================================================
SET search_path = public, extensions;

INSERT INTO ct_config (key, value, description, category, default_value) VALUES
  ('grader.alarm_win_pct.0dte', '50'::jsonb,
    'Contract-axis grader: peak% threshold for 0DTE win. 27.7% strict win rate at this level (n=487).',
    'grader', '50'::jsonb),
  ('grader.alarm_win_pct.1_3d', '50'::jsonb,
    'Contract-axis grader: peak% threshold for 1-3d win. 29.3% strict win rate at this level (n=273).',
    'grader', '50'::jsonb),
  ('grader.alarm_win_pct.4_14d', '40'::jsonb,
    'Contract-axis grader: peak% threshold for 4-14d win. Pulled from 50%; calibrated for 27.2% strict win rate (n=313).',
    'grader', '40'::jsonb),
  ('grader.alarm_win_pct.15_45d', '30'::jsonb,
    'Contract-axis grader: peak% threshold for 15-45d win. Pulled from 50%; calibrated for 21.9% baseline → ~28% strict win rate (n=237).',
    'grader', '30'::jsonb),
  ('grader.alarm_win_pct.46d_plus', '20'::jsonb,
    'Contract-axis grader: peak% threshold for 46+d win. Pulled from 50%; calibrated for 12.9% baseline → ~25% strict win rate (n=85, widest CI).',
    'grader', '20'::jsonb),
  ('grader.alarm_loss_pct.0dte', '30'::jsonb,
    'Contract-axis grader: drawdown% threshold for 0DTE loss.',
    'grader', '30'::jsonb),
  ('grader.alarm_loss_pct.1_3d', '30'::jsonb,
    'Contract-axis grader: drawdown% threshold for 1-3d loss.',
    'grader', '30'::jsonb),
  ('grader.alarm_loss_pct.4_14d', '25'::jsonb,
    'Contract-axis grader: drawdown% threshold for 4-14d loss. Proportional pull from 30%.',
    'grader', '25'::jsonb),
  ('grader.alarm_loss_pct.15_45d', '20'::jsonb,
    'Contract-axis grader: drawdown% threshold for 15-45d loss.',
    'grader', '20'::jsonb),
  ('grader.alarm_loss_pct.46d_plus', '15'::jsonb,
    'Contract-axis grader: drawdown% threshold for 46+d loss. Symmetric ~3:4 ratio with new win threshold.',
    'grader', '15'::jsonb)
ON CONFLICT (key) DO NOTHING;
