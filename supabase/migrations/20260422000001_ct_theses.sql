-- ============================================================================
-- Co-Trader Hypothesis Engine — foundation for Claude's self-tuning reasoning
--
-- Distinct from the existing ct_theses table (which stores per-turn thesis
-- snapshots per instrument). This layer is persistent, narrative, and
-- self-tuning: Claude owns a stack of running hypotheses, each with
-- claim | because | invalidate_if, and the system grades them over time via
-- linked alerts and a Elo/confidence loop.
--
-- UI label remains "Thesis" — the table just lives under a different name to
-- avoid collision.
--
-- Design constraint: Claude-authored only. James's methodology stays separate.
-- Future divergence view compares claude vs james hypotheses; that's NOT v1.
--
-- Three tables:
--   ct_hypotheses            — the object itself, one row per claim
--   ct_hypothesis_evidence   — the evidence stack backing the claim
--   ct_hypothesis_events     — immutable audit log of every state change
--
-- Plus nullable FK `hypothesis_id` on ct_alerts / ct_flags / ct_observations /
-- ct_grades so every downstream artifact can cite its governing hypothesis.
-- ============================================================================
SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- ct_hypotheses — one row per Claude-authored hypothesis
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_hypotheses (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim               text NOT NULL,
  because             text[] NOT NULL DEFAULT ARRAY[]::text[],
  invalidate_if       text NOT NULL,
  horizon             text NOT NULL
                        CHECK (horizon IN ('session','week','month','open')),
  status              text NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','supported','refuted','zombie','retired')),
  confidence          numeric NOT NULL DEFAULT 0.50
                        CHECK (confidence >= 0 AND confidence <= 1),
  elo                 int NOT NULL DEFAULT 1500,
  created_by          text NOT NULL DEFAULT 'claude'
                        CHECK (created_by IN ('claude','james')),
  parent_hypothesis_id uuid REFERENCES ct_hypotheses(id) ON DELETE SET NULL,
  tickers             text[] NOT NULL DEFAULT ARRAY[]::text[],
  last_tested_at      timestamptz,
  invalidated_at      timestamptz,
  invalidated_reason  text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  last_edited_by      text
);

CREATE INDEX IF NOT EXISTS idx_ct_hypotheses_status
  ON ct_hypotheses (status, elo DESC);
CREATE INDEX IF NOT EXISTS idx_ct_hypotheses_open
  ON ct_hypotheses (status, last_tested_at DESC NULLS FIRST)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_ct_hypotheses_tickers
  ON ct_hypotheses USING GIN (tickers);

ALTER TABLE ct_hypotheses ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (true)',
                 'ct_hypotheses_authread', 'ct_hypotheses');
  EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)',
                 'ct_hypotheses_svcall', 'ct_hypotheses');
END $$;

CREATE OR REPLACE FUNCTION public.ct_hypotheses_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS ct_hypotheses_updated_at_trg ON ct_hypotheses;
CREATE TRIGGER ct_hypotheses_updated_at_trg
  BEFORE UPDATE ON ct_hypotheses
  FOR EACH ROW EXECUTE FUNCTION public.ct_hypotheses_touch_updated_at();

-- ----------------------------------------------------------------------------
-- ct_hypothesis_evidence — stack of observations / alerts / grades / etc.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_hypothesis_evidence (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hypothesis_id  uuid NOT NULL REFERENCES ct_hypotheses(id) ON DELETE CASCADE,
  evidence_type  text NOT NULL
                   CHECK (evidence_type IN (
                     'observation','alert','grade','news',
                     'flow','gex','regime','catalyst','manual'
                   )),
  source_id      uuid,
  polarity       text NOT NULL DEFAULT 'for'
                   CHECK (polarity IN ('for','against')),
  weight         numeric NOT NULL DEFAULT 0.5
                   CHECK (weight >= 0 AND weight <= 1),
  summary        text,
  added_at       timestamptz NOT NULL DEFAULT now(),
  added_by       text NOT NULL DEFAULT 'claude'
                   CHECK (added_by IN ('claude','james','cron'))
);

CREATE INDEX IF NOT EXISTS idx_ct_hypothesis_evidence_hyp
  ON ct_hypothesis_evidence (hypothesis_id, added_at DESC);
