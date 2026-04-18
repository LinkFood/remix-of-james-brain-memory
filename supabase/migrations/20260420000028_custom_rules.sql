-- =============================================================================
-- 20260420000028_custom_rules.sql
--
-- User-authored custom alert rules for Co-Trader.
--
-- These are James's OWN alert triggers, distinct from Claude-authored alerts /
-- the watcher. Each rule is a tiny DSL: an array of condition clauses, a
-- match_logic ('all' = AND, 'any' = OR), and an action ('slack' / 'log' /
-- 'both'). Rules are evaluated every 5min during RTH by ct-custom-rule-eval,
-- which reads ct_heartbeats + a few support tables (ct_nope_minute,
-- ct_iv_rank_daily, ct_vix_history) and never issues new UW calls.
--
-- Conditions example (stored in `conditions` jsonb):
--   [
--     { "field": "SPY.price",      "op": "lt",             "value": 710 },
--     { "field": "SPY.NOPE",       "op": "crosses_below",  "value": 0, "window_min": 5 },
--     { "field": "NVDA.iv_rank",   "op": "gt",             "value": 70 }
--   ]
--
-- Ops: lt | lte | gt | gte | eq | crosses_above | crosses_below | changed
-- Fields: "{TICKER}.price" | "{TICKER}.regime" | "{TICKER}.NOPE" |
--         "{TICKER}.iv_rank" | "{TICKER}.call_wall" | "{TICKER}.put_wall" |
--         "{TICKER}.gamma_flip" | "VIX.level" | "SPX.gamma_flip" (etc)
--
-- Custom rules NEVER execute trades — they only push to Slack / log. That
-- line is enforced in the edge function, NOT here, but stated explicitly so
-- future contributors don't extend this for trade execution without thinking.
-- =============================================================================

SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 1) ct_custom_rules — the rules themselves
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_custom_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name            text NOT NULL,
  description     text,
  active          boolean NOT NULL DEFAULT true,
  conditions      jsonb NOT NULL DEFAULT '[]'::jsonb,
  match_logic     text NOT NULL DEFAULT 'all' CHECK (match_logic IN ('all','any')),
  action          text NOT NULL DEFAULT 'slack' CHECK (action IN ('slack','log','both')),
  fire_count      integer NOT NULL DEFAULT 0,
  last_fired_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE ct_custom_rules IS
  'User-authored alert triggers. Evaluated every 5min RTH by ct-custom-rule-eval. Never execute trades.';
COMMENT ON COLUMN ct_custom_rules.conditions IS
  'jsonb array of { field, op, value, window_min? } clauses. See migration header for field/op vocabulary.';
COMMENT ON COLUMN ct_custom_rules.match_logic IS
  'all = AND across clauses; any = OR across clauses.';
COMMENT ON COLUMN ct_custom_rules.action IS
  'slack = push to user channel; log = just insert a ct_custom_rule_fires row; both = do both.';

CREATE INDEX IF NOT EXISTS idx_ct_custom_rules_user_active
  ON ct_custom_rules (user_id, active)
  WHERE active = true;

-- Keep updated_at fresh on UPDATE.
CREATE OR REPLACE FUNCTION ct_custom_rules_touch_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ct_custom_rules_touch ON ct_custom_rules;
CREATE TRIGGER trg_ct_custom_rules_touch
  BEFORE UPDATE ON ct_custom_rules
  FOR EACH ROW
  EXECUTE FUNCTION ct_custom_rules_touch_updated_at();

-- ----------------------------------------------------------------------------
-- 2) ct_custom_rule_fires — audit log of every rule firing
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_custom_rule_fires (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id            uuid NOT NULL REFERENCES ct_custom_rules(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  fired_at           timestamptz NOT NULL DEFAULT now(),
  matched_clauses    jsonb NOT NULL DEFAULT '[]'::jsonb,
  matched_snapshot   jsonb NOT NULL DEFAULT '{}'::jsonb,
  slack_pushed       boolean NOT NULL DEFAULT false
);

COMMENT ON TABLE ct_custom_rule_fires IS
  'One row per time a ct_custom_rules row fires. matched_snapshot captures the state values that made it fire — this is the receipt.';

CREATE INDEX IF NOT EXISTS idx_ct_custom_rule_fires_rule_time
  ON ct_custom_rule_fires (rule_id, fired_at DESC);

CREATE INDEX IF NOT EXISTS idx_ct_custom_rule_fires_user_time
  ON ct_custom_rule_fires (user_id, fired_at DESC);

-- ----------------------------------------------------------------------------
-- 3) RLS — user_id scoping is the whole security story
-- ----------------------------------------------------------------------------
ALTER TABLE ct_custom_rules       ENABLE ROW LEVEL SECURITY;
ALTER TABLE ct_custom_rule_fires  ENABLE ROW LEVEL SECURITY;

-- ct_custom_rules: user manages their own rules.
DROP POLICY IF EXISTS ct_custom_rules_select_own ON ct_custom_rules;
CREATE POLICY ct_custom_rules_select_own ON ct_custom_rules
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS ct_custom_rules_insert_own ON ct_custom_rules;
CREATE POLICY ct_custom_rules_insert_own ON ct_custom_rules
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS ct_custom_rules_update_own ON ct_custom_rules;
CREATE POLICY ct_custom_rules_update_own ON ct_custom_rules
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS ct_custom_rules_delete_own ON ct_custom_rules;
CREATE POLICY ct_custom_rules_delete_own ON ct_custom_rules
  FOR DELETE USING (auth.uid() = user_id);

-- ct_custom_rule_fires: user sees their own fires. Inserts come from the
-- edge function via service role (bypasses RLS) — no insert policy needed
-- for end-users; they should never write fires directly.
DROP POLICY IF EXISTS ct_custom_rule_fires_select_own ON ct_custom_rule_fires;
CREATE POLICY ct_custom_rule_fires_select_own ON ct_custom_rule_fires
  FOR SELECT USING (auth.uid() = user_id);
