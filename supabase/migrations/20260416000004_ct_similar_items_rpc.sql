-- ct_similar_items — memory-recall similarity search RPC
SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.ct_similar_items(
  p_instrument text,
  p_query_embedding extensions.vector(512),
  p_limit int DEFAULT 5
)
RETURNS TABLE (
  type text,
  id uuid,
  instrument text,
  claimed_direction text,
  conviction int,
  verdict text,
  actual_return_pct numeric,
  created_at timestamptz,
  distance double precision
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
  SELECT
    s.item_type::text,
    s.item_id,
    p_instrument,
    (s.metadata->>'direction'),
    NULLIF((s.metadata->>'conviction'),'')::int,
    g.verdict,
    g.actual_return_pct,
    COALESCE(NULLIF((s.metadata->>'created_at'),'')::timestamptz, now()),
    s.distance
  FROM (
    SELECT
      e.item_type,
      e.item_id,
      e.metadata,
      (e.embedding <=> p_query_embedding)::double precision AS distance
    FROM ct_embeddings e
    WHERE (e.metadata->>'instrument') = p_instrument
      AND e.item_type IN ('observation','flag','alert')
    ORDER BY e.embedding <=> p_query_embedding
    LIMIT p_limit
  ) s
  LEFT JOIN ct_grades g
    ON g.subject_id = s.item_id
   AND g.subject_type = s.item_type
  ORDER BY s.distance;
$fn$;

GRANT EXECUTE ON FUNCTION public.ct_similar_items(text, extensions.vector, int) TO authenticated, service_role;