CREATE INDEX IF NOT EXISTS idx_ct_hypothesis_evidence_source
  ON ct_hypothesis_evidence (evidence_type, source_id)
  WHERE source_id IS NOT NULL;

ALTER TABLE ct_hypothesis_evidence ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (true)',
                 'ct_hypothesis_evidence_authread', 'ct_hypothesis_evidence');
  EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)',
                 'ct_hypothesis_evidence_svcall', 'ct_hypothesis_evidence');
END $$;

-- ----------------------------------------------------------------------------
-- ct_hypothesis_events — audit log of every state / confidence / elo change
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_hypothesis_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hypothesis_id   uuid NOT NULL REFERENCES ct_hypotheses(id) ON DELETE CASCADE,
  event_type      text NOT NULL
                    CHECK (event_type IN (
                      'created','confidence_update','elo_update','status_change',
                      'evidence_added','edited','invalidated','retired','promoted'
                    )),
  delta           numeric,
  before_value    numeric,
  after_value     numeric,
  reason          text NOT NULL,
  linked_grade_id uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text NOT NULL DEFAULT 'cron'
                    CHECK (created_by IN ('claude','james','cron','trigger'))
);

CREATE INDEX IF NOT EXISTS idx_ct_hypothesis_events_hyp
  ON ct_hypothesis_events (hypothesis_id, created_at DESC);

ALTER TABLE ct_hypothesis_events ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (true)',
                 'ct_hypothesis_events_authread', 'ct_hypothesis_events');
  EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)',
                 'ct_hypothesis_events_svcall', 'ct_hypothesis_events');
END $$;

