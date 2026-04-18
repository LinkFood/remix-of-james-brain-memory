-- ============================================================================
-- Co-Trader Phase 1 Foundation
--
-- Wave A — all the tables that subsequent Phase 1 waves depend on.
--
--   ct_claude_decisions       — every Claude thought/decision, signal-decomposed
--   ct_principles             — distilled wisdom (was missing, scorecard refs)
--   ct_daily_briefs           — PM-tier Sonnet morning briefing
--   ct_breaking_news          — Tavily real-time geopolitical/macro watcher
--   ct_ticker_snapshots       — cached per-ticker quant card
--   ct_claude_circuit_breakers — intra-day loss-halt state
--   ct_claude_heartbeat       — "is Claude alive" monitor
--
-- Plus signal-decomposition columns on trade ideas + trades so every trade
-- carries its narrative_signal / tape_signal / alignment explicitly. This is
-- the mechanism that lets Claude LEARN tape-vs-narrative resolution over time.
-- ============================================================================
SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- ct_claude_decisions — THE thought-stream. Every Haiku/Sonnet/Opus call
-- Claude makes persists a row here. Without this table we cannot diagnose
-- anything. Every subsequent function retrofits to write here.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_claude_decisions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- What kind of decision
  decision_type        text NOT NULL
                         CHECK (decision_type IN (
                           'propose_hypothesis','arm_trade_idea','no_trade',
                           'fill_trade','close_trade','update_hypothesis',
                           'invalidate_hypothesis','promote_playbook',
                           'retire_hypothesis','brief_generated','brief_rebriefed',
                           'breaking_news_processed','circuit_breaker_tripped',
                           'circuit_breaker_cleared','reflection','stress_check',
                           'evidence_tagged','trade_journal','size_override',
                           'hallucination_flagged'
                         )),
  -- Which model tier did the thinking
  model_tier           text NOT NULL DEFAULT 'haiku'
                         CHECK (model_tier IN ('opus','sonnet','haiku','none')),
  -- What Claude saw going in
  context_snapshot     jsonb,              -- compressed inputs (brief, hyp, heartbeat refs)
  -- Signal decomposition — the core of tape-vs-narrative learning
  narrative_signal     jsonb,              -- { direction, confidence, sources[], reasoning }
  tape_signal          jsonb,              -- { direction, confidence, sources[], reasoning }
  alignment            text
                         CHECK (alignment IN ('aligned','conflict','partial','insufficient_data','n/a')),
  claude_followed      text,               -- 'narrative' | 'tape' | 'both' | 'neither'
  -- Reasoning trail
  reasoning            text NOT NULL,
  tool_calls_summary   jsonb,              -- which UW endpoints / DB reads happened
  outcome              text,               -- what Claude did: 'armed_xyz', 'skipped_because_abc'
  -- Linkage
  linked_hypothesis_id uuid REFERENCES ct_hypotheses(id) ON DELETE SET NULL,
  linked_trade_idea_id uuid REFERENCES ct_trade_ideas(id) ON DELETE SET NULL,
  linked_trade_id      uuid REFERENCES ct_trades(id) ON DELETE SET NULL,
  linked_brief_id      uuid,               -- FK added after ct_daily_briefs created below
  -- Hallucination check
  hallucination_flag   boolean NOT NULL DEFAULT false,
  hallucination_reason text,
  -- Housekeeping
  created_at           timestamptz NOT NULL DEFAULT now(),
  tokens_in            int,
  tokens_out           int,
  cost_usd             numeric
);

CREATE INDEX IF NOT EXISTS idx_ct_claude_decisions_type_time
  ON ct_claude_decisions (decision_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ct_claude_decisions_recent
  ON ct_claude_decisions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ct_claude_decisions_hypothesis
  ON ct_claude_decisions (linked_hypothesis_id) WHERE linked_hypothesis_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ct_claude_decisions_hallucination
  ON ct_claude_decisions (created_at DESC) WHERE hallucination_flag = true;

ALTER TABLE ct_claude_decisions ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (true)',
                 'ct_claude_decisions_authread','ct_claude_decisions');
  EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)',
                 'ct_claude_decisions_svcall','ct_claude_decisions');
END $$;

