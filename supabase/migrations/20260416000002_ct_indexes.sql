-- ============================================================================
-- Co-Trader Indexes
-- ============================================================================
SET search_path = public, extensions;

-- ============================================================================
-- Vector search on embeddings (IVFFlat — lists=100 is right for small corpus;
-- bump when we cross ~10K embeddings per rebuild)
-- ============================================================================
CREATE INDEX IF NOT EXISTS ct_embeddings_ivfflat
  ON ct_embeddings
  USING ivfflat (embedding extensions.vector_cosine_ops)
  WITH (lists = 100);

-- Metadata filtering for embedding search
CREATE INDEX IF NOT EXISTS ct_embeddings_item_type_idx
  ON ct_embeddings (item_type);

CREATE INDEX IF NOT EXISTS ct_embeddings_metadata_instrument_idx
  ON ct_embeddings ((metadata->>'instrument'));

CREATE INDEX IF NOT EXISTS ct_embeddings_metadata_instrument_created_idx
  ON ct_embeddings ((metadata->>'instrument'), created_at DESC);

-- ============================================================================
-- Grader pickup indexes — ungrades items waiting for horizon close
-- ============================================================================
CREATE INDEX IF NOT EXISTS ct_flags_ungraded_idx
  ON ct_flags (horizon_end)
  WHERE grade_id IS NULL;

CREATE INDEX IF NOT EXISTS ct_alerts_ungraded_idx
  ON ct_alerts (horizon_end)
  WHERE grade_id IS NULL;

CREATE INDEX IF NOT EXISTS ct_james_views_ungraded_idx
  ON ct_james_views (horizon_end)
  WHERE grade_id IS NULL;

-- ============================================================================
-- Per-instrument recent-history lookups (used by memory recall)
-- ============================================================================
CREATE INDEX IF NOT EXISTS ct_flags_instrument_created_idx
  ON ct_flags USING GIN (instruments);
CREATE INDEX IF NOT EXISTS ct_flags_created_idx
  ON ct_flags (created_at DESC);

CREATE INDEX IF NOT EXISTS ct_observations_instrument_created_idx
  ON ct_observations USING GIN (instruments);
CREATE INDEX IF NOT EXISTS ct_observations_created_idx
  ON ct_observations (created_at DESC);

CREATE INDEX IF NOT EXISTS ct_alerts_instruments_gin_idx
  ON ct_alerts USING GIN (instruments);
CREATE INDEX IF NOT EXISTS ct_alerts_created_idx
  ON ct_alerts (created_at DESC);

CREATE INDEX IF NOT EXISTS ct_theses_instrument_idx
  ON ct_theses (instrument);

CREATE INDEX IF NOT EXISTS ct_thesis_history_instrument_created_idx
  ON ct_thesis_history (instrument, created_at DESC);

-- ============================================================================
-- Heartbeat rolling window (we'll trim older than 7 days via scheduled job)
-- ============================================================================
CREATE INDEX IF NOT EXISTS ct_heartbeats_created_desc_idx
  ON ct_heartbeats (created_at DESC);

-- ============================================================================
-- James views + disagreements
-- ============================================================================
CREATE INDEX IF NOT EXISTS ct_james_views_instrument_horizon_idx
  ON ct_james_views (instrument, horizon_end);

CREATE INDEX IF NOT EXISTS ct_disagreements_resolution_idx
  ON ct_disagreements (resolution, horizon_end);

CREATE INDEX IF NOT EXISTS ct_disagreements_instrument_idx
  ON ct_disagreements (instrument, created_at DESC);

-- ============================================================================
-- Grades — lookups by subject + performance queries
-- ============================================================================
CREATE INDEX IF NOT EXISTS ct_grades_subject_idx
  ON ct_grades (subject_type, subject_id);

CREATE INDEX IF NOT EXISTS ct_grades_instrument_graded_idx
  ON ct_grades (instrument, graded_at DESC);

CREATE INDEX IF NOT EXISTS ct_grades_verdict_idx
  ON ct_grades (verdict);

-- ============================================================================
-- Lessons — active + per-instrument retrieval
-- ============================================================================
CREATE INDEX IF NOT EXISTS ct_lessons_active_idx
  ON ct_lessons (active, created_at DESC) WHERE active = true;

CREATE INDEX IF NOT EXISTS ct_lessons_instruments_gin_idx
  ON ct_lessons USING GIN (instruments);

-- ============================================================================
-- GEX snapshots — most-recent-per-symbol queries
-- ============================================================================
CREATE INDEX IF NOT EXISTS ct_gex_snapshots_symbol_time_idx
  ON ct_gex_snapshots (index_symbol, snapshot_at DESC);

-- ============================================================================
-- News — per-instrument recent feed
-- ============================================================================
CREATE INDEX IF NOT EXISTS ct_news_instrument_created_idx
  ON ct_news_analyses (instrument, created_at DESC);

-- ============================================================================
-- Reports — by type + period
-- ============================================================================
CREATE INDEX IF NOT EXISTS ct_reports_type_period_idx
  ON ct_reports (report_type, period_end DESC);