-- ----------------------------------------------------------------------------
-- Thread hypothesis_id through downstream tables (nullable — zero risk).
-- ----------------------------------------------------------------------------
ALTER TABLE ct_alerts       ADD COLUMN IF NOT EXISTS hypothesis_id uuid REFERENCES ct_hypotheses(id) ON DELETE SET NULL;
ALTER TABLE ct_flags        ADD COLUMN IF NOT EXISTS hypothesis_id uuid REFERENCES ct_hypotheses(id) ON DELETE SET NULL;
ALTER TABLE ct_observations ADD COLUMN IF NOT EXISTS hypothesis_id uuid REFERENCES ct_hypotheses(id) ON DELETE SET NULL;
ALTER TABLE ct_grades       ADD COLUMN IF NOT EXISTS hypothesis_id uuid REFERENCES ct_hypotheses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ct_alerts_hypothesis
  ON ct_alerts (hypothesis_id) WHERE hypothesis_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ct_flags_hypothesis
  ON ct_flags (hypothesis_id) WHERE hypothesis_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ct_observations_hypothesis
  ON ct_observations (hypothesis_id) WHERE hypothesis_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ct_grades_hypothesis
  ON ct_grades (hypothesis_id) WHERE hypothesis_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- RPC: update_hypothesis_confidence — atomic confidence + elo + event log
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_hypothesis_confidence(
  p_hypothesis_id    uuid,
  p_confidence_delta numeric,
  p_elo_delta        int,
  p_reason           text,
  p_linked_grade_id  uuid DEFAULT NULL,
  p_event_type       text DEFAULT 'confidence_update'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_before_conf numeric;
  v_after_conf  numeric;
  v_before_elo  int;
  v_after_elo   int;
BEGIN
  SELECT confidence, elo INTO v_before_conf, v_before_elo
  FROM ct_hypotheses WHERE id = p_hypothesis_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'hypothesis % not found', p_hypothesis_id;
  END IF;

  v_after_conf := GREATEST(0, LEAST(1, v_before_conf + p_confidence_delta));
  v_after_elo  := GREATEST(600, v_before_elo + COALESCE(p_elo_delta, 0));

  UPDATE ct_hypotheses
     SET confidence     = v_after_conf,
         elo            = v_after_elo,
         last_tested_at = now()
   WHERE id = p_hypothesis_id;

  INSERT INTO ct_hypothesis_events (
    hypothesis_id, event_type, delta, before_value, after_value,
    reason, linked_grade_id, created_by
  ) VALUES (
    p_hypothesis_id, p_event_type, p_confidence_delta, v_before_conf, v_after_conf,
    p_reason, p_linked_grade_id, 'cron'
  );

  RETURN jsonb_build_object(
    'hypothesis_id', p_hypothesis_id,
    'confidence_before', v_before_conf,
    'confidence_after', v_after_conf,
    'elo_before', v_before_elo,
    'elo_after', v_after_elo
  );
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.update_hypothesis_confidence(uuid, numeric, int, text, uuid, text)
  TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- RPC: retire_hypothesis — status change + audit log atomically
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.retire_hypothesis(
  p_hypothesis_id uuid,
  p_status        text,
  p_reason        text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_prev_status text;
BEGIN
  IF p_status NOT IN ('refuted','zombie','retired','supported','open') THEN
    RAISE EXCEPTION 'invalid target status %', p_status;
  END IF;

  SELECT status INTO v_prev_status FROM ct_hypotheses WHERE id = p_hypothesis_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'hypothesis % not found', p_hypothesis_id;
  END IF;

  UPDATE ct_hypotheses
     SET status             = p_status,
         invalidated_at     = CASE WHEN p_status IN ('refuted','zombie','retired')
                                   THEN now() ELSE invalidated_at END,
         invalidated_reason = CASE WHEN p_status IN ('refuted','zombie','retired')
                                   THEN p_reason ELSE invalidated_reason END
   WHERE id = p_hypothesis_id;

  INSERT INTO ct_hypothesis_events (
    hypothesis_id, event_type, reason, created_by
  ) VALUES (
    p_hypothesis_id, 'status_change',
    format('%s → %s: %s', v_prev_status, p_status, p_reason),
    'cron'
  );

  RETURN jsonb_build_object(
    'hypothesis_id', p_hypothesis_id,
    'prev_status', v_prev_status,
    'new_status', p_status
  );
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.retire_hypothesis(uuid, text, text)
  TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Tunable knobs in ct_config — every self-tuning mechanic is dial-able.
-- ----------------------------------------------------------------------------
INSERT INTO ct_config (key, value, description, category, default_value) VALUES
  ('hypothesis_elo_k_initial',         '32',   'Elo K-factor for the first graded trade on a hypothesis', 'hypothesis', '32')
  ON CONFLICT (key) DO NOTHING;
INSERT INTO ct_config (key, value, description, category, default_value) VALUES
  ('hypothesis_elo_k_floor',           '12',   'Elo K-factor floor once sample > 20 grades', 'hypothesis', '12')
  ON CONFLICT (key) DO NOTHING;
INSERT INTO ct_config (key, value, description, category, default_value) VALUES
  ('hypothesis_confidence_decay_weekly', '0.10','Weekly confidence decay when no fresh evidence (fraction)', 'hypothesis', '0.10')
  ON CONFLICT (key) DO NOTHING;
INSERT INTO ct_config (key, value, description, category, default_value) VALUES
  ('hypothesis_zombie_confidence_threshold', '0.20', 'Below this confidence for N days -> zombie', 'hypothesis', '0.20')
  ON CONFLICT (key) DO NOTHING;
INSERT INTO ct_config (key, value, description, category, default_value) VALUES
  ('hypothesis_zombie_age_days',       '7',    'Days below confidence threshold before zombie retirement', 'hypothesis', '7')
  ON CONFLICT (key) DO NOTHING;
INSERT INTO ct_config (key, value, description, category, default_value) VALUES
  ('hypothesis_auto_promote_min_wins', '5',    'Graded wins required before hypothesis can promote to playbook', 'hypothesis', '5')
  ON CONFLICT (key) DO NOTHING;
INSERT INTO ct_config (key, value, description, category, default_value) VALUES
  ('hypothesis_auto_promote_min_winrate', '0.60', 'Win rate required for playbook promotion', 'hypothesis', '0.60')
  ON CONFLICT (key) DO NOTHING;
INSERT INTO ct_config (key, value, description, category, default_value) VALUES
  ('hypothesis_proposer_max_per_day',  '3',    'Ceiling on new hypotheses proposed per morning run', 'hypothesis', '3')
  ON CONFLICT (key) DO NOTHING;
INSERT INTO ct_config (key, value, description, category, default_value) VALUES
  ('hypothesis_proposer_lookback_hours', '36', 'How far back the proposer scans for seed material', 'hypothesis', '36')
  ON CONFLICT (key) DO NOTHING;
