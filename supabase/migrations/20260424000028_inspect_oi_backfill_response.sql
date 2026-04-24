-- Inspect the pg_net response for request_id=66307 from the backfill fire.
DO $$
DECLARE
  _row RECORD;
BEGIN
  SELECT id, status_code, LEFT(content::text, 1200) AS content_preview, error_msg
    INTO _row
    FROM net._http_response
    WHERE id = 66307;

  IF _row IS NULL THEN
    INSERT INTO public.ct_heartbeats(status_line, watching, current_reads, prompt_version)
    VALUES ('[oi-backfill-inspect] no response row for 66307', ARRAY['inspect'],
            jsonb_build_object('request_id', 66307), 'oi-backfill-inspect');
  ELSE
    INSERT INTO public.ct_heartbeats(status_line, watching, current_reads, prompt_version)
    VALUES (
      '[oi-backfill-inspect] status=' || COALESCE(_row.status_code::text, 'null'),
      ARRAY['inspect'],
      jsonb_build_object(
        'status_code', _row.status_code,
        'error_msg', _row.error_msg,
        'content_preview', _row.content_preview
      ),
      'oi-backfill-inspect'
    );
  END IF;
END $$;
