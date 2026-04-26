-- small_cap_inverted_put_v1 detector — TSLA/IWM aggressive bid-side put hits.
-- Per corpus 2026-04-20->24: 100% of TSLA+IWM winners (81 of 81) came from
-- this exact pattern. Raw hit rate is 14% (anti-signal as written), so we
-- ship in shadow and let the production scoreboard either validate the
-- ticker-scoped inversion or kill via threshold tuning.
-- Direction: bearish (the put appreciating means underlying drops).
SET search_path = public, extensions;

INSERT INTO public.ct_detectors (id, name, description, status, dte_class, config, thesis) VALUES
  ('small_cap_inverted_put_v1',
   'TSLA/IWM aggressive bid-put → bearish underlying',
   'TSLA or IWM + put + is_bid (aggressive bid hit). Per corpus inversion: 100% of TSLA/IWM winners (81 of 81) came from this pattern. Predicts bearish underlying move (the puts win = underlying falls).',
   'shadow',
   'all',
   '{"tickers":["TSLA","IWM"],"dedupe_min":60}'::jsonb,
   'TSLA/IWM aggressive bid-put fires 14% hit rate raw on corpus 2026-04-20→24 (anti-signal as written), but 100% of TSLA+IWM winners came from this pattern. Shipping in shadow to let production scoreboard either validate the inversion or kill via threshold tuning. Direction: bearish (the put appreciates means underlying drops).')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.ct_detector_state (detector_id, last_processed_at) VALUES
  ('small_cap_inverted_put_v1', now() - interval '5 minutes')
ON CONFLICT (detector_id) DO NOTHING;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-detector-small-cap-inverted-put-rth') THEN
    PERFORM cron.unschedule('ct-detector-small-cap-inverted-put-rth');
  END IF;

  PERFORM cron.schedule(
    'ct-detector-small-cap-inverted-put-rth',
    '*/5 13-20 * * 1-5',
    $body$SELECT public.invoke_edge_function('ct-detector-small-cap-inverted-put', '{}'::jsonb);$body$
  );
END
$cron$;
