-- ============================================================================
-- Co-Trader Generational Framework
--
-- Tenet 14 (Survival pressure + cost of inaction) made operational.
-- Tenet 17 (Generational evolution over permanent termination) made operational.
--
-- Each Claude generation:
--   - Starts with $50,000 paper capital
--   - Has 14 trading days to reach $60,000 (+20%)
--   - Fired if target missed by day 15, OR balance drops below $30,000 (survival)
--   - Success = generation continues + next 14-day window + stakes compound
--
-- Firing is not death — the account resets, but ALL data persists (decisions,
-- dreams, principles, biases, hypotheses, grades, trades). Each new generation
-- inherits the accumulated wisdom of all prior generations. The pressure is
-- always forward: "last generation was fired at day N for reason X. I have 14
-- days to do better, OR I'm next."
-- ============================================================================
SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- ct_claude_generations — lineage table. One row per generation.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_claude_generations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_number      int NOT NULL UNIQUE,
  started_at             timestamptz NOT NULL DEFAULT now(),
  ended_at               timestamptz,
  status                 text NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','fired','succeeded','abandoned')),
  fire_reason            text
                           CHECK (fire_reason IN (
                             'survival_breach','performance_floor','time_cap',
                             'hallucination_cascade','manual_reset','target_hit'
                           )),

  -- Stakes
  starting_balance_usd   numeric NOT NULL,
  target_balance_usd     numeric NOT NULL,
  survival_floor_usd     numeric NOT NULL,
  target_days            int NOT NULL,

  -- Outcome
  ending_balance_usd     numeric,
  total_return_pct       numeric,
  max_drawdown_pct       numeric,
  days_lived             int,

  -- Stats
  total_trades           int NOT NULL DEFAULT 0,
  wins                   int NOT NULL DEFAULT 0,
  losses                 int NOT NULL DEFAULT 0,
  hallucinations_flagged int NOT NULL DEFAULT 0,
  circuit_breakers_tripped int NOT NULL DEFAULT 0,
  signal_categories_used text[] NOT NULL DEFAULT ARRAY[]::text[],
  best_hypothesis_id     uuid REFERENCES ct_hypotheses(id) ON DELETE SET NULL,

  -- Lineage
  predecessor_id         uuid REFERENCES ct_claude_generations(id) ON DELETE SET NULL,
  lessons_applied        text[] NOT NULL DEFAULT ARRAY[]::text[]  -- principle ids inherited
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ct_claude_generations_active
  ON ct_claude_generations (status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_ct_claude_generations_number
  ON ct_claude_generations (generation_number DESC);

ALTER TABLE ct_claude_generations ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (true)',
                 'ct_claude_generations_authread','ct_claude_generations');
  EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)',
                 'ct_claude_generations_svcall','ct_claude_generations');
END $$;

-- ----------------------------------------------------------------------------
-- Add generation_id to event/decision tables so we can slice data per-gen.
-- All nullable — existing rows (pre-generational era) stay null.
-- ----------------------------------------------------------------------------
ALTER TABLE ct_trades              ADD COLUMN IF NOT EXISTS generation_id uuid REFERENCES ct_claude_generations(id) ON DELETE SET NULL;
ALTER TABLE ct_trade_ideas         ADD COLUMN IF NOT EXISTS generation_id uuid REFERENCES ct_claude_generations(id) ON DELETE SET NULL;
ALTER TABLE ct_hypotheses          ADD COLUMN IF NOT EXISTS generation_id uuid REFERENCES ct_claude_generations(id) ON DELETE SET NULL;
ALTER TABLE ct_claude_decisions    ADD COLUMN IF NOT EXISTS generation_id uuid REFERENCES ct_claude_generations(id) ON DELETE SET NULL;
ALTER TABLE ct_daily_briefs        ADD COLUMN IF NOT EXISTS generation_id uuid REFERENCES ct_claude_generations(id) ON DELETE SET NULL;
ALTER TABLE ct_grades              ADD COLUMN IF NOT EXISTS generation_id uuid REFERENCES ct_claude_generations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ct_trades_generation
  ON ct_trades (generation_id) WHERE generation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ct_trade_ideas_generation
  ON ct_trade_ideas (generation_id) WHERE generation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ct_claude_decisions_generation
  ON ct_claude_decisions (generation_id) WHERE generation_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- Soft-cap override fields on trade_ideas. Tenet 15 — conditions not
-- prescriptions. Defaults stay in ct_config; Claude can override with
-- justification and the review path handles approve/modify/reject.
-- ----------------------------------------------------------------------------
ALTER TABLE ct_trade_ideas
  ADD COLUMN IF NOT EXISTS size_override_reasoning     text,
  ADD COLUMN IF NOT EXISTS no_stop_reasoning           text,
  ADD COLUMN IF NOT EXISTS concurrent_override_reasoning text,
  ADD COLUMN IF NOT EXISTS horizon_extended_reasoning  text,
  ADD COLUMN IF NOT EXISTS exit_mode                   text NOT NULL DEFAULT 'stop_target_horizon'
    CHECK (exit_mode IN ('stop_target_horizon','open_until_invalidated','theta_decay','manual'));

