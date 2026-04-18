-- jac_principles: add UI-facing fields for the Principles viewer.
--
-- The distiller cron writes principle + source_reflection_ids + confidence.
-- The viewer needs: category (grouping), severity (prioritization),
-- acknowledged (James has read it), retired_at (stop weighing it).
--
-- RLS already allows users to UPDATE their own rows (see
-- 20260301000003_jac_principles.sql). No policy widening is needed —
-- this migration only adds columns + an index for the active-set query.

SET search_path = public, extensions;

ALTER TABLE jac_principles
  ADD COLUMN IF NOT EXISTS category TEXT,
  ADD COLUMN IF NOT EXISTS severity INT DEFAULT 3 CHECK (severity >= 1 AND severity <= 5),
  ADD COLUMN IF NOT EXISTS acknowledged BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;

-- Active-set index: viewer pulls non-retired principles per user, ordered
-- by severity desc. This covers the primary list query.
CREATE INDEX IF NOT EXISTS idx_jac_principles_active
  ON jac_principles(user_id, severity DESC, created_at DESC)
  WHERE retired_at IS NULL;

RESET search_path;
