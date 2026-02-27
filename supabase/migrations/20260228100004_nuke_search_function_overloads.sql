-- Nuclear fix: drop ALL overloads of search_entries_by_embedding and recreate one
-- PostgREST error: "Could not choose the best candidate function"

DO $$
DECLARE
  func_oid oid;
BEGIN
  FOR func_oid IN
    SELECT p.oid
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.proname = 'search_entries_by_embedding'
  LOOP
    EXECUTE format('DROP FUNCTION IF EXISTS %s CASCADE', func_oid::regprocedure);
  END LOOP;
END;
$$;

-- Recreate single canonical version (512-dim, voyage-3-lite)
SET search_path = public, extensions;

CREATE FUNCTION public.search_entries_by_embedding(
  query_embedding extensions.vector(512),
  match_threshold float,
  match_count int,
  filter_user_id uuid
)
RETURNS TABLE (
  id uuid,
  content text,
  title text,
  content_type text,
  content_subtype text,
  tags text[],
  importance_score integer,
  created_at timestamptz,
  event_date date,
  event_time text,
  image_url text,
  similarity float
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  RETURN QUERY
  SELECT
    e.id,
    e.content,
    e.title,
    e.content_type,
    e.content_subtype,
    e.tags,
    e.importance_score,
    e.created_at,
    e.event_date,
    e.event_time,
    e.image_url,
    1 - (e.embedding <=> query_embedding) as similarity
  FROM public.entries e
  WHERE e.user_id = filter_user_id
    AND e.archived = false
    AND e.embedding IS NOT NULL
    AND 1 - (e.embedding <=> query_embedding) > match_threshold
  ORDER BY e.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

RESET search_path;
