-- Cron job: run backfill-embeddings every 30 minutes
-- Uses existing invoke_edge_function helper from vault

-- Unschedule if already exists (idempotent)
SELECT cron.unschedule('backfill-embeddings-every-30min')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'backfill-embeddings-every-30min'
);

-- Schedule backfill every 30 minutes
SELECT cron.schedule(
  'backfill-embeddings-every-30min',
  '*/30 * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url' LIMIT 1) || '/functions/v1/backfill-embeddings',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1)
    ),
    body := '{}'::jsonb
  );
  $$
);
