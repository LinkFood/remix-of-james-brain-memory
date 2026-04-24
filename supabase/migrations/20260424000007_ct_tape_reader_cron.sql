-- Schedule ct-tape-reader: every 10 min during US RTH (13-20 UTC, Mon-Fri).
-- Plus AFTER INSERT trigger on ct_flags to fire an interrupt commentary when
-- a specialist posts a high-conviction (score >= 80) flag.
SET search_path = public, extensions;

-- Drop any previous schedule so this is idempotent.
DO $$
BEGIN
  PERFORM cron.unschedule('ct-tape-reader-rth');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'ct-tape-reader-rth',
  '*/10 13-20 * * 1-5',
  $body$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-tape-reader',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
    ),
    body := jsonb_build_object('trigger_kind', 'scheduled', 'window_minutes', 10)
  );
  $body$
);

-- AFTER INSERT trigger on ct_flags: when a new flag lands with score >= 80
-- AND status in active/conviction, fire a tape-reader interrupt so the
-- banner updates with context around the fresh flag.
CREATE OR REPLACE FUNCTION public._ct_flag_trigger_tape_reader()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE
  v_project_url text;
  v_service_key text;
BEGIN
  IF NEW.score IS NULL OR NEW.score < 80 THEN
    RETURN NEW;
  END IF;
  IF NEW.status NOT IN ('active', 'conviction') THEN
    RETURN NEW;
  END IF;

  SELECT decrypted_secret INTO v_project_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO v_service_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';

  IF v_project_url IS NULL OR v_service_key IS NULL THEN
    RETURN NEW;  -- vault not set — skip silently
  END IF;

  PERFORM net.http_post(
    url := v_project_url || '/functions/v1/ct-tape-reader',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_service_key
    ),
    body := jsonb_build_object(
      'trigger_kind', 'flag_interrupt',
      'window_minutes', 10,
      'flag_id', NEW.id::text
    )
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never block a flag insert on tape-reader plumbing.
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS ct_flags_conviction_tape_reader ON public.ct_flags;
CREATE TRIGGER ct_flags_conviction_tape_reader
  AFTER INSERT ON public.ct_flags
  FOR EACH ROW
  EXECUTE FUNCTION public._ct_flag_trigger_tape_reader();

COMMENT ON FUNCTION public._ct_flag_trigger_tape_reader IS
  'Event-driven interrupt for ct-tape-reader. Fires on new ct_flags rows with score >= 80 in active/conviction status. Fail-silent if vault missing.';
