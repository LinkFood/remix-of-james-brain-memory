-- Trigger: null embedding when content/title/tags change
-- Uses IS DISTINCT FROM so it does NOT fire when backfill writes just the embedding column
-- Also deletes stale entry_relationships so backfill recreates them with the new vector

CREATE OR REPLACE FUNCTION nullify_embedding_on_content_change()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.content IS DISTINCT FROM NEW.content
     OR OLD.title IS DISTINCT FROM NEW.title
     OR OLD.tags IS DISTINCT FROM NEW.tags THEN
    NEW.embedding := NULL;
    DELETE FROM entry_relationships WHERE entry_id = OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_nullify_embedding ON entries;

CREATE TRIGGER trg_nullify_embedding
  BEFORE UPDATE ON entries
  FOR EACH ROW
  EXECUTE FUNCTION nullify_embedding_on_content_change();
