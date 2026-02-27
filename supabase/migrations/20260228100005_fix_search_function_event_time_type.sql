-- Fix: event_time column is 'time' type, not 'text'
SET search_path = public, extensions;

DROP FUNCTION IF EXISTS public.search_entries_by_embedding(extensions.vector, double precision, integer, uuid);

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
  event_time time,
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
