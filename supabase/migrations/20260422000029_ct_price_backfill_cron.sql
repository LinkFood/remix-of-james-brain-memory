-- Schedule ct-price-backfill nightly (22:30 UTC, post-US-close) and also
-- schedule ct_attribute_signals + re-materialize priors 10 min later (22:40 UTC)
-- so /edge reflects today's fresh data the moment someone visits it in the morning.
--
-- Vault reads follow existing pattern: project_url + service_role_key.

DO $$
DECLARE
  v_project_url  TEXT;
  v_service_key  TEXT;
BEGIN
  SELECT decrypted_secret INTO v_project_url
  FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1;
  SELECT decrypted_secret INTO v_service_key
  FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1;

  IF v_project_url IS NULL OR v_service_key IS NULL THEN
    RAISE NOTICE 'vault missing project_url or service_role_key — ct-price-backfill cron not scheduled';
    RETURN;
  END IF;

  PERFORM cron.unschedule('ct-price-backfill-nightly')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-price-backfill-nightly');

  PERFORM cron.schedule(
    'ct-price-backfill-nightly',
    '30 22 * * 1-5',
    format(
      $cron$
      SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type','application/json',
          'Authorization','Bearer ' || %L,
          'apikey', %L
        ),
        body := '{"lookback_days": 2}'::jsonb
      ) AS request_id;
      $cron$,
      v_project_url || '/functions/v1/ct-price-backfill',
      v_service_key, v_service_key
    )
  );

  PERFORM cron.unschedule('ct-attribute-signals-nightly')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-attribute-signals-nightly');

  PERFORM cron.schedule(
    'ct-attribute-signals-nightly',
    '40 22 * * 1-5',
    $body$
      SELECT public.ct_attribute_signals(7) AS rows_written_7d,
             public.ct_attribute_signals(14) AS rows_written_14d,
             public.ct_attribute_signals(30) AS rows_written_30d;
    $body$
  );
END $$;