-- ----------------------------------------------------------------------------
-- Helper RPCs
-- ----------------------------------------------------------------------------

-- Get current active generation (or null)
CREATE OR REPLACE FUNCTION public.current_claude_generation()
RETURNS TABLE (
  id uuid, generation_number int, started_at timestamptz,
  starting_balance_usd numeric, target_balance_usd numeric,
  survival_floor_usd numeric, target_days int,
  days_elapsed int, days_remaining int
)
LANGUAGE sql STABLE AS $fn$
  SELECT
    g.id,
    g.generation_number,
    g.started_at,
    g.starting_balance_usd,
    g.target_balance_usd,
    g.survival_floor_usd,
    g.target_days,
    EXTRACT(day FROM (now() - g.started_at))::int AS days_elapsed,
    g.target_days - EXTRACT(day FROM (now() - g.started_at))::int AS days_remaining
  FROM ct_claude_generations g
  WHERE g.status = 'active'
  ORDER BY g.generation_number DESC
  LIMIT 1;
$fn$;
GRANT EXECUTE ON FUNCTION public.current_claude_generation() TO authenticated, service_role;

-- Is Claude allowed to open new positions?
CREATE OR REPLACE FUNCTION public.claude_can_open_positions()
RETURNS TABLE (allowed boolean, reason text)
LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  v_gen ct_claude_generations%ROWTYPE;
  v_balance numeric;
BEGIN
  SELECT * INTO v_gen FROM ct_claude_generations WHERE status = 'active' ORDER BY generation_number DESC LIMIT 1;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'no active generation — system dormant';
    RETURN;
  END IF;

  SELECT ending_balance INTO v_balance FROM ct_book
    WHERE trader = 'claude'
    ORDER BY session_date DESC
    LIMIT 1;
  IF v_balance IS NULL THEN v_balance := v_gen.starting_balance_usd; END IF;

  IF v_balance < v_gen.survival_floor_usd THEN
    RETURN QUERY SELECT false, format('survival breached: balance %s < floor %s', v_balance, v_gen.survival_floor_usd);
    RETURN;
  END IF;

  IF EXTRACT(day FROM (now() - v_gen.started_at))::int > v_gen.target_days THEN
    RETURN QUERY SELECT false, format('generation expired: day %s > cap %s', EXTRACT(day FROM (now() - v_gen.started_at))::int, v_gen.target_days);
    RETURN;
  END IF;

  RETURN QUERY SELECT true, 'within generation window';
END;
$fn$;
GRANT EXECUTE ON FUNCTION public.claude_can_open_positions() TO authenticated, service_role;

-- Seed config
INSERT INTO ct_config (key, value, description, category, default_value) VALUES
  ('claude_starting_balance_usd',     '50000'::jsonb, 'Paper capital each generation begins with', 'generational', '50000'::jsonb)
  ON CONFLICT (key) DO NOTHING;
INSERT INTO ct_config (key, value, description, category, default_value) VALUES
  ('claude_generation_target_usd',    '10000'::jsonb, 'Profit target per 14-day generation (absolute $)', 'generational', '10000'::jsonb)
  ON CONFLICT (key) DO NOTHING;
INSERT INTO ct_config (key, value, description, category, default_value) VALUES
  ('claude_generation_days',          '14'::jsonb, 'Trading days to hit target before generation fires', 'generational', '14'::jsonb)
  ON CONFLICT (key) DO NOTHING;
INSERT INTO ct_config (key, value, description, category, default_value) VALUES
  ('claude_survival_threshold_usd',   '30000'::jsonb, 'Balance below this = generation fired on survival breach', 'generational', '30000'::jsonb)
  ON CONFLICT (key) DO NOTHING;
INSERT INTO ct_config (key, value, description, category, default_value) VALUES
  ('claude_cash_decay_daily_pct',     '0.03'::jsonb, 'Daily cost on uninvested cash (% per day) — cost of inaction', 'generational', '0.03'::jsonb)
  ON CONFLICT (key) DO NOTHING;
INSERT INTO ct_config (key, value, description, category, default_value) VALUES
  ('claude_size_hard_ceiling_pct',    '10'::jsonb, 'Hard cap on size_pct even with override justification', 'generational', '10'::jsonb)
  ON CONFLICT (key) DO NOTHING;

-- Seed Generation 1 so the system has an active gen as of migration apply.
-- If ct_claude_generations already has rows (shouldn't on first apply), skip.
INSERT INTO ct_claude_generations (
  generation_number, starting_balance_usd, target_balance_usd,
  survival_floor_usd, target_days, status
)
SELECT 1, 50000, 60000, 30000, 14, 'active'
WHERE NOT EXISTS (SELECT 1 FROM ct_claude_generations);

-- Reset Claude's ct_book row to match the generation starting balance if
-- today's row is still at the pre-generational starting amount. Don't mutate
-- rows that have already traded.
UPDATE ct_book
   SET starting_balance = 50000,
       ending_balance = 50000,
       high_water_mark = 50000
 WHERE trader = 'claude'
   AND session_date = (now() AT TIME ZONE 'America/New_York')::date
   AND trades_count = 0;
