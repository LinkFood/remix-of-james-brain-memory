-- =============================================================================
-- 20260502040100_pulse_v2_schemas.sql
--
-- Pulse v2 — regime classification with embeddings, history, config-driven
-- thresholds. Additive on top of v1 (ct_flow_pulse_ticks, ct_pulse_events,
-- ct_pulse_timeline) — v1 stays untouched.
--
-- Architecture (per docs/decisions/2026-05-02-pulse-v2-design.md):
--
--   ct_regime_signals          — raw per-bucket signals per ticker (or
--                                market-wide via NULL ticker). UPSERT.
--   ct_regime_classifications  — derived classification per (ticker, bucket).
--                                UPSERT.
--   ct_regime_history          — append-only state evolution + embedded_state
--                                (vector 512) for analog search. INSERT only.
--   ct_regime_config           — classification rules. INSERT new row to
--                                add a regime label. Tenet 25.
--
-- Producer: edge function `ct-regime-capture` (NOT a postgres RPC — voyageEmbed
-- lives in TypeScript). Fired by pg_cron via net.http_post.
-- =============================================================================
SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 1. ct_regime_signals — raw signals per (ticker | NULL=market-wide) per bucket
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ct_regime_signals (
  ticker            text,                          -- NULL = market-wide row
  bucket_ts         timestamptz NOT NULL,          -- rounded to 5-min boundary
  momentum          numeric,                        -- net premium velocity
  breadth           numeric,                        -- +1 fraction of advancers
  trajectory        text CHECK (trajectory IN ('accelerating','steady','decaying')),
  dispersion        numeric,                        -- ticker spread vs market (NULL on per-ticker rows where N/A)
  duration_minutes  integer,                        -- minutes the current trajectory has held
  macro_proximity   jsonb NOT NULL DEFAULT '{}'::jsonb,
                                                    -- {fomc_days, cpi_days, jobs_days, earnings_clusters[]}
  last_updated      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ct_regime_signals_ticker_check
    CHECK (ticker IS NULL OR ticker = upper(ticker))
);

-- UNIQUE on (ticker, bucket_ts) — NULLS NOT DISTINCT so the market-wide row
-- is properly unique per bucket. Requires PG 15+.
CREATE UNIQUE INDEX IF NOT EXISTS ct_regime_signals_unique_pk
  ON public.ct_regime_signals (ticker, bucket_ts)
  NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS ct_regime_signals_bucket
  ON public.ct_regime_signals (bucket_ts DESC);
CREATE INDEX IF NOT EXISTS ct_regime_signals_ticker_bucket
  ON public.ct_regime_signals (ticker, bucket_ts DESC);

ALTER TABLE public.ct_regime_signals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ct_regime_signals_read ON public.ct_regime_signals;
CREATE POLICY ct_regime_signals_read ON public.ct_regime_signals
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS ct_regime_signals_svc ON public.ct_regime_signals;
CREATE POLICY ct_regime_signals_svc ON public.ct_regime_signals
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ct_regime_signals IS
  'Pulse v2 raw signals per (ticker | NULL=market-wide) per 5-min bucket. UPSERT semantics. Read by ct-regime-capture, surfaced via regimeContext brain organ.';
COMMENT ON COLUMN public.ct_regime_signals.ticker IS
  'NULL = market-wide row. Otherwise watchlist ticker (uppercase).';
COMMENT ON COLUMN public.ct_regime_signals.dispersion IS
  'Cross-ticker spread metric — only populated on market-wide rows in alpha. Per-ticker rows leave NULL until a per-ticker dispersion proxy is defined.';

