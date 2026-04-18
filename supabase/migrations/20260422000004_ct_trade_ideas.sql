-- ============================================================================
-- Co-Trader v2: Claude as Independent Trader
--
-- This migration makes Claude an autonomous paper trader with its own book,
-- running in parallel to James. Key design principles:
--
--   1. Claude trades on its own authority. No approval queue. Paper money,
--      but treated as real from Claude's decision-making perspective.
--   2. Strict data isolation — Claude reads market data + its own theses,
--      trades, grades. It does NOT read James's trades, notes, or reviews.
--      Chat messages are tagged "advisory" — Claude considers but is not
--      bound by them.
--   3. Every table gets a `trader` column ('james' | 'claude'). Existing
--      rows default to 'james'. New Claude rows coexist cleanly.
--   4. ct_trade_ideas is the NEW bridge between hypothesis and book: Claude
--      writes concrete trade plans with trigger conditions; when the trigger
--      fires, a paper trade auto-commits to ct_trades.
--   5. ct_james_reviews stores James's after-the-fact thumbs-up/down —
--      persisted for James's own tracking but NEVER read by any Claude-facing
--      function. Claude stays independent.
-- ============================================================================
SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- Trader column on positions + book + rules. All default 'james' for existing
-- rows; Claude writes land with 'claude'.
-- ----------------------------------------------------------------------------
ALTER TABLE ct_trades
  ADD COLUMN IF NOT EXISTS trader text NOT NULL DEFAULT 'james'
    CHECK (trader IN ('james','claude'));
ALTER TABLE ct_trades
  ADD COLUMN IF NOT EXISTS hypothesis_id uuid REFERENCES ct_hypotheses(id) ON DELETE SET NULL;
ALTER TABLE ct_trades
  ADD COLUMN IF NOT EXISTS trade_idea_id uuid;

ALTER TABLE ct_book
  ADD COLUMN IF NOT EXISTS trader text NOT NULL DEFAULT 'james'
    CHECK (trader IN ('james','claude'));

ALTER TABLE ct_custom_rules
  ADD COLUMN IF NOT EXISTS trader text NOT NULL DEFAULT 'james'
    CHECK (trader IN ('james','claude'));

CREATE INDEX IF NOT EXISTS idx_ct_trades_trader
  ON ct_trades (trader, session_date DESC);
CREATE INDEX IF NOT EXISTS idx_ct_trades_hypothesis
  ON ct_trades (hypothesis_id) WHERE hypothesis_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ct_book_trader
  ON ct_book (trader, session_date DESC);
CREATE INDEX IF NOT EXISTS idx_ct_custom_rules_trader
  ON ct_custom_rules (trader);

-- ----------------------------------------------------------------------------
-- ct_trade_ideas — the bridge between hypothesis and executed trade.
--
-- Claude's workflow:
--   1. ct-trade-idea-generator runs each heartbeat
--   2. For each status='open' hypothesis, if market state matches a
--      tradeable pattern, writes an armed trade idea with trigger condition
--   3. Each heartbeat also scans armed ideas — when trigger evaluates true,
--      ct-claude-book-writer inserts a ct_trades row and flips status to
--      'filled'
--   4. ct-claude-book-exit-watcher scans open trades, closes on stop/target/
--      expiry; grades fire into ct_grades → hypothesis Elo updates
--
-- No 'approved' step. No human in the loop.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_trade_ideas (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hypothesis_id       uuid REFERENCES ct_hypotheses(id) ON DELETE SET NULL,
  trader              text NOT NULL DEFAULT 'claude'
                        CHECK (trader IN ('claude','james')),
  -- Instrument
  instrument          text NOT NULL,                   -- 'SPY', 'QQQ', 'SPX', etc
  contract_type       text NOT NULL DEFAULT 'stock'
                        CHECK (contract_type IN ('stock','call','put')),
  strike              numeric,
  expiry              date,
  direction           text NOT NULL
                        CHECK (direction IN ('long','short')),
  -- Entry
  entry_trigger       jsonb NOT NULL,                  -- {type,level,condition,...} — generator + writer agree on schema
  entry_price_target  numeric,                         -- projected entry price when trigger fires
  -- Risk
  stop_pct            numeric NOT NULL,                -- negative number = adverse move (e.g. -0.5 = 0.5% stop)
  target_pct          numeric NOT NULL,                -- positive number = favorable move (e.g. +1.2 = 1.2% target)
  size_pct            numeric NOT NULL
                        CHECK (size_pct > 0 AND size_pct <= 25),  -- hard ceiling on any single idea
  horizon             text NOT NULL
                        CHECK (horizon IN ('intraday','session','swing','multi_day')),
  -- Reasoning
  rationale           text NOT NULL,
  -- Lifecycle
  status              text NOT NULL DEFAULT 'armed'
                        CHECK (status IN ('armed','triggered','filled','expired','cancelled','rejected')),
  armed_at            timestamptz NOT NULL DEFAULT now(),
  triggered_at        timestamptz,
  filled_at           timestamptz,
  trade_id            uuid REFERENCES ct_trades(id) ON DELETE SET NULL,
  cancelled_reason    text,
  expires_at          timestamptz NOT NULL,            -- idea auto-cancels if trigger doesn't fire by this time
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ct_trade_ideas_status
  ON ct_trade_ideas (status, armed_at DESC);
CREATE INDEX IF NOT EXISTS idx_ct_trade_ideas_armed
  ON ct_trade_ideas (status, expires_at)
  WHERE status = 'armed';
CREATE INDEX IF NOT EXISTS idx_ct_trade_ideas_hypothesis
  ON ct_trade_ideas (hypothesis_id) WHERE hypothesis_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ct_trade_ideas_trader
  ON ct_trade_ideas (trader, status);

ALTER TABLE ct_trade_ideas ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (true)',
                 'ct_trade_ideas_authread', 'ct_trade_ideas');
  EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)',
                 'ct_trade_ideas_svcall', 'ct_trade_ideas');
