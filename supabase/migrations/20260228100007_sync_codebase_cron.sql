-- Add last_synced_at column to code_projects if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'code_projects' AND column_name = 'last_synced_at'
  ) THEN
    ALTER TABLE code_projects ADD COLUMN last_synced_at timestamptz;
  END IF;
END $$;

-- Schedule codebase sync every 6 hours
-- Syncs all active projects by calling sync-codebase for each
SELECT cron.schedule(
  'sync-all-codebases',
  '0 */6 * * *',
  $$
  DO $$
  DECLARE
    project_row RECORD;
    project_url TEXT;
    svc_key TEXT;
  BEGIN
    SELECT decrypted_secret INTO project_url FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1;
    SELECT decrypted_secret INTO svc_key FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1;

    FOR project_row IN
      SELECT id, user_id FROM code_projects WHERE active = true
    LOOP
      PERFORM net.http_post(
        url := project_url || '/functions/v1/sync-codebase',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || svc_key,
          'Content-Type', 'application/json'
        ),
        body := jsonb_build_object(
          'projectId', project_row.id,
          'userId', project_row.user_id
        )
      );
    END LOOP;
  END $$;
  $$
);