-- ----------------------------------------------------------------------------
-- 2. ct_regime_classifications — derived per (ticker, bucket)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ct_regime_classifications (
  ticker             text,                         -- NULL = market-wide
  bucket_ts          timestamptz NOT NULL,
  classification     text NOT NULL,
  confidence         numeric NOT NULL CHECK (confidence >= 0 AND confidence <= 100),
  rationale          jsonb NOT NULL DEFAULT '{}'::jsonb,
                                                   -- {matched_rules: [...], signal_values: {...}}
  config_priority    integer,                      -- the priority of the rule that matched
  last_updated       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ct_regime_classifications_unique_pk
  ON public.ct_regime_classifications (ticker, bucket_ts)
  NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS ct_regime_classifications_bucket
  ON public.ct_regime_classifications (bucket_ts DESC);
CREATE INDEX IF NOT EXISTS ct_regime_classifications_ticker_bucket
  ON public.ct_regime_classifications (ticker, bucket_ts DESC);
CREATE INDEX IF NOT EXISTS ct_regime_classifications_classification_bucket
  ON public.ct_regime_classifications (classification, bucket_ts DESC);

ALTER TABLE public.ct_regime_classifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ct_regime_classif_read ON public.ct_regime_classifications;
CREATE POLICY ct_regime_classif_read ON public.ct_regime_classifications
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS ct_regime_classif_svc ON public.ct_regime_classifications;
CREATE POLICY ct_regime_classif_svc ON public.ct_regime_classifications
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ct_regime_classifications IS
  'Pulse v2 derived classification per (ticker, bucket). Writer joins ct_regime_signals against ct_regime_config to derive label. UPSERT.';

-- ----------------------------------------------------------------------------
-- 3. ct_regime_history — append-only state evolution + embedded_state
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ct_regime_history (
  id                 bigserial PRIMARY KEY,
  ticker             text,                         -- NULL = market-wide
  bucket_ts          timestamptz NOT NULL,
  momentum           numeric,
  breadth            numeric,
  trajectory         text,
  dispersion         numeric,
  duration_minutes   integer,
  macro_proximity    jsonb NOT NULL DEFAULT '{}'::jsonb,
  classification     text NOT NULL,
  confidence         numeric NOT NULL,
  rationale          jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedded_state     extensions.vector(512),       -- nullable on insert; populated by producer
  rich_text          text,                         -- the narrative input that was embedded
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ct_regime_history_bucket
  ON public.ct_regime_history (bucket_ts DESC);
CREATE INDEX IF NOT EXISTS ct_regime_history_ticker_bucket
  ON public.ct_regime_history (ticker, bucket_ts DESC);
CREATE INDEX IF NOT EXISTS ct_regime_history_classification_bucket
  ON public.ct_regime_history (classification, bucket_ts DESC);

-- HNSW on the 512-dim embedded_state. Cosine distance is the analog metric.
-- Lists/probes tuned for low row count at alpha; rebuild when N > 100k.
CREATE INDEX IF NOT EXISTS ct_regime_history_embedded_hnsw
  ON public.ct_regime_history
  USING hnsw (embedded_state extensions.vector_cosine_ops);

ALTER TABLE public.ct_regime_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ct_regime_history_read ON public.ct_regime_history;
CREATE POLICY ct_regime_history_read ON public.ct_regime_history
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS ct_regime_history_svc ON public.ct_regime_history;
CREATE POLICY ct_regime_history_svc ON public.ct_regime_history
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ct_regime_history IS
  'Pulse v2 append-only regime evolution. Each row carries the rich_text narrative + 512-dim embedded_state for cosine-analog search. Volume ~1.3k/day at alpha — partitioning deferred until N>5M (see decisions doc).';

-- ----------------------------------------------------------------------------
-- 4. ct_regime_config — classification rules (Tenet 25 — INSERT to add label)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ct_regime_config (
  classification_name  text PRIMARY KEY,
  signal_thresholds    jsonb NOT NULL,
       -- {momentum_min?, momentum_max?, breadth_min?, breadth_max?,
       --  trajectory_in?: [...], dispersion_max?, duration_min_minutes?,
       --  macro_proximity_any?: [fomc, cpi, jobs] (optional gating)}
  priority             integer NOT NULL,            -- higher wins on tie
  active               boolean NOT NULL DEFAULT true,
  description          text,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ct_regime_config_active_priority
  ON public.ct_regime_config (active, priority DESC);

ALTER TABLE public.ct_regime_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ct_regime_config_read ON public.ct_regime_config;
CREATE POLICY ct_regime_config_read ON public.ct_regime_config
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS ct_regime_config_svc ON public.ct_regime_config;
CREATE POLICY ct_regime_config_svc ON public.ct_regime_config
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ct_regime_config IS
  'Pulse v2 classification rules. Producer joins ct_regime_signals against active rows ORDER BY priority DESC, takes the first match. INSERT a row to add a new regime label — no code change (Tenet 25).';

-- ----------------------------------------------------------------------------
-- 5. Seed initial classification ruleset (alpha starter — expected to evolve)
-- ----------------------------------------------------------------------------
INSERT INTO public.ct_regime_config
  (classification_name, signal_thresholds, priority, active, description)
VALUES
  -- Pre-event regimes (highest priority — calendar dominates structural reads)
  ('pre_event_macro',
   '{"macro_proximity_any":["fomc","cpi","jobs"],"macro_proximity_max_days":2}'::jsonb,
   100, true,
   'FOMC/CPI/Jobs within 2 days. Override regime — calendar dominates flow reads.'),

  -- Strong directional regimes
  ('trending_up_strong',
   '{"momentum_min":1.0,"trajectory_in":["accelerating","steady"],"breadth_min":0.6}'::jsonb,
   80, true,
   'High momentum positive, broad participation. Ride mode.'),
  ('trending_down_strong',
   '{"momentum_max":-1.0,"trajectory_in":["accelerating","steady"],"breadth_max":0.4}'::jsonb,
   80, true,
   'High momentum negative, broad participation downside. Fade or hedge.'),

  -- Moderate directional regimes
  ('trending_up_steady',
   '{"momentum_min":0.3,"momentum_max":1.0,"trajectory_in":["steady"]}'::jsonb,
   60, true,
   'Moderate sustained positive momentum. Trend intact.'),
  ('trending_down_steady',
   '{"momentum_min":-1.0,"momentum_max":-0.3,"trajectory_in":["steady"]}'::jsonb,
   60, true,
   'Moderate sustained negative momentum.'),

  -- Transition regimes
  ('breaking_up',
   '{"momentum_min":0.2,"trajectory_in":["accelerating"],"duration_min_minutes":0,"duration_max_minutes":15}'::jsonb,
   70, true,
   'Momentum just flipped positive in last 15 min. New trend forming or fakeout.'),
  ('breaking_down',
   '{"momentum_max":-0.2,"trajectory_in":["accelerating"],"duration_min_minutes":0,"duration_max_minutes":15}'::jsonb,
   70, true,
   'Momentum just flipped negative in last 15 min.'),

  -- Chop regimes
  ('chop_low_dispersion',
   '{"momentum_min":-0.3,"momentum_max":0.3,"dispersion_max":0.2}'::jsonb,
   40, true,
   'Low momentum, tickers tracking each other. Consolidation.'),
  ('chop_high_dispersion',
   '{"momentum_min":-0.3,"momentum_max":0.3,"dispersion_min":0.4}'::jsonb,
   45, true,
   'Low net momentum but tickers diverging. Rotation regime.'),

  -- Decay
  ('decaying',
   '{"trajectory_in":["decaying"]}'::jsonb,
   30, true,
   'Trajectory decaying — prior trend losing energy.'),

  -- Fallback
  ('unknown',
   '{}'::jsonb,
   0, true,
   'Insufficient data or no rule matched. Default fallback.')
ON CONFLICT (classification_name) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 6. Register ct-regime-capture as a growth-cron (silent-failure invariant
--    will start watching as soon as the cron is scheduled).
-- ----------------------------------------------------------------------------
INSERT INTO public.ct_growth_crons
  (cron_jobname, target_table, freshness_column, scope, expected_window_minutes, description)
VALUES
  ('ct-regime-capture-rth',     'public.ct_regime_history', 'created_at', 'rth',     15,
    'Pulse v2 regime capture — RTH cadence */5 min. Writes one history row per (ticker, bucket).'),
  ('ct-regime-capture-offhours','public.ct_regime_history', 'created_at', 'weekday', 90,
    'Pulse v2 regime capture — off-hours hourly cadence (10-12, 21-22 UTC weekdays).')
ON CONFLICT (cron_jobname) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 7. Warden invariants (3) — seed alongside schemas per brief
-- ----------------------------------------------------------------------------

-- 7a. regime_state_freshness_rth — max(last_updated) within 10 min RTH, 60 off
INSERT INTO public.ct_invariants
  (name, category, description, query_sql, expected_min, expected_max, severity, enabled, runbook_path)
VALUES (
  'regime_state_freshness_rth',
  'data_freshness',
  'Pulse v2 regime classifications must be fresh — ≤15 min RTH, ≤90 min off-hours, weekend pass.',
  $sql$
    WITH last_run AS (
      SELECT MAX(last_updated) AS last_at FROM public.ct_regime_classifications
    ),
    clk AS (
      SELECT
        EXTRACT(DOW  FROM now() AT TIME ZONE 'UTC')::int AS dow,
        EXTRACT(HOUR FROM now() AT TIME ZONE 'UTC')::int AS hr
    ),
    rated AS (
      SELECT
        CASE
          WHEN last_at IS NULL THEN 0
          ELSE EXTRACT(EPOCH FROM (now() - last_at)) / 60
        END AS age_min,
        CASE
          WHEN clk.dow NOT BETWEEN 1 AND 5 THEN 'weekend'
          WHEN clk.hr BETWEEN 13 AND 20 THEN 'rth'
          ELSE 'offhours'
        END AS phase,
        last_at
      FROM last_run, clk
    )
    SELECT
      CASE
        WHEN phase = 'weekend' THEN 0
        ELSE age_min
      END::numeric AS metric_value,
      CASE
        WHEN last_at IS NULL THEN '[regime_state] no classifications yet — first cron fire pending'
        ELSE '[regime_state] last classification ' || ROUND(age_min)::text || ' min ago (' || phase || ')'
      END AS message
    FROM rated
  $sql$,
  0, 90, 'warn', true, 'docs/runbooks/pulse_v2.md'
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  query_sql = EXCLUDED.query_sql,
  expected_min = EXCLUDED.expected_min,
  expected_max = EXCLUDED.expected_max,
  severity = EXCLUDED.severity,
  enabled = EXCLUDED.enabled,
  runbook_path = EXCLUDED.runbook_path;

-- 7b. regime_history_growing — count grew last 24h on RTH days
INSERT INTO public.ct_invariants
  (name, category, description, query_sql, expected_min, severity, enabled, runbook_path)
VALUES (
  'regime_history_growing',
  'data_freshness',
  'ct_regime_history must grow on RTH weekdays (≥30 rows in last 24h). Catches frozen producer.',
  $sql$
    WITH clk AS (
      SELECT EXTRACT(DOW FROM now() AT TIME ZONE 'UTC')::int AS dow
    ),
    cnt AS (
      SELECT COUNT(*) AS c
      FROM public.ct_regime_history
      WHERE created_at > now() - interval '24 hours'
    )
    SELECT
      CASE
        WHEN clk.dow NOT BETWEEN 1 AND 5 THEN 999
        ELSE cnt.c
      END::numeric AS metric_value,
      '[regime_history] ' || cnt.c::text || ' rows last 24h' AS message
    FROM clk, cnt
  $sql$,
  30, 'warn', true, 'docs/runbooks/pulse_v2.md'
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  query_sql = EXCLUDED.query_sql,
  expected_min = EXCLUDED.expected_min,
  severity = EXCLUDED.severity,
  enabled = EXCLUDED.enabled,
  runbook_path = EXCLUDED.runbook_path;

-- 7c. regime_embedding_present — embedded_state non-null on writes from last 24h
INSERT INTO public.ct_invariants
  (name, category, description, query_sql, expected_min, severity, enabled, runbook_path)
VALUES (
  'regime_embedding_present',
  'data_quality',
  'Every ct_regime_history row in the last 24h must have a non-null embedded_state. NULL = Voyage call failed and producer wrote anyway.',
  $sql$
    WITH cnt AS (
      SELECT
        COUNT(*) FILTER (WHERE embedded_state IS NOT NULL) AS with_emb,
        COUNT(*)                                            AS total
      FROM public.ct_regime_history
      WHERE created_at > now() - interval '24 hours'
    )
    SELECT
      CASE
        WHEN total = 0 THEN 100
        ELSE (with_emb * 100.0 / total)
      END::numeric AS metric_value,
      '[regime_embedding] ' || with_emb::text || '/' || total::text || ' rows embedded in last 24h' AS message
    FROM cnt
  $sql$,
  95, 'warn', true, 'docs/runbooks/pulse_v2.md'
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  query_sql = EXCLUDED.query_sql,
  expected_min = EXCLUDED.expected_min,
  severity = EXCLUDED.severity,
  enabled = EXCLUDED.enabled,
  runbook_path = EXCLUDED.runbook_path;
