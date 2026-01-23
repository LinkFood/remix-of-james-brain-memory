-- Create RPC function for semantic search on entries by embedding
CREATE OR REPLACE FUNCTION public.search_entries_by_embedding(
  query_embedding vector(768),
  match_threshold float,
  match_count int,
  filter_user_id uuid
)
RETURNS TABLE (
  id uuid,
  content text,
  title text,
  content_type text,
  tags text[],
  importance_score integer,
  created_at timestamptz,
  similarity float
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    e.id,
    e.content,
    e.title,
    e.content_type,
    e.tags,
    e.importance_score,
    e.created_at,
    1 - (e.embedding <=> query_embedding) as similarity
  FROM public.entries e
  WHERE e.user_id = filter_user_id
    AND e.embedding IS NOT NULL
    AND 1 - (e.embedding <=> query_embedding) > match_threshold
  ORDER BY e.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
