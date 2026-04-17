-- ============================================================================
-- Co-Trader Schema — Claude as persistent trading partner
-- Prefix: ct_* (namespaced clean from existing JAC tables)
-- ============================================================================
-- Single-user MVP (James). RLS: service role full access, authenticated read.
-- See /docs/quant-pivot/schema.md for design rationale.
-- ============================================================================

SET search_path = public, extensions;

-- ============================================================================
-- THESES — current per-instrument view (mutable, history in ct_thesis_history)
-- ============================================================================
CREATE TABLE IF NOT EXISTS ct_theses (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  instrument        text NOT NULL,
  direction         text NOT NULL CHECK (direction IN ('bullish','bearish','neutral','volatility')),
  conviction        int  NOT NULL CHECK (conviction BETWEEN 1 AND 5),
  up_case           text NOT NULL,
  down_case         text NOT NULL,
  watching          text,
  rationale         text,
  author            text NOT NULL DEFAULT 'claude',
  prompt_version    text NOT NULL DEFAULT 'v1',
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, instrument)
);

-- ============================================================================
-- THESIS HISTORY — append-only audit log of thesis changes
-- ============================================================================
CREATE TABLE IF NOT EXISTS ct_thesis_history (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  instrument             text NOT NULL,
  previous_direction     text,
  new_direction          text NOT NULL,
  previous_conviction    int,
  new_conviction         int NOT NULL,
  reason                 text NOT NULL,
  triggered_by_type      text,          -- 'observation' | 'flag' | 'alert' | 'manual'
  triggered_by_id        uuid,
  prompt_version         text NOT NULL DEFAULT 'v1',
  created_at             timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- OBSERVATIONS — notable but not actionable (logged, embedded, no push)
-- ============================================================================
CREATE TABLE IF NOT EXISTS ct_observations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  instruments            text[] NOT NULL,
  observation            text NOT NULL,       -- full reasoning block
  glance                 text[],              -- 3-5 plain-English bullets
  up_case                text,
  up_case_odds           numeric,
  down_case              text,
  down_case_odds         numeric,
  direction              text CHECK (direction IN ('bullish','bearish','neutral','volatility')),
  prior_read             text,
  update_note            text,
  watching               text,
  memory_recall_used     jsonb,               -- which past items retrieved
  prompt_version         text NOT NULL DEFAULT 'v1',
  created_at             timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- FLAGS — committed calls with conviction + horizon (graded at horizon close)
-- ============================================================================
CREATE TABLE IF NOT EXISTS ct_flags (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  instruments            text[] NOT NULL,
  direction              text NOT NULL CHECK (direction IN ('bullish','bearish','neutral','volatility')),
  conviction             int  NOT NULL CHECK (conviction BETWEEN 1 AND 4),
  horizon                text NOT NULL CHECK (horizon IN ('1h','4h','EOD','next-day','weekly')),
  horizon_end            timestamptz NOT NULL,
  entry_prices           jsonb NOT NULL,      -- {"SPY": 542.15, "NVDA": 892.40}
  up_case                text NOT NULL,
  up_case_odds           numeric NOT NULL,
  down_case              text NOT NULL,
  down_case_odds         numeric NOT NULL,
  watching               text,
  full_reasoning         text NOT NULL,
  glance                 text[] NOT NULL,
  memory_recall_used     jsonb,
  author                 text NOT NULL DEFAULT 'claude',
  prompt_version         text NOT NULL DEFAULT 'v1',
  grade_id               uuid,                -- fk set after grading
  created_at             timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- ALERTS — urgent / time-critical (conviction 5 or event-triggered)
-- ============================================================================
CREATE TABLE IF NOT EXISTS ct_alerts (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  instruments            text[] NOT NULL,
  direction              text NOT NULL CHECK (direction IN ('bullish','bearish','neutral','volatility')),
  conviction             int  NOT NULL DEFAULT 5 CHECK (conviction = 5),
  horizon                text NOT NULL,
  horizon_end            timestamptz NOT NULL,
  entry_prices           jsonb NOT NULL,
  up_case                text NOT NULL,
  up_case_odds           numeric NOT NULL,
  down_case              text NOT NULL,
  down_case_odds         numeric NOT NULL,
  watching               text,
  full_reasoning         text NOT NULL,
  glance                 text[] NOT NULL,
  memory_recall_used     jsonb,
  alert_trigger          text NOT NULL CHECK (alert_trigger IN ('regime_shift','thesis_invalidation','news','vol_event','other')),
  urgency_window_minutes int,
  acknowledged_at        timestamptz,
  author                 text NOT NULL DEFAULT 'claude',
  prompt_version         text NOT NULL DEFAULT 'v1',
  grade_id               uuid,
  created_at             timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- HEARTBEATS — quiet cycle pings (rolling window, not embedded)
-- ============================================================================
CREATE TABLE IF NOT EXISTS ct_heartbeats (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status_line       text NOT NULL,
  watching          text[] NOT NULL,
  current_reads     jsonb,                    -- per-instrument brief state
  prompt_version    text NOT NULL DEFAULT 'v1',
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- JAMES VIEWS — posted via Slack slash commands or chat
-- ============================================================================
CREATE TABLE IF NOT EXISTS ct_james_views (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  instrument        text NOT NULL,
  direction         text NOT NULL CHECK (direction IN ('bullish','bearish','neutral','volatility')),
  conviction        int  NOT NULL CHECK (conviction BETWEEN 1 AND 5),
  horizon           text NOT NULL CHECK (horizon IN ('1h','4h','EOD','next-day','weekly')),
  horizon_end       timestamptz NOT NULL,
  entry_price       numeric,
  rationale         text,
  source            text NOT NULL DEFAULT 'slack' CHECK (source IN ('slack','chat','web','api')),
  grade_id          uuid,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- DISAGREEMENTS — materialized when james ≠ claude on same instrument/horizon
-- ============================================================================
CREATE TABLE IF NOT EXISTS ct_disagreements (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  instrument        text NOT NULL,
  horizon           text NOT NULL,
  horizon_end       timestamptz NOT NULL,
  james_view_id     uuid NOT NULL REFERENCES ct_james_views(id) ON DELETE CASCADE,
  claude_flag_id    uuid NOT NULL REFERENCES ct_flags(id) ON DELETE CASCADE,
  james_direction   text NOT NULL,
  claude_direction  text NOT NULL,
  resolution        text NOT NULL DEFAULT 'pending'
                     CHECK (resolution IN ('pending','claude_right','james_right','both_wrong','both_right','ambiguous')),
  resolution_detail text,
  resolved_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (james_view_id, claude_flag_id)
);

-- ============================================================================
-- GRADES — outcomes scored at horizon close
-- ============================================================================
CREATE TABLE IF NOT EXISTS ct_grades (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type       text NOT NULL CHECK (subject_type IN ('flag','alert','james_view')),
  subject_id         uuid NOT NULL,
  instrument         text NOT NULL,
  claimed_direction  text NOT NULL,
  claimed_odds_up    numeric,
  claimed_odds_down  numeric,
  entry_price        numeric,
  exit_price         numeric,
  actual_return_pct  numeric NOT NULL,
  actual_direction   text NOT NULL CHECK (actual_direction IN ('bullish','bearish','flat')),
  verdict            text NOT NULL CHECK (verdict IN ('right','wrong','ambiguous','partial')),
  calibration_delta  numeric,                 -- odds error (stated vs actual)
  notes              text,
  graded_at          timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- LESSONS — curated ADD/SUPERSEDE/SKIP (weekly consolidation)
-- ============================================================================
CREATE TABLE IF NOT EXISTS ct_lessons (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  lesson             text NOT NULL,
  source_items       uuid[],                  -- observations/flags that generated it
  instruments        text[],                  -- applies to (null = universal)
  curation_action    text NOT NULL CHECK (curation_action IN ('ADD','SUPERSEDE')),
  supersedes_lesson  uuid REFERENCES ct_lessons(id) ON DELETE SET NULL,
  active             boolean NOT NULL DEFAULT true,
  prompt_version     text NOT NULL DEFAULT 'v1',
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- GEX SNAPSHOTS — SPX (primary) + SPY (secondary)
-- ============================================================================
CREATE TABLE IF NOT EXISTS ct_gex_snapshots (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  index_symbol       text NOT NULL CHECK (index_symbol IN ('SPX','SPY','QQQ','IWM')),
  call_wall          numeric,
  put_wall           numeric,
  gamma_flip         numeric,
  zero_gamma         numeric,
  total_gex          numeric,
  gex_profile        jsonb,                   -- [{strike, gamma_exposure}]
  raw_source         text NOT NULL DEFAULT 'unusual_whales',
  snapshot_at        timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- NEWS ANALYSES — Claude's take per ticker per event
-- ============================================================================
CREATE TABLE IF NOT EXISTS ct_news_analyses (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  instrument         text NOT NULL,
  news_headline      text NOT NULL,
  news_source        text,
  news_url           text,
  news_timestamp     timestamptz,
  claude_take        text NOT NULL,
  impact             text NOT NULL CHECK (impact IN ('bullish','bearish','neutral','mixed')),
  significance       int  NOT NULL CHECK (significance BETWEEN 1 AND 5),
  prompt_version     text NOT NULL DEFAULT 'v1',
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- REPORTS — EOD / weekly / quarterly recaps
-- ============================================================================
CREATE TABLE IF NOT EXISTS ct_reports (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  report_type        text NOT NULL CHECK (report_type IN ('eod','weekly','quarterly')),
  period_start       timestamptz NOT NULL,
  period_end         timestamptz NOT NULL,
  summary            text NOT NULL,
  decomposition      jsonb,                   -- factors + weights + notes
  rabbit_hole        text,
  scorecard          jsonb,                   -- precision, calibration, blind spots
  self_assessment    text,
  prompt_version     text NOT NULL DEFAULT 'v1',
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- EMBEDDINGS — unified semantic index across all ct_* embeddable items
-- ============================================================================
CREATE TABLE IF NOT EXISTS ct_embeddings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_type      text NOT NULL CHECK (item_type IN
                   ('observation','flag','alert','thesis','lesson','report','news','james_view')),
  item_id        uuid NOT NULL,
  embedding      extensions.vector(512) NOT NULL,
  metadata       jsonb NOT NULL DEFAULT '{}',  -- instrument, direction, conviction, grade, etc.
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_type, item_id)
);

-- Add FK from flags/alerts/james_views to grades (deferred until grades table exists)
ALTER TABLE ct_flags
  ADD CONSTRAINT ct_flags_grade_fk FOREIGN KEY (grade_id) REFERENCES ct_grades(id) ON DELETE SET NULL;
ALTER TABLE ct_alerts
  ADD CONSTRAINT ct_alerts_grade_fk FOREIGN KEY (grade_id) REFERENCES ct_grades(id) ON DELETE SET NULL;
ALTER TABLE ct_james_views
  ADD CONSTRAINT ct_james_views_grade_fk FOREIGN KEY (grade_id) REFERENCES ct_grades(id) ON DELETE SET NULL;

-- ============================================================================
-- RLS — single-user MVP. Authenticated reads. Service role writes.
-- ============================================================================
ALTER TABLE ct_theses           ENABLE ROW LEVEL SECURITY;
ALTER TABLE ct_thesis_history   ENABLE ROW LEVEL SECURITY;
ALTER TABLE ct_observations     ENABLE ROW LEVEL SECURITY;
ALTER TABLE ct_flags            ENABLE ROW LEVEL SECURITY;
ALTER TABLE ct_alerts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE ct_heartbeats       ENABLE ROW LEVEL SECURITY;
ALTER TABLE ct_james_views      ENABLE ROW LEVEL SECURITY;
ALTER TABLE ct_disagreements    ENABLE ROW LEVEL SECURITY;
ALTER TABLE ct_grades           ENABLE ROW LEVEL SECURITY;
ALTER TABLE ct_lessons          ENABLE ROW LEVEL SECURITY;
ALTER TABLE ct_gex_snapshots    ENABLE ROW LEVEL SECURITY;
ALTER TABLE ct_news_analyses    ENABLE ROW LEVEL SECURITY;
ALTER TABLE ct_reports          ENABLE ROW LEVEL SECURITY;
ALTER TABLE ct_embeddings       ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read everything (single-user trust model)
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'ct_theses','ct_thesis_history','ct_observations','ct_flags','ct_alerts',
    'ct_heartbeats','ct_james_views','ct_disagreements','ct_grades','ct_lessons',
    'ct_gex_snapshots','ct_news_analyses','ct_reports','ct_embeddings'
  ])
  LOOP
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (true)',
                   t || '_authenticated_read', t);
  END LOOP;
END $$;

-- Service role has full access (bypasses RLS via service_role key, but policies good practice)
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'ct_theses','ct_thesis_history','ct_observations','ct_flags','ct_alerts',
    'ct_heartbeats','ct_james_views','ct_disagreements','ct_grades','ct_lessons',
    'ct_gex_snapshots','ct_news_analyses','ct_reports','ct_embeddings'
  ])
  LOOP
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)',
                   t || '_service_role_all', t);
  END LOOP;
END $$;
