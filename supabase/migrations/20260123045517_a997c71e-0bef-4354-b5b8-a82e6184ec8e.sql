-- Fix SECURITY DEFINER function to validate user authorization
-- This prevents direct RPC calls from querying other users' data

CREATE OR REPLACE FUNCTION public.search_entries_by_embedding(
  query_embedding vector, 
  filter_user_id uuid, 
  match_count integer DEFAULT 10, 
  match_threshold double precision DEFAULT 0.5
)
RETURNS TABLE(
  id uuid, 
  content text, 
  title text, 
  content_type text, 
  content_subtype text, 
  tags text[], 
  extracted_data jsonb, 
  importance_score integer, 
  list_items jsonb, 
  starred boolean, 
  created_at timestamp with time zone, 
  similarity double precision
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- SECURITY FIX: Verify the caller is authorized to query this user's data
  IF filter_user_id != auth.uid() THEN
    RAISE EXCEPTION 'Access denied: Cannot query other users data';
  END IF;

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