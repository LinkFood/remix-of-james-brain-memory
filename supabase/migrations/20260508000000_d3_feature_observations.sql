-- D3 Feature-Isolation Experiment — output table
--
-- Status: WRITTEN 2026-05-08, NOT PUSHED. Migration file ships with the
-- scaffold; deploy only when feature_reconstruction.ts loaders are verified
-- and run_experiment.ts is ready for first pass.
--
-- Brief: scope/2026-05-08-d3-feature-isolation-experiment.md
--
-- One row per (ticker, wakeup_at, generation_id). Reruns get a new
-- generation_id so retroactive comparisons across reconstruction-logic
-- iterations are possible without destructive overwrites.

CREATE TABLE IF NOT EXISTS public.ct_d3_feature_observations (
  id              BIGSERIAL PRIMARY KEY,
  generation_id   TEXT NOT NULL,
  ticker          TEXT NOT NULL,
  wakeup_at       TIMESTAMPTZ NOT NULL,
  read_id         UUID NOT NULL,
  conviction      NUMERIC NOT NULL,
  cluster         TEXT NOT NULL CHECK (cluster IN ('low','mid','high')),

  -- F1 — flow_pulse.is_unusual (boolean)
  f1_flow_pulse_unusual          BOOLEAN,

  -- F2 — flow_heatmap front-week stack value (continuous, signed)
  f2_heatmap_front_week_value    NUMERIC,

  -- F3 — regime
  f3_regime                      TEXT
    CHECK (f3_regime IS NULL OR f3_regime IN ('positive_gamma','negative_gamma','neutral')),

  -- F4 — news count + max severity
  f4_news_count                  INTEGER NOT NULL DEFAULT 0,
  f4_news_max_severity           NUMERIC,

  -- F5 — event_recency present (72h prior)
  f5_event_recency_present       BOOLEAN NOT NULL DEFAULT FALSE,

  -- F6 — signature_alarms recent count (6h prior, score-race-filtered)
  f6_signature_alarm_count       INTEGER NOT NULL DEFAULT 0,

  -- F7 — has_0dte_today (deterministic)
  f7_has_0dte_today              BOOLEAN NOT NULL DEFAULT FALSE,

  -- F8 — last_flag_outcome (WIN/LOSS/EXPIRED_*/none)
  f8_last_flag_outcome           TEXT,

  -- Reconstruction metadata
  reconstructed_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reconstruction_error_flags     JSONB NOT NULL DEFAULT '{}'::jsonb,

  UNIQUE (generation_id, ticker, wakeup_at)
);

CREATE INDEX IF NOT EXISTS ct_d3_feature_observations_ticker_wakeup
  ON public.ct_d3_feature_observations (ticker, wakeup_at DESC);

CREATE INDEX IF NOT EXISTS ct_d3_feature_observations_generation
  ON public.ct_d3_feature_observations (generation_id);

CREATE INDEX IF NOT EXISTS ct_d3_feature_observations_cluster
  ON public.ct_d3_feature_observations (cluster);

COMMENT ON TABLE public.ct_d3_feature_observations IS
  'D3 feature-isolation experiment output. Per-wakeup F1-F8 reconstruction across the rolling 14-day window. See scope/2026-05-08-d3-feature-isolation-experiment.md.';

COMMENT ON COLUMN public.ct_d3_feature_observations.generation_id IS
  'Groups all rows from a single run (ISO timestamp tag). New generation_id per reconstruction-logic iteration so retroactive comparisons are non-destructive.';
