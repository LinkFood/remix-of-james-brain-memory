-- TEMP helper for inspecting pg_net responses during ct-signature-watcher
-- tier-eval verification. Will be dropped in the next migration after the
-- test confirms tiered alarms fire as expected.
CREATE OR REPLACE FUNCTION public.tmp_peek_net_response(p_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net
AS $$
DECLARE
  _row RECORD;
BEGIN
  SELECT id, status_code, content, error_msg
    INTO _row
    FROM net._http_response
    WHERE id = p_id;
  IF _row IS NULL THEN
    RETURN jsonb_build_object('found', false, 'id', p_id);
  END IF;
  RETURN jsonb_build_object(
    'found', true,
    'id', _row.id,
    'status_code', _row.status_code,
    'error_msg', _row.error_msg,
    'content', _row.content
  );
END $$;
