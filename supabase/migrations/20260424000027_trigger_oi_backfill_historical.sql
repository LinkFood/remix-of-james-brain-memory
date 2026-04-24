-- =============================================================================
-- 20260424000027_trigger_oi_backfill_historical.sql
--
-- One-shot: fire ct-oi-backfill-historical. Response written to
-- ct_heartbeats for inspection since no pg_net response table is readable
-- via PostgREST RPC.
-- =============================================================================

DO $$
DECLARE
  _project_url TEXT;
  _service_key TEXT;
  _request_id  BIGINT;
BEGIN
  SELECT decrypted_secret INTO _project_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO _service_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';

  IF _project_url IS NULL OR _service_key IS NULL THEN
    RAISE EXCEPTION 'Vault missing project_url or service_role_key';
  END IF;

  SELECT net.http_post(
    url := _project_url || '/functions/v1/ct-oi-backfill-historical',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || _service_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  ) INTO _request_id;

  INSERT INTO public.ct_heartbeats(status_line, watching, current_reads, prompt_version)
  VALUES (
    '[oi-backfill-historical] fired request_id=' || _request_id,
    ARRAY['ct-oi-backfill-historical'],
    jsonb_build_object('request_id', _request_id, 'fired_at', now()),
    'oi-backfill-trigger'
  );
END $$;
