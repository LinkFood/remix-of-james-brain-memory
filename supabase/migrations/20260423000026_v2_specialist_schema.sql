-- ============================================================================
-- Co-Trader v2 — Specialist model schema (Phase 1a)
-- ============================================================================
-- Context: v2 architecture is 10 per-ticker Claude specialists issuing
-- 0-100 conviction score flags, graded at horizon, learning from their
-- own track records. See docs/CO_TRADER_V2_SCOPE.md.
--
-- This migration is pure schema. No functions, no crons, no seeds that
-- depend on other v2 surface. Tables:
--   ct_flags (repurposed)        — specialist predictions
--   ct_flag_grades               — outcome per flag
--   ct_flag_patterns             — mined signatures + hit rates
--   ct_specialist_memory         — embedded reflections per ticker
--   ct_specialist_principles     — learned heuristics per ticker
--   ct_ticker_baselines          — nightly rollup per ticker
--   ct_oi_snapshots              — 3x/day OI state
--
-- NAMING CONFLICT: the v1 paper-trader ct_flags is renamed to
-- ct_flags_v1_archive first. Per scope doc, ct_trade_ideas becomes the
-- new ct_flags. All 52 existing rows + FKs are preserved; FKs auto-update
-- to point at the renamed table.
-- ============================================================================

SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 0. Retire the v1 ct_flags (rename, preserve data + FKs)
-- ----------------------------------------------------------------------------
ALTER TABLE IF EXISTS public.ct_flags RENAME TO ct_flags_v1_archive;

COMMENT ON TABLE public.ct_flags_v1_archive IS
  'DEPRECATED 2026-04-23 — v1 "claude-flag" schema. Renamed during v2 cutover. Historical only, no new writes. See CO_TRADER_V2_SCOPE.md.';

