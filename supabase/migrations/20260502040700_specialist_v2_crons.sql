-- =============================================================================
-- 20260502040500_specialist_v2_crons.sql
--
-- Schedule the specialist v2 nightly run.
--
-- Single combined cron — the lifecycle edge function calls
-- ct_specialist_score_v2(7) first to refresh scoreboard + grade axes,
-- then runs the K=4 gate. Keeps the dependency clean (no race between
-- score and lifecycle).
--
-- The cron name 'ct-specialist-score-v2-nightly' is registered in
-- ct_growth_crons by 20260502040200_specialist_v2_schemas.sql so warden
-- freshness invariants pick it up.
-- =============================================================================
SET search_path = public, extensions;

DO $cron$
BEGIN
  -- Idempotent unschedule before schedule (Tenet 4 — class fix, no band-aids).
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-specialist-score-v2-nightly') THEN
    PERFORM cron.unschedule('ct-specialist-score-v2-nightly');
  END IF;

  PERFORM cron.schedule(
    'ct-specialist-score-v2-nightly',
    '0 3 * * *',
    $body$ SELECT public.trigger_ct_specialist_score_v2(); $body$
  );
END
$cron$;

COMMENT ON FUNCTION public.trigger_ct_specialist_score_v2() IS
  'Manual-fire trigger for the specialist v2 nightly run. Schedule: ct-specialist-score-v2-nightly @ 0 3 * * * (03:00 UTC daily).';
