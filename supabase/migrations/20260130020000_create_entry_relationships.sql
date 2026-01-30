-- Entry Relationships table for the Connect layer
-- Stores semantic similarity relationships between entries
CREATE TABLE IF NOT EXISTS public.entry_relationships (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  entry_id UUID NOT NULL REFERENCES public.entries(id) ON DELETE CASCADE,
  related_entry_id UUID NOT NULL REFERENCES public.entries(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  similarity_score FLOAT NOT NULL DEFAULT 0,
  relationship_type TEXT NOT NULL DEFAULT 'semantic',
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(entry_id, related_entry_id)
);

-- Indexes for fast lookup
CREATE INDEX IF NOT EXISTS idx_entry_relationships_entry_id ON public.entry_relationships(entry_id);
CREATE INDEX IF NOT EXISTS idx_entry_relationships_related_entry_id ON public.entry_relationships(related_entry_id);
CREATE INDEX IF NOT EXISTS idx_entry_relationships_user_id ON public.entry_relationships(user_id);
CREATE INDEX IF NOT EXISTS idx_entry_relationships_score ON public.entry_relationships(similarity_score DESC);

-- RLS: Users can only see their own relationships
ALTER TABLE public.entry_relationships ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own relationships"
  ON public.entry_relationships FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own relationships"
  ON public.entry_relationships FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own relationships"
  ON public.entry_relationships FOR DELETE
  USING (auth.uid() = user_id);

-- Service role can do everything
CREATE POLICY "Service role full access"
  ON public.entry_relationships FOR ALL
  USING (true)
  WITH CHECK (true);