-- ----------------------------------------------------------------------------
-- 1. ct_flags — specialist predictions (v2)
-- ----------------------------------------------------------------------------
CREATE TABLE public.ct_flags (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  specialist_ticker TEXT NOT NULL,
  instrument        TEXT NOT NULL,
  option_symbol     TEXT,
  strike            NUMERIC,
  expiry            DATE,
  side              TEXT CHECK (side IN ('call','put')),
  direction         TEXT NOT NULL CHECK (direction IN ('bullish','bearish','neutral')),
  score             NUMERIC NOT NULL,
  score_breakdown   JSONB,
  tags              TEXT[],
  thesis            TEXT,
  invalidation      TEXT,
  horizon_hours     INTEGER NOT NULL,
  horizon_ts        TIMESTAMPTZ NOT NULL,
  entry_price       NUMERIC,
  target_price      NUMERIC,
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','conviction','graded','invalidated')),
  confirmed_t1      BOOLEAN DEFAULT false,
  source_flow_ids   UUID[],
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ct_flags_specialist_ticker ON public.ct_flags (specialist_ticker, created_at DESC);
CREATE INDEX idx_ct_flags_status ON public.ct_flags (status, horizon_ts);
CREATE INDEX idx_ct_flags_active_horizon ON public.ct_flags (horizon_ts) WHERE status IN ('active','conviction');

ALTER TABLE public.ct_flags ENABLE ROW LEVEL SECURITY;

CREATE POLICY ct_flags_read ON public.ct_flags
  FOR SELECT TO authenticated USING (true);

CREATE POLICY ct_flags_service ON public.ct_flags
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ct_flags IS
  'V2 specialist predictions. Each row is a 0-100 scored, graded, horizon-bounded flag issued by one of 10 per-ticker Claude specialists.';

-- ----------------------------------------------------------------------------
-- 2. ct_flag_grades — grader outcomes
-- ----------------------------------------------------------------------------
CREATE TABLE public.ct_flag_grades (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_id           UUID NOT NULL REFERENCES public.ct_flags(id) ON DELETE CASCADE,
  specialist_ticker TEXT NOT NULL,
  graded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  outcome           TEXT NOT NULL CHECK (outcome IN ('win','partial','loss','invalidated_early')),
  price_at_horizon  NUMERIC,
  price_change_pct  NUMERIC,
  spy_change_pct    NUMERIC,
  alpha_pct         NUMERIC,
  notes             TEXT,
  UNIQUE (flag_id)
);

CREATE INDEX idx_ct_flag_grades_specialist ON public.ct_flag_grades (specialist_ticker, graded_at DESC);

ALTER TABLE public.ct_flag_grades ENABLE ROW LEVEL SECURITY;

CREATE POLICY ct_flag_grades_read ON public.ct_flag_grades
  FOR SELECT TO authenticated USING (true);

CREATE POLICY ct_flag_grades_service ON public.ct_flag_grades
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ct_flag_grades IS
  'V2 flag outcomes at horizon. One row per flag. Writes by ct-flag-grader cron.';

-- ----------------------------------------------------------------------------
-- 3. ct_flag_patterns — mined signatures + outcomes
-- ----------------------------------------------------------------------------
CREATE TABLE public.ct_flag_patterns (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  specialist_ticker TEXT NOT NULL,
  signature_hash    TEXT NOT NULL,
  signature         JSONB NOT NULL,
  n_observations    INTEGER NOT NULL DEFAULT 0,
  n_wins            INTEGER NOT NULL DEFAULT 0,
  n_partials        INTEGER NOT NULL DEFAULT 0,
  n_losses          INTEGER NOT NULL DEFAULT 0,
  hit_rate          NUMERIC,
  avg_alpha_pct     NUMERIC,
  last_seen_at      TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (specialist_ticker, signature_hash)
);

CREATE INDEX idx_ct_flag_patterns_specialist ON public.ct_flag_patterns (specialist_ticker, hit_rate DESC);

ALTER TABLE public.ct_flag_patterns ENABLE ROW LEVEL SECURITY;

CREATE POLICY ct_flag_patterns_read ON public.ct_flag_patterns
  FOR SELECT TO authenticated USING (true);

CREATE POLICY ct_flag_patterns_service ON public.ct_flag_patterns
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ct_flag_patterns IS
  'V2 per-specialist pattern library: flag tag+score-bucket signatures with running hit rates.';

-- ----------------------------------------------------------------------------
-- 4. ct_specialist_memory — embedded reflections per ticker
-- ----------------------------------------------------------------------------
CREATE TABLE public.ct_specialist_memory (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  specialist_ticker TEXT NOT NULL,
  flag_id           UUID REFERENCES public.ct_flags(id) ON DELETE CASCADE,
  memory_type       TEXT NOT NULL CHECK (memory_type IN ('graded_flag','pattern_note','principle','bias')),
  summary           TEXT NOT NULL,
  embedding         extensions.vector(512),
  importance        INTEGER DEFAULT 5,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ct_specialist_memory_specialist
  ON public.ct_specialist_memory (specialist_ticker, created_at DESC);
CREATE INDEX idx_ct_specialist_memory_embedding
  ON public.ct_specialist_memory USING hnsw (embedding extensions.vector_cosine_ops);

ALTER TABLE public.ct_specialist_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY ct_specialist_memory_read ON public.ct_specialist_memory
  FOR SELECT TO authenticated USING (true);

CREATE POLICY ct_specialist_memory_service ON public.ct_specialist_memory
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ct_specialist_memory IS
  'V2 per-specialist embedded memory. Voyage 512-dim. HNSW index for semantic recall at wakeup.';

-- ----------------------------------------------------------------------------
-- 5. ct_specialist_principles — learned heuristics per ticker
-- ----------------------------------------------------------------------------
CREATE TABLE public.ct_specialist_principles (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  specialist_ticker TEXT NOT NULL,
  principle         TEXT NOT NULL,
  evidence_flags    UUID[],
  confidence        NUMERIC,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (specialist_ticker, principle)
);

CREATE INDEX idx_ct_specialist_principles_ticker
  ON public.ct_specialist_principles (specialist_ticker);

ALTER TABLE public.ct_specialist_principles ENABLE ROW LEVEL SECURITY;

CREATE POLICY ct_specialist_principles_read ON public.ct_specialist_principles
  FOR SELECT TO authenticated USING (true);

CREATE POLICY ct_specialist_principles_service ON public.ct_specialist_principles
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ct_specialist_principles IS
  'V2 per-specialist distilled heuristics. Extracted from graded-flag reflections.';

-- ----------------------------------------------------------------------------
-- 6. ct_ticker_baselines — nightly rollup
-- ----------------------------------------------------------------------------
CREATE TABLE public.ct_ticker_baselines (
  ticker                 TEXT NOT NULL,
  baseline_date          DATE NOT NULL,
  median_sweep_premium   NUMERIC,
  p90_sweep_premium      NUMERIC,
  avg_sweep_count_hourly NUMERIC,
  avg_flow_alerts_daily  NUMERIC,
  avg_whale_count_daily  NUMERIC,
  options_adv_30d        NUMERIC,
  iv_rank_30d            NUMERIC,
  computed_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ticker, baseline_date)
);

CREATE INDEX idx_ct_ticker_baselines_ticker_date
  ON public.ct_ticker_baselines (ticker, baseline_date DESC);

ALTER TABLE public.ct_ticker_baselines ENABLE ROW LEVEL SECURITY;

CREATE POLICY ct_ticker_baselines_read ON public.ct_ticker_baselines
  FOR SELECT TO authenticated USING (true);

CREATE POLICY ct_ticker_baselines_service ON public.ct_ticker_baselines
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ct_ticker_baselines IS
  'V2 nightly per-ticker baselines for "unusual FOR ME" normalization.';

-- ----------------------------------------------------------------------------
-- 7. ct_oi_snapshots — OI change tracker (3x/day)
-- ----------------------------------------------------------------------------
CREATE TABLE public.ct_oi_snapshots (
  id            BIGSERIAL PRIMARY KEY,
  ticker        TEXT NOT NULL,
  snap_date     DATE NOT NULL,
  snap_slot     TEXT NOT NULL CHECK (snap_slot IN ('open','mid','close')),
  option_symbol TEXT NOT NULL,
  strike        NUMERIC,
  expiry        DATE,
  side          TEXT,
  oi            INTEGER NOT NULL,
  oi_delta_1d   INTEGER,
  oi_delta_5d   INTEGER,
  volume_today  INTEGER,
  raw           JSONB,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ticker, snap_date, snap_slot, option_symbol)
);

