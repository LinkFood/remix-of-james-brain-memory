DO $$
DECLARE _row RECORD;
BEGIN
  FOR _row IN
    SELECT id, status_code, LEFT(content::text, 1500) AS body, error_msg, created
    FROM net._http_response
    WHERE id BETWEEN 102802 AND 102819
    ORDER BY id ASC
  LOOP
    INSERT INTO public.ct_heartbeats(status_line, watching, current_reads, prompt_version)
    VALUES (
      '[grader4] req=' || _row.id || ' status=' || COALESCE(_row.status_code::text,'null'),
      ARRAY['inspect'],
      jsonb_build_object('request_id',_row.id,'status_code',_row.status_code,
                         'error_msg',_row.error_msg,'body',_row.body,'created',_row.created),
      'grader4'
    );
  END LOOP;
END $$;