-- ----------------------------------------------------------------------------
-- ct_principles — wisdom distilled by weekly reflection. Claude refers back to
-- these when making decisions. Missing since day 1.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_principles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trader          text NOT NULL DEFAULT 'claude'
                    CHECK (trader IN ('claude','james')),
  principle       text NOT NULL,                  -- the distilled statement
  derivation      text,                            -- how we got here (references to reflections)
  strength        numeric NOT NULL DEFAULT 0.5
                    CHECK (strength >= 0 AND strength <= 1),
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','deprecated','under_review')),
  domain          text,                            -- 'execution' | 'psychology' | 'vol' | 'flow' | 'macro' | ...
  support_count   int NOT NULL DEFAULT 0,          -- # confirming observations
  refute_count    int NOT NULL DEFAULT 0,          -- # contradicting observations
  last_tested_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ct_principles_active
  ON ct_principles (trader, status, strength DESC)
  WHERE status = 'active';

ALTER TABLE ct_principles ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (true)',
                 'ct_principles_authread','ct_principles');
  EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)',
                 'ct_principles_svcall','ct_principles');
END $$;

-- ----------------------------------------------------------------------------
-- ct_daily_briefs — Sonnet's morning world-view. One per session_date with
-- possible urgent re-briefs layered on top (`triggered_by`, `supersedes_id`).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_daily_briefs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_date         date NOT NULL,
  -- Sequencing — multiple briefs per day possible (morning + urgent re-brief)
  brief_version        int NOT NULL DEFAULT 1,
  triggered_by         text NOT NULL DEFAULT 'scheduled'
                         CHECK (triggered_by IN ('scheduled','breaking_news','manual','regime_shift')),
  supersedes_id        uuid REFERENCES ct_daily_briefs(id) ON DELETE SET NULL,
  urgency              text NOT NULL DEFAULT 'normal'
                         CHECK (urgency IN ('normal','elevated','high','acute')),
  -- The world model
  macro_narrative      text NOT NULL,             -- one-paragraph world context
  macro_regime         text,                      -- 'risk-off' | 'risk-on' | 'chop' | 'pre-fed' | etc
  breaking_events      jsonb,                     -- array of {source, headline, severity, time}
  overnight_action     text,                      -- futures + fx + overnight news summary
  recent_prints        jsonb,                     -- array of macro prints with deltas
  -- Per-ticker (the 12 watchlist) quant cards
  per_ticker           jsonb NOT NULL,            -- array of ticker cards (see schema in docs)
  -- Convergence — the 1-3 actually tradeable ideas
  convergent_view      text NOT NULL,
  high_conviction_ideas jsonb,                    -- array of {instrument, direction, entry, stop, target, size_pct, reasoning}
  watchlist_focus      text[],                    -- tickers to lean into today
  skip_today           text[],                    -- tickers to avoid today
  -- Lifecycle
  generated_by_model   text NOT NULL DEFAULT 'sonnet',
  ttl_hours            int NOT NULL DEFAULT 8,
  expires_at           timestamptz NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  -- Accuracy tracking (filled in post-session by reflection)
  accuracy_score       numeric,                   -- 0-1, how well brief matched day
  accuracy_notes       text
);

CREATE INDEX IF NOT EXISTS idx_ct_daily_briefs_session
  ON ct_daily_briefs (session_date DESC, brief_version DESC);
CREATE INDEX IF NOT EXISTS idx_ct_daily_briefs_expires
  ON ct_daily_briefs (expires_at DESC);

ALTER TABLE ct_daily_briefs ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (true)',
                 'ct_daily_briefs_authread','ct_daily_briefs');
  EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)',
                 'ct_daily_briefs_svcall','ct_daily_briefs');
END $$;

-- Now add the FK on ct_claude_decisions.linked_brief_id
ALTER TABLE ct_claude_decisions
  ADD CONSTRAINT ct_claude_decisions_brief_fk
    FOREIGN KEY (linked_brief_id) REFERENCES ct_daily_briefs(id) ON DELETE SET NULL;

-- ----------------------------------------------------------------------------
-- ct_breaking_news — Tavily-sourced real-time high-severity events that don't
-- come through UW's scheduled news feed. Triggers re-briefs when severity ≥ 4.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_breaking_news (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  headline            text NOT NULL,
  url                 text,
  source              text,                        -- 'tavily' | 'uw_news' | 'manual'
  severity            int NOT NULL CHECK (severity >= 1 AND severity <= 5),
  sentiment           text
                         CHECK (sentiment IN ('bullish','bearish','neutral','ambiguous')),
  tickers_affected    text[] NOT NULL DEFAULT ARRAY[]::text[],
  macro_wide          boolean NOT NULL DEFAULT false,
  category            text,                        -- 'geopolitical' | 'macro' | 'earnings' | 'sector' | 'policy' | 'other'
  summary             text,
  raw                 jsonb,
  triggers_rebrief    boolean NOT NULL DEFAULT false,
  rebrief_id          uuid REFERENCES ct_daily_briefs(id) ON DELETE SET NULL,
  published_at        timestamptz,
  ingested_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ct_breaking_news_severity
  ON ct_breaking_news (severity DESC, ingested_at DESC);