CREATE INDEX idx_ct_oi_snapshots_ticker_date
  ON public.ct_oi_snapshots (ticker, snap_date DESC, snap_slot);
CREATE INDEX idx_ct_oi_snapshots_oi_delta
  ON public.ct_oi_snapshots (ticker, oi_delta_1d DESC NULLS LAST)
  WHERE oi_delta_1d IS NOT NULL;

ALTER TABLE public.ct_oi_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY ct_oi_snapshots_read ON public.ct_oi_snapshots
  FOR SELECT TO authenticated USING (true);

CREATE POLICY ct_oi_snapshots_service ON public.ct_oi_snapshots
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ct_oi_snapshots IS
  'V2 OI snapshots: 3x/day per ticker (open, mid, close). Feeds T+1 OI confirmation.';

-- ----------------------------------------------------------------------------
-- 8. ct_flags.updated_at auto-bump trigger
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._ct_flags_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER ct_flags_touch_updated_at
  BEFORE UPDATE ON public.ct_flags
  FOR EACH ROW EXECUTE FUNCTION public._ct_flags_touch_updated_at();

-- Auto-compute horizon_ts on insert if not supplied, and on update if horizon_hours changes
CREATE OR REPLACE FUNCTION public._ct_flags_compute_horizon_ts()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.horizon_ts IS NULL THEN
      NEW.horizon_ts = NEW.created_at + (NEW.horizon_hours || ' hours')::interval;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.horizon_hours IS DISTINCT FROM OLD.horizon_hours THEN
      NEW.horizon_ts = NEW.created_at + (NEW.horizon_hours || ' hours')::interval;
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

-- Allow horizon_ts to be NULL on insert; trigger fills it.
ALTER TABLE public.ct_flags ALTER COLUMN horizon_ts DROP NOT NULL;

