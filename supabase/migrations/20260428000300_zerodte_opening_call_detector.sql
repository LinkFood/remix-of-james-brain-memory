-- 0DTE opening-hour ask-call detector — fires on aggressive-ask call prints
-- on same-day expiries within the 9-10am ET window. Built for the Friday
-- NVDA/SPY/QQQ explosion class observed 2026-04-25 (NVDA 9:32-10:34am
-- 0DTE call bonanza, EVERY one paid 158-539% peak).
SET search_path = public, extensions;

INSERT INTO public.ct_detectors (id, name, description, status, dte_class, config, thesis) VALUES
  ('zerodte_opening_call_v1',
   '0DTE opening hour ask-call',
   '0DTE + 9-10am ET + aggressive_ask_call. Catches NVDA/SPY/QQQ Friday-morning explosion class.',
   'shadow',
   '0dte',
   '{"hour_et_min":9,"hour_et_max":10,"dedupe_min":60}'::jsonb,
   '54% hit rate on corpus 2026-04-20→24, narrow fire window (129 fires/5d). Avg winner peak +154%. 2.43x lift. Friday-dominant but Wed also fires (65% hit). Built for the 9:32am NVDA bonanza class.')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.ct_detector_state (detector_id, last_processed_at) VALUES
  ('zerodte_opening_call_v1', now() - interval '5 minutes')
ON CONFLICT (detector_id) DO NOTHING;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-detector-zerodte-opening-call-rth') THEN
    PERFORM cron.unschedule('ct-detector-zerodte-opening-call-rth');
  END IF;

  PERFORM cron.schedule(
    'ct-detector-zerodte-opening-call-rth',
    '*/5 13-20 * * 1-5',
    $body$SELECT public.invoke_edge_function('ct-detector-zerodte-opening-call', '{}'::jsonb);$body$
  );
END
$cron$;
