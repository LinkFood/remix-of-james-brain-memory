-- =============================================================================
-- 20260423000029_v2_oi_snapshot_cron.sql
--
-- Co-Trader v2 Phase 1c — OI snapshot crons.
--
-- Three daily runs per trading day (UTC):
--   open  : 13:35 UTC (5 min post-bell)
--   mid   : 17:00 UTC (12:00 ET)
--   close : 20:05 UTC (5 min post-close)
--
-- Each cron fires ct-oi-snapshot with an explicit {slot: ...} body so the
-- edge function doesn't need to guess from wall-clock (which drifts when a
-- cron fires late).
--
-- Also scheduling the overnight summary placeholder (12:30 UTC weekdays) —
-- Phase 4 will replace SELECT 1 with the real Slack post function.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- Trigger wrapper RPC — passes slot via body. Mirrors the _ct_post_with_body
-- pattern used by every other v2 cron that needs parameterization.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trigger_ct_oi_snapshot_with_slot(_slot TEXT)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
  SELECT public._ct_post_with_body(
    'ct-oi-snapshot',
    jsonb_build_object('slot', _slot)
  );
$fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_oi_snapshot_with_slot(TEXT) TO authenticated, service_role;

COMMENT ON FUNCTION public.trigger_ct_oi_snapshot_with_slot(TEXT) IS
  'V2 Phase 1c: manual + cron trigger for ct-oi-snapshot with explicit slot (open/mid/close).';

-- -----------------------------------------------------------------------------
-- Cron schedules — unschedule first to make migration re-runnable.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM cron.unschedule('ct-oi-snapshot-open')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-oi-snapshot-open');
  PERFORM cron.unschedule('ct-oi-snapshot-mid')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-oi-snapshot-mid');
  PERFORM cron.unschedule('ct-oi-snapshot-close')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-oi-snapshot-close');
  PERFORM cron.unschedule('ct-oi-overnight-summary')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-oi-overnight-summary');
END $$;

-- Open slot: 13:35 UTC weekdays (5 min after 09:30 ET bell)
SELECT cron.schedule(
  'ct-oi-snapshot-open',
  '35 13 * * 1-5',
  $cron$ SELECT public.trigger_ct_oi_snapshot_with_slot('open'); $cron$
);

-- Mid slot: 17:00 UTC weekdays (12:00 ET)
SELECT cron.schedule(
  'ct-oi-snapshot-mid',
  '0 17 * * 1-5',
  $cron$ SELECT public.trigger_ct_oi_snapshot_with_slot('mid'); $cron$
);

-- Close slot: 20:05 UTC weekdays (5 min after 16:00 ET close)
SELECT cron.schedule(
  'ct-oi-snapshot-close',
  '5 20 * * 1-5',
  $cron$ SELECT public.trigger_ct_oi_snapshot_with_slot('close'); $cron$
);

-- -----------------------------------------------------------------------------
-- Phase 4 placeholder: overnight OI summary Slack at 12:30 UTC (08:30 ET).
-- Scheduled now so the cron slot is reserved; Phase 4 will replace SELECT 1
-- with SELECT public._ct_post('ct-oi-overnight-summary') once that function
-- ships with the Slack push integration.
-- -----------------------------------------------------------------------------
SELECT cron.schedule(
  'ct-oi-overnight-summary',
  '30 12 * * 1-5',
  $cron$ SELECT 1; /* Phase 4 will wire ct-oi-overnight-summary Slack */ $cron$
);
