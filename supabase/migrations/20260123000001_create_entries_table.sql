-- Create entries table for Brain Dump app
-- This is the core table for storing all "dumped" content

CREATE TABLE IF NOT EXISTS public.entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,

  -- Content
  content TEXT NOT NULL,
  title TEXT,

  -- Classification
  content_type TEXT NOT NULL DEFAULT 'note', -- code, list, idea, link, contact, event, reminder, note
  content_subtype TEXT, -- grocery, todo, javascript, etc.
  tags TEXT[] DEFAULT '{}',
  extracted_data JSONB DEFAULT '{}',

  -- AI Processing
  embedding vector(768),
  importance_score INTEGER CHECK (importance_score >= 0 AND importance_score <= 10),

  -- List-specific (for grocery, todos)
  list_items JSONB DEFAULT '[]', -- [{text: "eggs", checked: false}, ...]

  -- Metadata
  source TEXT DEFAULT 'manual', -- manual, assistant, api
  starred BOOLEAN DEFAULT false,
  archived BOOLEAN DEFAULT false,

  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Enable RLS
ALTER TABLE public.entries ENABLE ROW LEVEL SECURITY;

-- RLS Policies
DO $$ BEGIN
  CREATE POLICY "Users can view their own entries"
    ON public.entries FOR SELECT
    USING (auth.uid() = user_id);
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE POLICY "Users can create their own entries"
    ON public.entries FOR INSERT
    WITH CHECK (auth.uid() = user_id);
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE POLICY "Users can update their own entries"
    ON public.entries FOR UPDATE
    USING (auth.uid() = user_id);
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE POLICY "Users can delete their own entries"
    ON public.entries FOR DELETE
    USING (auth.uid() = user_id);
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_entries_user_created ON public.entries(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_user_type ON public.entries(user_id, content_type);
CREATE INDEX IF NOT EXISTS idx_entries_user_importance ON public.entries(user_id, importance_score DESC) WHERE importance_score IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entries_embedding ON public.entries USING hnsw (embedding vector_cosine_ops) WHERE embedding IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entries_tags ON public.entries USING gin(tags);
CREATE INDEX IF NOT EXISTS idx_entries_user_archived ON public.entries(user_id, archived, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_user_starred ON public.entries(user_id, starred, created_at DESC) WHERE starred = true;

-- Add trigger for entries updated_at
DROP TRIGGER IF EXISTS update_entries_updated_at ON public.entries;
CREATE TRIGGER update_entries_updated_at
  BEFORE UPDATE ON public.entries
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at();

-- Function to search entries by embedding
CREATE OR REPLACE FUNCTION public.search_entries_by_embedding(
  query_embedding vector(768),
  filter_user_id uuid,
  match_count int DEFAULT 10,
  match_threshold float DEFAULT 0.7
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
    e.extracted_data,
    e.importance_score,
    e.list_items,
    e.starred,
    e.created_at,
    1 - (e.embedding <=> query_embedding) as similarity
  FROM public.entries e
  WHERE e.user_id = filter_user_id
    AND e.embedding IS NOT NULL
    AND e.archived = false
    AND 1 - (e.embedding <=> query_embedding) > match_threshold
  ORDER BY e.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
