-- Class B Phase B fix per docs/audit/2026-05-09-regime-freshness-deadnight-class-b.md
-- Option 1 + manifest companion. Ends two recurring nightly fires:
--   - regime_state_freshness_rth (warn)
--   - cron_zero_row_upsert_silent_failure_class (warn, via shared root)
--
-- Mechanism: ct-regime-capture-offhours fires '0 10-12,21-22 * * 1-5' UTC
-- with intentional 12h dead-of-night gap (23:00-09:59 UTC). Yesterday's
-- invariants didn't model this gap; both fired every weeknight 23:30-10:00.

-- ---------------------------------------------------------------------------
-- 1. regime_state_freshness_rth: add dead_of_night phase
-- ---------------------------------------------------------------------------
-- Phase classifier enumerates ALL silence windows the cron has, not just
-- {rth, weekend}. Mirrors weekend-pass semantic for the dead-of-night gap.
-- Authoring per docs/runbooks/ct_invariants_sql_authoring.md (PR #55).

UPDATE public.ct_invariants
SET
  description = 'Pulse v2 regime classifications must be fresh during cron-active windows. RTH ≤15min target / off-hours-active ≤90min / weekend pass / dead-of-night pass (cron schedule 0 10-12,21-22 * * 1-5 UTC has intentional 12h gap 23:00-09:59).',
  query_sql = $inv$WITH last_run AS (SELECT MAX(last_updated) AS last_at FROM public.ct_regime_classifications), clk AS (SELECT EXTRACT(DOW FROM now() AT TIME ZONE 'UTC')::int AS dow, EXTRACT(HOUR FROM now() AT TIME ZONE 'UTC')::int AS hr), rated AS (SELECT CASE WHEN last_at IS NULL THEN 0 ELSE EXTRACT(EPOCH FROM (now() - last_at)) / 60 END AS age_min, CASE WHEN clk.dow NOT BETWEEN 1 AND 5 THEN 'weekend' WHEN clk.hr BETWEEN 13 AND 20 THEN 'rth' WHEN clk.hr IN (10, 11, 12, 21, 22) THEN 'offhours_active' ELSE 'dead_of_night' END AS phase, last_at FROM last_run, clk) SELECT CASE WHEN phase IN ('weekend','dead_of_night') THEN 0 ELSE age_min END::numeric AS metric_value, CASE WHEN last_at IS NULL THEN '[regime_state] no classifications yet — first cron fire pending' ELSE '[regime_state] last classification ' || ROUND(age_min)::text || ' min ago (' || phase || ')' END AS message FROM rated$inv$
WHERE name = 'regime_state_freshness_rth';

-- ---------------------------------------------------------------------------
-- 2. ct_growth_crons manifest: disable ct-regime-capture-offhours
-- ---------------------------------------------------------------------------
-- The silent-failure-class invariant is meant for growth crons —
-- monotonic accumulation. ct-regime-capture-offhours is a periodic snapshot
-- cron with intentional 12h dead-of-night gap; it's not "growing" and the
-- shared check_growth_cron_silent_failures() can't model its non-uniform
-- schedule. The dedicated regime_state_freshness_rth invariant (now
-- dead_of_night-aware) is the right surface for this cron.

UPDATE public.ct_growth_crons
SET
  enabled = false,
  description = description || ' [DISABLED 2026-05-10: not a growth cron (periodic snapshots, 12h dead-of-night gap). Freshness covered by regime_state_freshness_rth invariant.]'
WHERE cron_jobname = 'ct-regime-capture-offhours'
  AND enabled = true;
