-- Weekly ATM with V/OI ≥ 1 detector — the three discriminators that hold 5/5
-- days in corpus 2026-04-20→24: weekly DTE (1-7), ATM strike (±0.5%),
-- Vol/OI ≥ 1.0. Combined hit rate 33% vs 22% base, 1.49x lift, 224 catches
-- on 673 fires.
SET search_path = public, extensions;

INSERT INTO public.ct_detectors (id, name, description, status, dte_class, config, thesis) VALUES
  ('weekly_atm_voi_v1',
   'Weekly ATM with V/OI ≥ 1',
   'Weekly DTE (1-7) + ATM strike (±0.5%) + Vol/OI ≥ 1.0. The three discriminators that hold 5/5 days in corpus 2026-04-20→24.',
   'shadow',
   'non_0dte',
   '{"dte_min":1,"dte_max":7,"strike_band_pct":0.005,"min_voi_ratio":1.0,"dedupe_min":60}'::jsonb,
   'Weekly DTE is the strongest cross-day discriminator (2.2x-32x lift). ATM (5/5 days, 2.6x-inf lift). V/OI≥1 (5/5 days, 1.5x-2.6x lift). Combined hit rate 33% vs 22% base (corpus 2026-04-20→24, 673 fires, 224 catches, 1.49x lift).')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.ct_detector_state (detector_id, last_processed_at) VALUES
  ('weekly_atm_voi_v1', now() - interval '5 minutes')
ON CONFLICT (detector_id) DO NOTHING;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-detector-weekly-atm-voi-rth') THEN
    PERFORM cron.unschedule('ct-detector-weekly-atm-voi-rth');
  END IF;

  PERFORM cron.schedule(
    'ct-detector-weekly-atm-voi-rth',
    '*/5 13-20 * * 1-5',
    $body$SELECT public.invoke_edge_function('ct-detector-weekly-atm-voi', '{}'::jsonb);$body$
  );
END
$cron$;