CREATE TRIGGER ct_flags_compute_horizon_ts
  BEFORE INSERT OR UPDATE ON public.ct_flags
  FOR EACH ROW EXECUTE FUNCTION public._ct_flags_compute_horizon_ts();

CREATE TRIGGER ct_specialist_principles_touch_updated_at
  BEFORE UPDATE ON public.ct_specialist_principles
  FOR EACH ROW EXECUTE FUNCTION public._ct_flags_touch_updated_at();

-- ----------------------------------------------------------------------------
-- 9. Config seeds — scoring weights, thresholds, specialist params
-- ----------------------------------------------------------------------------
-- ct_config requires default_value NOT NULL; ON CONFLICT DO NOTHING keeps
-- re-runs idempotent.

INSERT INTO public.ct_config (key, value, description, category, default_value) VALUES
  ('score.opening_buy_ask_threshold', '0.60'::jsonb, 'Ask-side share for opening-buy intent full credit', 'scoring', '0.60'::jsonb),
  ('score.opening_buy_weight',        '25'::jsonb,   'Weight for opening-buy intent factor',             'scoring', '25'::jsonb),
  ('score.oi_confirm_weight',         '20'::jsonb,   'Weight for T+1 OI confirmation factor',            'scoring', '20'::jsonb),
  ('score.single_direction_weight',   '15'::jsonb,   'Weight for single-direction (not-spread) factor',  'scoring', '15'::jsonb),
  ('score.dte_band_lo',               '15'::jsonb,   'Lower DTE band for full credit',                   'scoring', '15'::jsonb),
  ('score.dte_band_hi',               '45'::jsonb,   'Upper DTE band for full credit',                   'scoring', '45'::jsonb),
  ('score.dte_weight',                '10'::jsonb,   'Weight for DTE-in-band factor',                    'scoring', '10'::jsonb),
  ('score.delta_lo',                  '20'::jsonb,   'Lower delta (abs) for in-band full credit',        'scoring', '20'::jsonb),
  ('score.delta_hi',                  '70'::jsonb,   'Upper delta (abs) for in-band full credit',        'scoring', '70'::jsonb),
  ('score.delta_weight',              '10'::jsonb,   'Weight for delta-in-band factor',                  'scoring', '10'::jsonb),
  ('score.iv_context_weight',         '10'::jsonb,   'Weight for IV-context factor',                     'scoring', '10'::jsonb),
  ('score.iv_rank_threshold',         '30'::jsonb,   'IV rank below this earns full IV-context credit',  'scoring', '30'::jsonb),
  ('score.size_vs_adv_weight',        '10'::jsonb,   'Weight for size-vs-ADV factor',                    'scoring', '10'::jsonb),
  ('penalty.hedge_max',               '30'::jsonb,   'Max penalty for hedge-signature detection',        'scoring', '30'::jsonb),
  ('penalty.earnings_max',            '20'::jsonb,   'Max penalty for earnings-within-5d',               'scoring', '20'::jsonb),
  ('penalty.expiration_max',          '15'::jsonb,   'Max penalty for expiration-week noise',            'scoring', '15'::jsonb),
  ('penalty.dealer_hedge_max',        '15'::jsonb,   'Max penalty for dealer-hedge signature',           'scoring', '15'::jsonb),
  ('score.slack_threshold',           '80'::jsonb,   'Score at/above which a flag becomes Slack-eligible','scoring','80'::jsonb),
  ('score.conviction_threshold',      '80'::jsonb,   'Score at/above which flag is a conviction flag',   'scoring', '80'::jsonb),
  ('score.flag_threshold',            '60'::jsonb,   'Score at/above which an entry becomes a flag',     'scoring', '60'::jsonb),
  ('specialist.wakeup_baseline_multiplier', '2.0'::jsonb, 'Flow must exceed ticker baseline by this factor to wake specialist', 'specialist', '2.0'::jsonb),
  ('specialist.cooldown_minutes',     '15'::jsonb,   'Min minutes between specialist wakeups per ticker','specialist', '15'::jsonb)
ON CONFLICT (key) DO NOTHING;
