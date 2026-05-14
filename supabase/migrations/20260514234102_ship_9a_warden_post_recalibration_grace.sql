-- =============================================================================
-- Ship 9a — fixup: add post-recalibration grace window to
-- alarm_tier_distribution_floor.
--
-- Issue caught on first warden tick post-deploy: invariant fires WARN
-- immediately ("GOLD never fired ... silver_last=2026-05-01") because the
-- pre-recalibration corpus could not reach the OLD 1.0/0.50/2.0 thresholds.
-- The recalibration just landed seconds ago; warning instantly before the
-- new thresholds can produce a fire is the perma-yellow trap that
-- feedback_warden_dormant_until_active_pattern.md exists to prevent.
--
-- Fix: dormant when ct_config.signature_alarm_gold_min_peak_pct was updated
-- within warden_tier_silver_dark_max_days. Anchors the grace window to the
-- actual recalibration timestamp (no hardcoded date — survives future
-- recalibrations idempotently). Once the new thresholds have had a full
-- silver-dark window to produce fires, the invariant engages normally.
-- =============================================================================

SET search_path = public, extensions;

UPDATE public.ct_invariants
SET
  description = 'Watches ct_flags rows tagged gold/silver from source=signature_alarm. Fires WARN if gold has not fired in warden_tier_gold_dark_max_days (default 90) OR silver has not fired in warden_tier_silver_dark_max_days (default 14). Dormant when corpus has <50 rows OR when the gold-peak-pct config was updated within the silver-dark window (post-recalibration grace).',
  query_sql = $sql$
    WITH cfg AS (
      SELECT
        COALESCE((SELECT ((value)::text)::numeric FROM public.ct_config WHERE key = 'warden_tier_gold_dark_max_days'), 90) AS gold_max_days,
        COALESCE((SELECT ((value)::text)::numeric FROM public.ct_config WHERE key = 'warden_tier_silver_dark_max_days'), 14) AS silver_max_days
    ),
    recal AS (
      SELECT
        updated_at AS last_recalibration_at,
        EXTRACT(EPOCH FROM (now() - updated_at)) / 86400.0 AS days_since_recalibration
      FROM public.ct_config
      WHERE key = 'signature_alarm_gold_min_peak_pct'
      LIMIT 1
    ),
    corpus AS (
      SELECT COUNT(*) AS n_rows
      FROM public.ct_signature_alarm_log
    ),
    last_fires AS (
      SELECT
        MAX(CASE WHEN 'gold'   = ANY(tags) THEN created_at END) AS last_gold,
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
        corpus.n_rows,
        recal.days_since_recalibration
      FROM cfg, last_fires, corpus, recal
    )
    SELECT
      CASE
        WHEN n_rows < 50 THEN 0::numeric
        WHEN days_since_recalibration IS NOT NULL AND days_since_recalibration < silver_max_days THEN 0::numeric
        WHEN last_gold IS NULL OR gold_dark_days > gold_max_days THEN 1::numeric
        WHEN last_silver IS NULL OR silver_dark_days > silver_max_days THEN 1::numeric
        ELSE 0::numeric
      END AS metric_value,
      CASE
        WHEN n_rows < 50
          THEN 'dormant — ct_signature_alarm_log has ' || n_rows::text || ' rows (need 50 for floor check)'
        WHEN days_since_recalibration IS NOT NULL AND days_since_recalibration < silver_max_days
          THEN 'dormant — post-recalibration grace (' || round(days_since_recalibration, 1)::text
            || 'd of ' || silver_max_days::text || 'd silver-dark window since gold-peak-pct config change)'
        WHEN last_gold IS NULL
          THEN 'GOLD never fired post-recalibration — corpus ' || n_rows::text
            || ' rows | silver_last=' || COALESCE(last_silver::text, 'never')
        WHEN gold_dark_days > gold_max_days
          THEN 'GOLD dark for ' || round(gold_dark_days, 1)::text || ' days (max ' || gold_max_days::text || ') — recalibrate'
        WHEN last_silver IS NULL
          THEN 'SILVER never fired post-recalibration — corpus ' || n_rows::text || ' rows'
        WHEN silver_dark_days > silver_max_days
          THEN 'SILVER dark for ' || round(silver_dark_days, 1)::text || ' days (max ' || silver_max_days::text || ') — recalibrate'
        ELSE 'healthy — gold_dark=' || round(gold_dark_days, 1)::text || 'd | silver_dark=' || round(silver_dark_days, 1)::text || 'd'
      END AS message
    FROM drift
  $sql$,
  updated_at = now()
WHERE name = 'alarm_tier_distribution_floor';
