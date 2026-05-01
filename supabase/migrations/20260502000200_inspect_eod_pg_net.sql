-- One-shot inspection: dump pg_net response status for the recent EOD report
-- invocations (request ids 102736 and 102749) into ct_heartbeats so PostgREST
-- can read them. Drop after read.
DO $$
DECLARE
  _row RECORD;
  _id  bigint;
BEGIN
  FOREACH _id IN ARRAY ARRAY[102736, 102749]::bigint[]
  LOOP
    SELECT id, status_code, LEFT(content::text, 600) AS content_preview, error_msg, created
      INTO _row
      FROM net._http_response
      WHERE id = _id;

    IF _row IS NULL THEN
      INSERT INTO public.ct_heartbeats(status_line, watching, current_reads, prompt_version)
      VALUES ('[eod-pg-net-inspect] no row for ' || _id, ARRAY['inspect'],
              jsonb_build_object('request_id', _id), 'eod-net-inspect');
    ELSE
      INSERT INTO public.ct_heartbeats(status_line, watching, current_reads, prompt_version)
      VALUES (
        '[eod-pg-net-inspect] req=' || _id || ' status=' || COALESCE(_row.status_code::text, 'null'),
        ARRAY['inspect'],
        jsonb_build_object(
          'request_id', _id,
          'status_code', _row.status_code,
          'error_msg', _row.error_msg,
          'content_preview', _row.content_preview,
          'created', _row.created
        ),
        'eod-net-inspect'
      );
    END IF;
  END LOOP;
END $$;
