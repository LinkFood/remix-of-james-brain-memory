-- Smart-money-repeat detector — same option_symbol prints >=3x within 180min
-- on OTM call. Best detector vs corpus 2026-04-20->24: 39% hit rate, catches
-- 26% of all winners (320), adds 234 new catches over signature_v1.
-- Also adds dte_class architectural split column to ct_detectors (default 'all'
-- backfills the existing 8 detector rows behavior-preserving).
SET search_path = public, extensions;

ALTER TABLE public.ct_detectors
  ADD COLUMN IF NOT EXISTS dte_class text NOT NULL DEFAULT 'all'
  CHECK (dte_class IN ('all','0dte','non_0dte'));

INSERT INTO public.ct_detectors (id, name, description, status, dte_class, config, thesis) VALUES
  ('smart_money_repeat_v1',
   'Same-contract repeat cluster',
   'Same option_symbol prints >=3x within 180min window on OTM call. Catches institutional accumulation + chaser pattern.',
   'shadow',
   'non_0dte',
   '{"window_min":180,"min_prints":3,"side_filter":"call_otm_only","dedupe_min":60}'::jsonb,
   'Best detector vs corpus 2026-04-20->24: 39% hit rate, catches 26% of all winners (320), adds 234 new catches over signature_v1. Catches AMZN $260C-style multi-day rides where same exact contract gets stacked Tue->Wed->Thu by smart money + paper chasers.')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.ct_detector_state (detector_id, last_processed_at) VALUES
  ('smart_money_repeat_v1', now() - interval '5 minutes')
ON CONFLICT (detector_id) DO NOTHING;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-detector-smart-money-repeat-rth') THEN
    PERFORM cron.unschedule('ct-detector-smart-money-repeat-rth');
  END IF;

  PERFORM cron.schedule(
    'ct-detector-smart-money-repeat-rth',
    '*/5 13-20 * * 1-5',
    $body$SELECT public.invoke_edge_function('ct-detector-smart-money-repeat', '{}'::jsonb);$body$
  );
END
$cron$;
