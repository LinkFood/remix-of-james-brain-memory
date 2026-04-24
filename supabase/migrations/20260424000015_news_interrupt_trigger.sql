-- Event-driven tape-reader interrupt on severity-4+ breaking news.
-- News moves stocks; if a sev-4 item lands, the reader should write a
-- fresh commentary immediately instead of waiting for the next 10-min tick.
SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public._ct_breaking_news_trigger_tape_reader()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE
  v_project_url text;
  v_service_key text;
BEGIN
  IF NEW.severity IS NULL OR NEW.severity < 4 THEN
    RETURN NEW;
  END IF;

  SELECT decrypted_secret INTO v_project_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO v_service_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';
  IF v_project_url IS NULL OR v_service_key IS NULL THEN RETURN NEW; END IF;

  PERFORM net.http_post(
    url := v_project_url || '/functions/v1/ct-tape-reader',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_service_key
    ),
    body := jsonb_build_object(
      'trigger_kind', 'flag_interrupt',
      'window_minutes', 15
    )
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS ct_breaking_news_sev4_tape_reader ON public.ct_breaking_news;
CREATE TRIGGER ct_breaking_news_sev4_tape_reader
  AFTER INSERT ON public.ct_breaking_news
  FOR EACH ROW
  EXECUTE FUNCTION public._ct_breaking_news_trigger_tape_reader();

COMMENT ON FUNCTION public._ct_breaking_news_trigger_tape_reader IS
  'Fires ct-tape-reader as a flag_interrupt when a severity>=4 breaking news row is inserted. News moves options, reader should call it out immediately.';