END $$;

CREATE OR REPLACE FUNCTION public.ct_trade_ideas_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS ct_trade_ideas_updated_at_trg ON ct_trade_ideas;
CREATE TRIGGER ct_trade_ideas_updated_at_trg
  BEFORE UPDATE ON ct_trade_ideas
  FOR EACH ROW EXECUTE FUNCTION public.ct_trade_ideas_touch_updated_at();

-- Add FK from ct_trades back to ct_trade_ideas now that both exist.
ALTER TABLE ct_trades
  ADD CONSTRAINT ct_trades_trade_idea_fk
    FOREIGN KEY (trade_idea_id) REFERENCES ct_trade_ideas(id) ON DELETE SET NULL;

-- ----------------------------------------------------------------------------
-- ct_james_reviews — SANDBOXED. James's after-the-fact reactions to Claude's
-- trades. Persisted for James's own tracking. NEVER read by any Claude-facing
-- function. This is the isolation boundary that keeps Claude independent.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_james_reviews (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type    text NOT NULL
                    CHECK (subject_type IN ('trade','trade_idea','hypothesis','rule')),
  subject_id      uuid NOT NULL,
  thumb           text NOT NULL
                    CHECK (thumb IN ('up','down','neutral')),
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ct_james_reviews_subject
  ON ct_james_reviews (subject_type, subject_id);

ALTER TABLE ct_james_reviews ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  -- Only James reads this (authenticated). Service-role writes.
  EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (true)',
                 'ct_james_reviews_authread', 'ct_james_reviews');
  EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)',
                 'ct_james_reviews_svcall', 'ct_james_reviews');
END $$;

-- ----------------------------------------------------------------------------
-- Config knobs for Claude's autonomous trading. All tunable without redeploy.
-- ----------------------------------------------------------------------------
INSERT INTO ct_config (key, value, description, category, default_value) VALUES
  ('claude_autonomy_mode',              '"execute"'::jsonb, 'Claude trading mode: suggest (blocks on approval), draft (24h auto-approve), execute (no gate). Paper money only in v1.', 'claude', '"execute"'::jsonb)
  ON CONFLICT (key) DO NOTHING;
INSERT INTO ct_config (key, value, description, category, default_value) VALUES
  ('claude_paper_starting_balance',     '100000'::jsonb, 'Claude paper account starting balance in USD', 'claude', '100000'::jsonb)
  ON CONFLICT (key) DO NOTHING;
INSERT INTO ct_config (key, value, description, category, default_value) VALUES
  ('claude_max_concurrent_positions',   '5'::jsonb,      'Ceiling on simultaneously open Claude paper positions', 'claude', '5'::jsonb)
  ON CONFLICT (key) DO NOTHING;
INSERT INTO ct_config (key, value, description, category, default_value) VALUES
  ('claude_max_position_size_pct',      '5'::jsonb,      'Hard cap on size_pct for any single Claude trade idea', 'claude', '5'::jsonb)
  ON CONFLICT (key) DO NOTHING;
INSERT INTO ct_config (key, value, description, category, default_value) VALUES
  ('claude_chat_is_advisory',           'true'::jsonb,   'When true, Claude reads recent chat as advisory (not command). When false, Claude ignores chat entirely.', 'claude', 'true'::jsonb)
  ON CONFLICT (key) DO NOTHING;
INSERT INTO ct_config (key, value, description, category, default_value) VALUES
  ('claude_trade_idea_ttl_minutes',     '120'::jsonb,    'Default armed-to-expiry duration for new trade ideas (minutes)', 'claude', '120'::jsonb)
  ON CONFLICT (key) DO NOTHING;
INSERT INTO ct_config (key, value, description, category, default_value) VALUES
  ('claude_min_hypothesis_confidence',  '0.45'::jsonb,   'Minimum hypothesis confidence before Claude will generate trade ideas from it', 'claude', '0.45'::jsonb)
  ON CONFLICT (key) DO NOTHING;
INSERT INTO ct_config (key, value, description, category, default_value) VALUES
  ('claude_generator_cooldown_minutes', '5'::jsonb,      'Minimum interval between ct-trade-idea-generator runs per hypothesis', 'claude', '5'::jsonb)
  ON CONFLICT (key) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Seed: ensure Claude has a session_date row in ct_book so the book-writer
-- can update cumulative balance without a NOT NULL violation on day one.
-- Only inserts if today's row doesn't exist; subsequent days handled in-code.
-- ----------------------------------------------------------------------------
INSERT INTO ct_book (
  trader, session_date, starting_balance, ending_balance, realized_pnl,
  unrealized_pnl, high_water_mark, trades_count,
  wins, losses, max_drawdown_pct
)
SELECT 'claude',
       (now() AT TIME ZONE 'America/New_York')::date,
       100000, 100000, 0, 0, 100000, 0, 0, 0, 0
WHERE NOT EXISTS (
  SELECT 1 FROM ct_book
  WHERE trader = 'claude'
    AND session_date = (now() AT TIME ZONE 'America/New_York')::date
);
