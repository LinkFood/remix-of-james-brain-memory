-- Graph Memory: brain_entities + entity_mentions
-- Gives JAC entity awareness across all saved content

SET search_path = public, extensions;

-- Brain entities — people, projects, places, concepts, orgs
CREATE TABLE brain_entities (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('person', 'project', 'place', 'concept', 'organization')),
  metadata JSONB DEFAULT '{}'::jsonb,
  mention_count INT DEFAULT 1,
  first_seen TIMESTAMPTZ DEFAULT now(),
  last_seen TIMESTAMPTZ DEFAULT now(),
  embedding extensions.vector(512),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- RLS
ALTER TABLE brain_entities ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own entities"
  ON brain_entities FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own entities"
  ON brain_entities FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own entities"
  ON brain_entities FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Service role full access to brain_entities"
  ON brain_entities FOR ALL
  USING (auth.role() = 'service_role');

-- Indices
CREATE INDEX idx_brain_entities_user_id ON brain_entities(user_id);
CREATE INDEX idx_brain_entities_name ON brain_entities(user_id, name);
CREATE INDEX idx_brain_entities_type ON brain_entities(user_id, entity_type);
CREATE INDEX idx_brain_entities_embedding ON brain_entities
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Entity mentions — links entities to entries and reflections
CREATE TABLE entity_mentions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  entity_id UUID NOT NULL REFERENCES brain_entities ON DELETE CASCADE,
  entry_id UUID REFERENCES entries ON DELETE SET NULL,
  reflection_id UUID REFERENCES jac_reflections ON DELETE SET NULL,
  context_snippet TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT at_least_one_source CHECK (entry_id IS NOT NULL OR reflection_id IS NOT NULL)
);

-- RLS via join to brain_entities (user owns the entity)
ALTER TABLE entity_mentions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own entity mentions"
  ON entity_mentions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM brain_entities
      WHERE brain_entities.id = entity_mentions.entity_id
      AND brain_entities.user_id = auth.uid()
    )
  );

CREATE POLICY "Service role full access to entity_mentions"
  ON entity_mentions FOR ALL
  USING (auth.role() = 'service_role');

-- Indices
CREATE INDEX idx_entity_mentions_entity_id ON entity_mentions(entity_id);
CREATE INDEX idx_entity_mentions_entry_id ON entity_mentions(entry_id);
CREATE INDEX idx_entity_mentions_reflection_id ON entity_mentions(reflection_id);

RESET search_path;
