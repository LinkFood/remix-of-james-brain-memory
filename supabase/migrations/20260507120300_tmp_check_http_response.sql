CREATE OR REPLACE FUNCTION public._tmp_check_http_response(req_ids bigint[])
RETURNS TABLE(id bigint, status_code int, content_type text, error_msg text, body_excerpt text)
LANGUAGE sql SECURITY DEFINER
SET search_path = public, net, extensions
AS $fn$
  SELECT id, status_code, content_type, error_msg, left(content, 300) AS body_excerpt
  FROM net._http_response
  WHERE id = ANY(req_ids)
  ORDER BY id DESC;
$fn$;

ALTER FUNCTION public._tmp_check_http_response(bigint[]) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public._tmp_check_http_response(bigint[]) TO service_role;
