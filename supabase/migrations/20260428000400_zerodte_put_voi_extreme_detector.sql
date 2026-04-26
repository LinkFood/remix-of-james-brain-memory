-- 0DTE-put-V/OI-extreme detector — 0DTE + put + Vol/OI ≥ 20.
-- Catches the SPY 0DTE puts at extreme V/OI that paid 294-338% on
-- Thursday 2026-04-23. Corpus says raw V/OI alone is anti-signal
-- (15% hit rate). Shipping in shadow to let the production scoreboard
-- validate or kill — directional filter (sellers paying bid) may be
-- needed in v2.
SET search_path = public, extensions;

INSERT INTO public.ct_detectors (id, name, description, status, dte_class, config, thesis) VALUES
  ('zerodte_put_voi_extreme_v1',
   '0DTE put V/OI extreme',
   '0DTE + put + Vol/OI ≥ 20. SPY-Thursday-massacre pattern (V/OI 25-74x at peak).',
   'shadow',
   '0dte',
   '{"min_voi_ratio":20.0,"dedupe_min":60}'::jsonb,
   'Catches the SPY 0DTE puts at extreme V/OI that paid 294-338% on Thursday 2026-04-23 — but corpus says raw V/OI alone is anti-signal (15% hit rate). Shipping in shadow to let the production scoreboard validate or kill — directional filter (sellers paying bid) may be needed in v2.')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.ct_detector_state (detector_id, last_processed_at) VALUES
  ('zerodte_put_voi_extreme_v1', now() - interval '5 minutes')
ON CONFLICT (detector_id) DO NOTHING;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-detector-zerodte-put-voi-rth') THEN
    PERFORM cron.unschedule('ct-detector-zerodte-put-voi-rth');
  END IF;

  PERFORM cron.schedule(
    'ct-detector-zerodte-put-voi-rth',
    '*/5 13-20 * * 1-5',
    $body$SELECT public.invoke_edge_function('ct-detector-zerodte-put-voi', '{}'::jsonb);$body$
  );
END
$cron$;