CREATE INDEX IF NOT EXISTS idx_ct_breaking_news_recent
  ON ct_breaking_news (ingested_at DESC);
CREATE INDEX IF NOT EXISTS idx_ct_breaking_news_tickers
  ON ct_breaking_news USING GIN (tickers_affected);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ct_breaking_news_dedupe
  ON ct_breaking_news (source, COALESCE(url, headline));

ALTER TABLE ct_breaking_news ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (true)',
                 'ct_breaking_news_authread','ct_breaking_news');
  EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)',
                 'ct_breaking_news_svcall','ct_breaking_news');
END $$;

-- ----------------------------------------------------------------------------
-- ct_ticker_snapshots — cached per-ticker quant card. Built every heartbeat
-- so the generator doesn't hit 8 tables per ticker per pass. 12 rows
-- overwrite in place.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_ticker_snapshots (
  ticker              text PRIMARY KEY,
  -- Structural
  spot                numeric,
  gamma_flip          numeric,
  call_wall           numeric,
  put_wall            numeric,
  max_pain            numeric,
  iv_rank             numeric,
  iv_percentile       numeric,
  net_gamma           numeric,
  regime              text,
  -- Flow (rolling window snapshots)
  flow_last_hour      jsonb,                        -- { whales: [], net_prem: n, call_prem: n, put_prem: n, unusual_count: n }
  dark_pool_last_hour jsonb,                        -- { total_notional, largest, accumulation }
  greek_flow_last_hour jsonb,                       -- { net_delta_flow, net_vega_flow }
  -- Events
  next_earnings_date  date,
  earnings_expected_move numeric,
  upcoming_catalysts  jsonb,                        -- events from ct_events within 7d
  -- Sentiment
  nope_latest         numeric,
  put_call_ratio      numeric,
  net_premium_cum     numeric,                      -- cumulative today
  -- News
  recent_news         jsonb,                        -- last 5 ct_news_headlines + ct_breaking_news for this ticker
  -- Narrative (filled by brief)
  brief_tilt          text,                         -- brief's take on this ticker today
  avoid_today         boolean NOT NULL DEFAULT false,
  -- Freshness
  snapshot_at         timestamptz NOT NULL DEFAULT now(),
  source_brief_id     uuid REFERENCES ct_daily_briefs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_ct_ticker_snapshots_fresh
  ON ct_ticker_snapshots (snapshot_at DESC);

ALTER TABLE ct_ticker_snapshots ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (true)',
                 'ct_ticker_snapshots_authread','ct_ticker_snapshots');
  EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)',
                 'ct_ticker_snapshots_svcall','ct_ticker_snapshots');
END $$;

-- ----------------------------------------------------------------------------
-- ct_claude_circuit_breakers — state for intra-day trading halts. One row per
-- session_date when a breaker trips; stays until end of session.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_claude_circuit_breakers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_date      date NOT NULL,
  breaker_type      text NOT NULL
                      CHECK (breaker_type IN ('session_loss','concurrent_cascade','hallucination_rate','manual_halt','heartbeat_stale')),
  tripped_at        timestamptz NOT NULL DEFAULT now(),
  cleared_at        timestamptz,
  trigger_value     numeric,                        -- e.g. -2.3 for session_loss at -2.3%
  threshold         numeric,                        -- the config value it breached
  reason            text NOT NULL,
  auto_cleared      boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_ct_claude_circuit_breakers_session
  ON ct_claude_circuit_breakers (session_date, breaker_type)
  WHERE cleared_at IS NULL;

ALTER TABLE ct_claude_circuit_breakers ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (true)',
                 'ct_claude_circuit_breakers_authread','ct_claude_circuit_breakers');
  EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)',
                 'ct_claude_circuit_breakers_svcall','ct_claude_circuit_breakers');
END $$;

-- Helper RPC: is_claude_trading_halted(session_date)
CREATE OR REPLACE FUNCTION public.is_claude_trading_halted(
  p_session_date date DEFAULT (now() AT TIME ZONE 'America/New_York')::date
) RETURNS TABLE (halted boolean, breaker_type text, reason text, tripped_at timestamptz)
LANGUAGE sql STABLE AS $fn$
  SELECT true as halted, breaker_type, reason, tripped_at
  FROM ct_claude_circuit_breakers
  WHERE session_date = p_session_date AND cleared_at IS NULL
  ORDER BY tripped_at DESC
  LIMIT 1;
