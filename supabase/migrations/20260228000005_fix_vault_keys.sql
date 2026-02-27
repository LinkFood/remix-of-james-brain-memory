-- Fix vault keys: edge function env uses sb_secret/sb_publishable format,
-- not JWT format. Update vault to match so cron calls pass auth.
--
-- ALREADY APPLIED to production database (2026-02-28).
-- Secret value redacted from source. If re-applying, run manually in SQL Editor:
--   DELETE FROM vault.secrets WHERE name = 'service_role_key';
--   SELECT vault.create_secret('<SUPABASE_SERVICE_ROLE_KEY from env>', 'service_role_key');

-- Drop the diagnostic function (was temporary)
DROP FUNCTION IF EXISTS public.check_vault_key_info();
