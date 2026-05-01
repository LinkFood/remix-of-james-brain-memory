-- One-shot: dump pg_net response for grader fires post-gate-fix.
-- Reads request ids from the most-recent ct_heartbeats grader run trail.
DO $$
DECLARE
  _row RECORD;
  _id  bigint;
BEGIN
  -- Inspect the latest 5 outbound function calls (any function) — easier than
  -- guessing exact request ids. Filters to ct-flag-grader by URL match.
  FOR _row IN
    SELECT id, status_code, LEFT(content::text, 1500) AS content_preview, error_msg, created
    FROM net._http_response
    ORDER BY id DESC
    LIMIT 25
  LOOP
    INSERT INTO public.ct_heartbeats(status_line, watching, current_reads, prompt_version)
    VALUES (
      '[grader-net-2] req=' || _row.id || ' status=' || COALESCE(_row.status_code::text, 'null'),
      ARRAY['inspect'],
      jsonb_build_object(
        'request_id', _row.id,
        'status_code', _row.status_code,
        'error_msg', _row.error_msg,
        'content_preview', _row.content_preview,
        'created', _row.created
      ),
      'grader-net-inspect-2'
    );
  END LOOP;
END $$;
