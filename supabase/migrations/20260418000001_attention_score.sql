-- =============================================================================
-- 20260418000001_attention_score.sql
--
-- Add a 0..100 "attention_score" column to every ct_* row the watcher emits:
-- observations, flags, alerts, heartbeats. The score is set at write time by
-- ct-watcher (cheap derivation) or backfilled by ct-attention-backfill (one-
-- shot walk of the last 7 days).
--
-- Also expose a UNION view `ct_attention_stream` so the UI can query one
-- timeline (kind, id, created_at, attention_score, summary) without joining
-- four tables on the client.
--
-- Indexes are (created_at DESC, attention_score DESC) so the default UI read
-- "latest high-attention first" is a single ordered scan.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- Columns (nullable, 0..100)
-- ----------------------------------------------------------------------------
ALTER TABLE ct_observations
  ADD COLUMN IF NOT EXISTS attention_score int
    CHECK (attention_score IS NULL OR attention_score BETWEEN 0 AND 100);

ALTER TABLE ct_flags
  ADD COLUMN IF NOT EXISTS attention_score int
    CHECK (attention_score IS NULL OR attention_score BETWEEN 0 AND 100);

ALTER TABLE ct_alerts
  ADD COLUMN IF NOT EXISTS attention_score int
    CHECK (attention_score IS NULL OR attention_score BETWEEN 0 AND 100);

ALTER TABLE ct_heartbeats
  ADD COLUMN IF NOT EXISTS attention_score int
    CHECK (attention_score IS NULL OR attention_score BETWEEN 0 AND 100);

COMMENT ON COLUMN ct_observations.attention_score IS
  '0..100 attention score. 100 = drop-what-you''re-doing. Powers UI sort + notification gating.';
COMMENT ON COLUMN ct_flags.attention_score IS
  '0..100 attention score. 100 = drop-what-you''re-doing. Powers UI sort + notification gating.';
COMMENT ON COLUMN ct_alerts.attention_score IS
  '0..100 attention score. 100 = drop-what-you''re-doing. Powers UI sort + notification gating.';
COMMENT ON COLUMN ct_heartbeats.attention_score IS
  '0..100 attention score. 100 = drop-what-you''re-doing. Powers UI sort + notification gating.';

-- ----------------------------------------------------------------------------
-- Indexes: (created_at DESC, attention_score DESC)
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_ct_observations_created_attention
  ON ct_observations (created_at DESC, attention_score DESC);

CREATE INDEX IF NOT EXISTS idx_ct_flags_created_attention
  ON ct_flags (created_at DESC, attention_score DESC);

CREATE INDEX IF NOT EXISTS idx_ct_alerts_created_attention
  ON ct_alerts (created_at DESC, attention_score DESC);

CREATE INDEX IF NOT EXISTS idx_ct_heartbeats_created_attention
  ON ct_heartbeats (created_at DESC, attention_score DESC);

-- ----------------------------------------------------------------------------
-- Unified attention stream view
--
-- UNION of all four ct_* row-producing tables, mapped into a common shape:
--   kind ∈ {observation,flag,alert,heartbeat}
--   id, created_at, attention_score, summary
--
-- summary is the single-line human read of the row:
--   heartbeat    → status_line
--   observation  → first glance bullet, falling back to observation
--   flag/alert   → first glance bullet, falling back to full_reasoning
--
-- Kept as a plain view (not materialized) — the underlying tables have
-- (created_at DESC, attention_score DESC) indexes, so ORDER BY + LIMIT on the
-- view pushes down cleanly.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW ct_attention_stream AS
  SELECT
    'observation'::text                           AS kind,
    id,
    created_at,
    attention_score,
    COALESCE(NULLIF(array_to_string(glance[1:1], ''), ''), LEFT(observation, 280)) AS summary
  FROM ct_observations
  UNION ALL
  SELECT
    'flag'::text                                  AS kind,
    id,
    created_at,
    attention_score,
    COALESCE(NULLIF(array_to_string(glance[1:1], ''), ''), LEFT(full_reasoning, 280)) AS summary
  FROM ct_flags
  UNION ALL
  SELECT
    'alert'::text                                 AS kind,
    id,
    created_at,
    attention_score,
    COALESCE(NULLIF(array_to_string(glance[1:1], ''), ''), LEFT(full_reasoning, 280)) AS summary
  FROM ct_alerts
  UNION ALL
  SELECT
    'heartbeat'::text                             AS kind,
    id,
    created_at,
    attention_score,
    status_line                                   AS summary
  FROM ct_heartbeats;

COMMENT ON VIEW ct_attention_stream IS
  'Unified (kind,id,created_at,attention_score,summary) timeline across ct_observations/flags/alerts/heartbeats. Sort by (created_at DESC, attention_score DESC) for the default UI stream.';
