DO $$
DECLARE
  _row RECORD;
BEGIN
  -- Wait briefly for the just-fired request to land.
  PERFORM pg_sleep(45);

  FOR _row IN
    SELECT id, status_code, LEFT(content::text, 1500) AS content_preview, error_msg, created
    FROM net._http_response
    WHERE id >= 102797
    ORDER BY id DESC
    LIMIT 5
  LOOP
    INSERT INTO public.ct_heartbeats(status_line, watching, current_reads, prompt_version)
    VALUES (
      '[grader3] req=' || _row.id || ' status=' || COALESCE(_row.status_code::text, 'null'),
      ARRAY['inspect'],
      jsonb_build_object(
        'request_id', _row.id,
        'status_code', _row.status_code,
        'error_msg', _row.error_msg,
        'content_preview', _row.content_preview,
        'created', _row.created
      ),
      'grader3'
    );
  END LOOP;
END $$;
