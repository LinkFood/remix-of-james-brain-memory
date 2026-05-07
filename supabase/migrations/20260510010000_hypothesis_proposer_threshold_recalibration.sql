-- Recalibrate consumer_freshness_hypothesis_proposer_24x7 threshold 120 → 270 min.
--
-- Context: Class B Phase B (commit 16aaeb3) shipped 9 24/7 brain-consumer-freshness
-- invariants. First warden tick: 8 PASS + 1 FIRE on hypothesis_proposer. Phase A
-- audit (2026-05-07) confirmed:
--
--   1. Logic correct, classifier correct, producer healthy.
--   2. ct-hypothesis-proposer is a BURST-shape consumer firing every 4 hours
--      on cron (UTC 11:00 / 15:00 / 19:00). Inter-burst cadence = 240 min.
--   3. Old threshold (120) sat at HALF the natural cadence — fired ~8 false
--      ticks per RTH day on healthy operation (e.g., 17:30Z=150min, 18:00Z=180,
--      18:30Z=210, 19:00Z=240 — all "fail" minutes before the next burst arrives).
--   4. 7-day backtest of 8 sibling 24/7 invariants showed 0 false fires; only
--      hypothesis_proposer mis-calibrated. Single-purpose ship per Phase A.
--
-- New threshold: 270 min = cron cadence (240) + warden tick buffer (30).
--   - stays silent on healthy boundary (age = 240 → 0)
--   - catches a single missed cron run on the very next warden tick
--   - 7-day empirical zero false positives
--
-- Methodology lesson: cadence-anchored thresholds for burst-shape consumers,
-- not p90 / 1.5×median (those collapse to 0 on bimodal-burst metrics).
--
-- Cross-refs:
--   - feedback_warden_threshold_calibration.md (sibling lesson 2026-05-05)
--   - 16aaeb3 Class B Phase B
--   - docs/runbooks/ct_invariants_sql_authoring.md

UPDATE public.ct_invariants
SET
  description = 'ct-hypothesis-proposer brain consumer freshness — 24/7 phase-classifier supplement to B-4. RTH ≤270min (cron cadence 240 + warden tick buffer 30); off otherwise.',
  query_sql = REPLACE(query_sql, '120', '270')
WHERE name = 'consumer_freshness_hypothesis_proposer_24x7';
