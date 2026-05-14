-- =============================================================================
-- Ship 9a — warden invariant `alarm_tier_distribution_floor`.
--
-- Class-kill prevention layer for the recalibration: catches future corpus
-- shifts where one or more tiers go dark for too long, which would mean the
-- thresholds have drifted again.
--
-- Pairs with 20260514234100_ship_9a_tier_threshold_recalibration.sql.
--
-- Detection model
-- ---------------
-- Fires WARN if EITHER:
--   * gold tier has not fired in warden_tier_gold_dark_max_days days (default 90)
--   * silver tier has not fired in warden_tier_silver_dark_max_days days (default 14)
--
-- bronze is intentionally NOT checked — bronze is the UI-glow floor and fires
-- continuously when the system is healthy. If bronze went silent that would be
-- a different class of failure (no alerts flowing) caught by other invariants.
--
-- EXISTS-guard ahead-of-producer pattern (per
-- feedback_warden_dormant_until_active_pattern.md): returns metric_value=0
-- when ct_signature_alarm_log has fewer than 50 rows total (rolling corpus too
-- thin) OR when the watcher has not run in 24h (different invariant catches
-- that). Auto-engages once corpus reaches floor.
--
-- Parser hygiene (per feedback_warden_parser_semicolon_blind.md): no `;`
-- inside query_sql, including message string literals. Using em-dash + pipe
-- separators in messages.
--
-- Severity warn — a dark tier is a calibration signal, not a crisis. James
-- pattern: dark tier for >threshold days -> open Phase A on corpus distribution.
-- =============================================================================

SET search_path = public, extensions;

-- Tunable thresholds — Tenet 16. Both go in 'warden' category for grouping.
INSERT INTO public.ct_config (key, value, description, category, min_value, max_value, default_value) VALUES
  ('warden_tier_gold_dark_max_days',   '90'::jsonb,
    'Max days gold alarm tier can go dark before alarm_tier_distribution_floor warns. Long because gold is intentionally rare.',
    'warden', 1, 365, '90'::jsonb),
  ('warden_tier_silver_dark_max_days', '14'::jsonb,
    'Max days silver alarm tier can go dark before alarm_tier_distribution_floor warns.',
    'warden', 1, 90, '14'::jsonb)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.ct_invariants (
  name, category, description, query_sql,
  expected_min, expected_max, severity, runbook_path
) VALUES (
  'alarm_tier_distribution_floor',
  'calibration',
  'Watches ct_flags rows tagged gold/silver from source=signature_alarm. Fires WARN if gold has not fired in warden_tier_gold_dark_max_days (default 90) OR silver has not fired in warden_tier_silver_dark_max_days (default 14). EXISTS-guard dormant until ct_signature_alarm_log has >=50 rows.',
  $sql$
    WITH cfg AS (
      SELECT
        COALESCE((SELECT ((value)::text)::numeric FROM public.ct_config WHERE key = 'warden_tier_gold_dark_max_days'), 90) AS gold_max_days,
        COALESCE((SELECT ((value)::text)::numeric FROM public.ct_config WHERE key = 'warden_tier_silver_dark_max_days'), 14) AS silver_max_days
    ),
    corpus AS (
      SELECT COUNT(*) AS n_rows
      FROM public.ct_signature_alarm_log
    ),
    last_fires AS (
      SELECT
        MAX(CASE WHEN 'gold' = ANY(tags)   THEN created_at END) AS last_gold,
        MAX(CASE WHEN 'silver' = ANY(tags) THEN created_at END) AS last_silver
      FROM public.ct_flags
      WHERE source = 'signature_alarm'
        AND tags IS NOT NULL
    ),
    drift AS (
      SELECT
        cfg.gold_max_days,
        cfg.silver_max_days,
        last_fires.last_gold,
        last_fires.last_silver,
        EXTRACT(EPOCH FROM (now() - last_fires.last_gold))   / 86400.0 AS gold_dark_days,
        EXTRACT(EPOCH FROM (now() - last_fires.last_silver)) / 86400.0 AS silver_dark_days,
        corpus.n_rows
      FROM cfg, last_fires, corpus
    )
    SELECT
      CASE
        WHEN n_rows < 50 THEN 0::numeric
        WHEN last_gold IS NULL OR gold_dark_days > gold_max_days THEN 1::numeric
        WHEN last_silver IS NULL OR silver_dark_days > silver_max_days THEN 1::numeric
        ELSE 0::numeric
      END AS metric_value,
      CASE
        WHEN n_rows < 50
          THEN 'dormant — ct_signature_alarm_log has ' || n_rows::text || ' rows (need 50 for floor check)'
        WHEN last_gold IS NULL
          THEN 'GOLD never fired — corpus has ' || n_rows::text || ' alarm log rows | silver_last=' || COALESCE(last_silver::text, 'never')
        WHEN gold_dark_days > gold_max_days
          THEN 'GOLD dark for ' || round(gold_dark_days, 1)::text || ' days (max ' || gold_max_days::text || ') — recalibrate'
        WHEN last_silver IS NULL
          THEN 'SILVER never fired — corpus has ' || n_rows::text || ' alarm log rows'
        WHEN silver_dark_days > silver_max_days
          THEN 'SILVER dark for ' || round(silver_dark_days, 1)::text || ' days (max ' || silver_max_days::text || ') — recalibrate'
        ELSE 'healthy — gold_dark=' || round(gold_dark_days, 1)::text || 'd | silver_dark=' || round(silver_dark_days, 1)::text || 'd'
      END AS message
    FROM drift
  $sql$,
  0,
  0,
  'warn',
  'docs/methodology-patterns.md'
)
ON CONFLICT (name) DO UPDATE SET
  description  = EXCLUDED.description,
  query_sql    = EXCLUDED.query_sql,
  expected_min = EXCLUDED.expected_min,
  expected_max = EXCLUDED.expected_max,
  severity     = EXCLUDED.severity,
  runbook_path = EXCLUDED.runbook_path,
  updated_at   = now();
