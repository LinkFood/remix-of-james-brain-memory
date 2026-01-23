-- Fix embedding column: convert from TEXT to vector(1536)
-- Using NULL for existing values since TEXT embeddings are invalid format
ALTER TABLE public.entries 
  ALTER COLUMN embedding TYPE vector(1536) 
  USING NULL;

-- Create HNSW index for fast similarity search
CREATE INDEX IF NOT EXISTS idx_entries_embedding 
  ON public.entries 
  USING hnsw (embedding vector_cosine_ops);

-- Create semantic search function for entries
CREATE OR REPLACE FUNCTION public.search_entries_by_embedding(
  query_embedding vector(1536),
  filter_user_id uuid,
  match_count int DEFAULT 10,
  match_threshold float DEFAULT 0.5
)
RETURNS TABLE (
  id uuid,
  content text,
  title text,
  content_type text,
  content_subtype text,
  tags text[],
  extracted_data jsonb,
  importance_score int,
  list_items jsonb,
  starred boolean,
  created_at timestamptz,
  similarity float
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RETURN QUERY
  SELECT
    e.id, e.content, e.title, e.content_type, e.content_subtype,
    e.tags, e.extracted_data, e.importance_score, e.list_items,
    e.starred, e.created_at,
    (1 - (e.embedding <=> query_embedding))::float as similarity
  FROM public.entries e
  WHERE e.user_id = filter_user_id
    AND e.embedding IS NOT NULL
    AND e.archived = false
    AND 1 - (e.embedding <=> query_embedding) > match_threshold
  ORDER BY e.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;