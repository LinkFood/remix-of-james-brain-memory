-- Fix embedding dimension for Voyage AI voyage-3-lite (1024-dim)
-- Previous: vector(1536) from unused OpenAI setup
-- All existing embeddings are NULL (generate-embedding was disabled), so no data loss
-- Note: vector extension lives in "extensions" schema (moved by migration 20260124230320)

-- Make vector type visible
SET search_path = public, extensions;

-- Drop existing indexes (names vary across migrations)
DROP INDEX IF EXISTS entries_embedding_idx;
DROP INDEX IF EXISTS idx_entries_embedding;

-- Change column dimension (all values are NULL so USING NULL is safe)
-- This is idempotent if already at 1024
ALTER TABLE public.entries
  ALTER COLUMN embedding TYPE extensions.vector(1024)
  USING NULL;

-- Recreate HNSW index for cosine distance
CREATE INDEX IF NOT EXISTS entries_embedding_idx ON public.entries
  USING hnsw (embedding extensions.vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Drop existing function first (return type changed, CREATE OR REPLACE can't handle that)
DROP FUNCTION IF EXISTS public.search_entries_by_embedding(extensions.vector, float, int, uuid);
DROP FUNCTION IF EXISTS public.search_entries_by_embedding(vector, float, int, uuid);

-- Recreate search function with correct dimension and additional return columns
CREATE FUNCTION public.search_entries_by_embedding(
  query_embedding extensions.vector(1024),
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

-- Reset search path
RESET search_path;
