-- Enable pgvector extension if not already enabled
CREATE EXTENSION IF NOT EXISTS vector;

-- Update the embedding column to use vector type with 768 dimensions (common embedding size)
-- Only alter if the column exists but isn't properly configured
DO $$ 
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'messages' 
    AND column_name = 'embedding'
  ) THEN
    ALTER TABLE public.messages 
    ALTER COLUMN embedding TYPE vector(768);
  END IF;
END $$;

-- Create an index for faster similarity search using cosine distance
CREATE INDEX IF NOT EXISTS messages_embedding_idx 
ON public.messages 
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);

-- Create a function to search messages by semantic similarity
CREATE OR REPLACE FUNCTION public.search_messages_by_embedding(
  query_embedding vector(768),
  match_threshold float,
  match_count int,
  filter_user_id uuid
)
RETURNS TABLE (
  id uuid,
  content text,
  role text,
  conversation_id uuid,
  created_at timestamptz,
  topic text,
  similarity float
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    m.id,
    m.content,
    m.role::text,
    m.conversation_id,
    m.created_at,
    m.topic,
    1 - (m.embedding <=> query_embedding) as similarity
  FROM public.messages m
  WHERE m.user_id = filter_user_id
    AND m.embedding IS NOT NULL
    AND 1 - (m.embedding <=> query_embedding) > match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;