-- Memory Decay: access tracking + decay-weighted search
-- Recently accessed entries stay sharp; stale entries fade

SET search_path = public, extensions;

-- Add access tracking columns to entries
ALTER TABLE entries ADD COLUMN IF NOT EXISTS access_count INT DEFAULT 0;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ;

-- bump_access: increment access_count and set last_accessed_at for given entry IDs
CREATE OR REPLACE FUNCTION bump_access(entry_ids UUID[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE entries
  SET access_count = access_count + 1,
      last_accessed_at = now()
  WHERE id = ANY(entry_ids);
END;
$$;

-- Drop existing search function (matches current 4-arg signature)
DROP FUNCTION IF EXISTS public.search_entries_by_embedding(extensions.vector, double precision, integer, uuid);

-- Recreated search_entries_by_embedding with optional decay_weight param
-- Preserves all existing return columns (event_date, event_time, image_url)
CREATE FUNCTION public.search_entries_by_embedding(
  query_embedding extensions.vector(512),
  match_threshold float DEFAULT 0.3,
  match_count int DEFAULT 10,
  filter_user_id uuid DEFAULT NULL,
  decay_weight boolean DEFAULT false
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
    CASE
      WHEN decay_weight THEN
        (1 - (e.embedding <=> query_embedding)) *
        (0.5 + 0.5 / (1.0 + EXTRACT(EPOCH FROM (now() - COALESCE(e.last_accessed_at, e.created_at))) / (30.0 * 86400.0)))
      ELSE
        1 - (e.embedding <=> query_embedding)
    END AS similarity
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
