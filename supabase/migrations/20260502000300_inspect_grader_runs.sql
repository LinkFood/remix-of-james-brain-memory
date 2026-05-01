-- One-shot: dump pg_net response for grader fires 102777..102781
-- to see what the function actually returned (graded counts, errors).
DO $$
DECLARE
  _row RECORD;
  _id  bigint;
BEGIN
  FOREACH _id IN ARRAY ARRAY[102777, 102778, 102779, 102780, 102781]::bigint[]
  LOOP
    SELECT id, status_code, LEFT(content::text, 1500) AS content_preview, error_msg
      INTO _row
      FROM net._http_response
      WHERE id = _id;

    IF _row IS NULL THEN
      INSERT INTO public.ct_heartbeats(status_line, watching, current_reads, prompt_version)
      VALUES ('[grader-pg-net] no row for ' || _id, ARRAY['inspect'],
              jsonb_build_object('request_id', _id), 'grader-net-inspect');
    ELSE
      INSERT INTO public.ct_heartbeats(status_line, watching, current_reads, prompt_version)
      VALUES (
        '[grader-pg-net] req=' || _id || ' status=' || COALESCE(_row.status_code::text, 'null'),
        ARRAY['inspect'],
        jsonb_build_object(
          'request_id', _id,
          'status_code', _row.status_code,
          'error_msg', _row.error_msg,
          'content_preview', _row.content_preview
        ),
        'grader-net-inspect'
      );
    END IF;
  END LOOP;
END $$;
