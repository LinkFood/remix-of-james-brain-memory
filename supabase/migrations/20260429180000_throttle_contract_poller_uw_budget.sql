-- =============================================================================
-- 20260429180000_throttle_contract_poller_uw_budget.sql
--
-- Dial ct-contract-poller back from */3 to */4 during RTH for UW budget safety.
--
-- Caught live 2026-04-29 18:00 UTC: hit 62.0% UW (vs Tuesday's 50.4% at same
-- wall-clock), linear-projection-close 89.5%. Buffer to throttling = ~2,100
-- calls (~11 min of normal poller burn). Tuesday-night migration
-- 20260428180000 bumped poller */5→*/3 + maxPerRun 60→100. The math was net
-- ~flat under steady state but underweighted today's heavier flow ingest +
-- new VIX cadence + per-tick frontend reads.
--
-- New throughput: 100 * 97 fires/RTH-day = 9,700 contract-polls (was 13,000).
-- Per-track refresh latency: ~80 min → ~110 min. Imperceptible at James's
-- decision tempo. Frees ~3,300 calls/day = ~16% of daily budget.
--
-- Touches: cron schedule only. No code, no schema, no logic. maxPerRun stays
-- at 100 (configured in ct_config).
-- =============================================================================
SET search_path = public, extensions;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-contract-poller') THEN
    PERFORM cron.unschedule('ct-contract-poller');
  END IF;
  PERFORM cron.schedule(
    'ct-contract-poller',
    '*/4 13-20 * * 1-5',
    $body$SELECT public.invoke_edge_function('ct-contract-poller', '{}'::jsonb);$body$
  );
END
$cron$;