$fn$;

GRANT EXECUTE ON FUNCTION public.is_claude_trading_halted(date) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- ct_claude_heartbeat — "is Claude alive" check. ct-claude-health-monitor
-- checks for a recent decision journal entry; if stale during RTH, logs here.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_claude_heartbeat (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checked_at       timestamptz NOT NULL DEFAULT now(),
  status           text NOT NULL CHECK (status IN ('alive','stale','dead','off_hours')),
  last_decision_at timestamptz,
  minutes_since_decision numeric,
  note             text
);

CREATE INDEX IF NOT EXISTS idx_ct_claude_heartbeat_recent
  ON ct_claude_heartbeat (checked_at DESC);

ALTER TABLE ct_claude_heartbeat ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (true)',
                 'ct_claude_heartbeat_authread','ct_claude_heartbeat');
  EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)',
                 'ct_claude_heartbeat_svcall','ct_claude_heartbeat');
END $$;

-- ----------------------------------------------------------------------------
-- Signal decomposition columns on existing tables so every decision carries
-- narrative_signal + tape_signal + alignment. This is how we teach Claude to
-- resolve tape-vs-narrative conflicts over time.
-- ----------------------------------------------------------------------------
ALTER TABLE ct_trade_ideas
  ADD COLUMN IF NOT EXISTS narrative_signal jsonb,
  ADD COLUMN IF NOT EXISTS tape_signal      jsonb,
  ADD COLUMN IF NOT EXISTS alignment        text
    CHECK (alignment IN ('aligned','conflict','partial','insufficient_data','n/a')),
  ADD COLUMN IF NOT EXISTS claude_followed  text;

ALTER TABLE ct_trades
  ADD COLUMN IF NOT EXISTS narrative_signal jsonb,
  ADD COLUMN IF NOT EXISTS tape_signal      jsonb,
  ADD COLUMN IF NOT EXISTS alignment        text
    CHECK (alignment IN ('aligned','conflict','partial','insufficient_data','n/a')),
  ADD COLUMN IF NOT EXISTS claude_followed  text,
  ADD COLUMN IF NOT EXISTS brief_id_at_entry uuid REFERENCES ct_daily_briefs(id) ON DELETE SET NULL;

ALTER TABLE ct_hypotheses
  ADD COLUMN IF NOT EXISTS actionable boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS embedded_trade_setup jsonb;

-- ----------------------------------------------------------------------------
-- Config knobs for Phase 1
-- ----------------------------------------------------------------------------
INSERT INTO ct_config (key, value, description, category, default_value) VALUES
  ('claude_session_loss_halt_pct', '-2.0'::jsonb, 'Session realized+unrealized P&L % that trips circuit breaker (negative)', 'claude', '-2.0'::jsonb)
  ON CONFLICT (key) DO NOTHING;
INSERT INTO ct_config (key, value, description, category, default_value) VALUES
  ('claude_heartbeat_stale_minutes', '30'::jsonb, 'Minutes without a decision-journal entry during RTH before heartbeat is stale', 'claude', '30'::jsonb)
  ON CONFLICT (key) DO NOTHING;
INSERT INTO ct_config (key, value, description, category, default_value) VALUES
  ('claude_brief_ttl_hours', '8'::jsonb, 'Default daily-brief TTL in hours before it is considered stale', 'claude', '8'::jsonb)
  ON CONFLICT (key) DO NOTHING;
INSERT INTO ct_config (key, value, description, category, default_value) VALUES
  ('claude_breaking_news_severity_rebrief', '4'::jsonb, 'Minimum severity (1-5) that triggers an urgent re-brief', 'claude', '4'::jsonb)
  ON CONFLICT (key) DO NOTHING;
INSERT INTO ct_config (key, value, description, category, default_value) VALUES
  ('claude_size_sonnet_escalation_pct', '2.0'::jsonb, 'Trade idea size % that triggers Sonnet escalation over Haiku in generator', 'claude', '2.0'::jsonb)
  ON CONFLICT (key) DO NOTHING;
INSERT INTO ct_config (key, value, description, category, default_value) VALUES
  ('claude_max_hallucinations_per_hour', '3'::jsonb, 'Hallucination-flag count that trips the hallucination_rate circuit breaker', 'claude', '3'::jsonb)
  ON CONFLICT (key) DO NOTHING;
