-- Fix: voyage-3-lite returns 512-dim vectors, not 1024
-- Previous migration set vector(1024) but actual API returns 512

SET search_path = public, extensions;

-- Drop index
DROP INDEX IF EXISTS entries_embedding_idx;

-- Resize column to 512
ALTER TABLE public.entries
  ALTER COLUMN embedding TYPE extensions.vector(512)
  USING NULL;

-- Recreate index
CREATE INDEX entries_embedding_idx ON public.entries
  USING hnsw (embedding extensions.vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Drop and recreate function with 512-dim param
DROP FUNCTION IF EXISTS public.search_entries_by_embedding(extensions.vector, float, int, uuid);

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
