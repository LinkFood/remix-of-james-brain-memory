-- Ship 7 — Phase 1 close arc, Bundle 3 — poller policy tunables.
--
-- Gates on Ship 2 telemetry: past-4h window showed skipped_cap=74.8% and
-- skipped_cadence=0% — the maxPerRun cap is the load-bearing throttle. With
-- tier='tightened' currently active (dteMax=30 SQL filter), 46_plus tracks
-- never even reach the eligible pool; cutting them at print-grader entry is
-- a cleanup move (don't seed dead rows) rather than an immediate poll-rate
-- lift. The cap raise 100 -> 200 is what lifts effective sweeps/contract
-- on the productive 8d-45d pool.
--
-- Tunables:
--   contract_poller_max_per_run            100 -> 200 (raise cap)
--   contract_poller_long_dte_threshold     NEW, default 45 (DTE cull at print-grader entry)
--
-- UW budget headroom: ct-contract-poller is ~11.5% of daily UW today.
-- Doubling cap doubles worst-case calls per fire. Tier-aware throttle in
-- ct-contract-poller short-circuits to skip/critical/exhausted before this
-- cap even matters, so we're not removing the safety floor.

-- 1) Raise the per-run cap. value column is jsonb; cast.
UPDATE public.ct_config
SET
  value = '200'::jsonb,
  updated_at = now()
WHERE key = 'contract_poller_max_per_run';

-- 2) Add the long-DTE threshold tunable. Skip-at-print-grader-entry: when
-- dte_at_print > threshold, don't synthesize an OCC symbol, don't write a
-- ct_contract_tracks row, increment a skip counter. Naturally bypasses
-- the poller for prints that wouldn't get a meaningful sweep cadence
-- anyway.
INSERT INTO public.ct_config (key, value, description, category, min_value, max_value, default_value)
VALUES (
  'contract_poller_long_dte_threshold',
  '45'::jsonb,
  'Long-DTE cull threshold at ct-print-grader entry. Tracks with dte_at_print > this value are NOT written to ct_contract_tracks. Prevents seeding dead rows under tight UW budget tiers that filter dteMax<=30/7 anyway.',
  'contract_poller',
  0,
  365,
  '45'::jsonb
)
ON CONFLICT (key) DO UPDATE SET
  value = EXCLUDED.value,
  description = EXCLUDED.description,
  updated_at = now();
