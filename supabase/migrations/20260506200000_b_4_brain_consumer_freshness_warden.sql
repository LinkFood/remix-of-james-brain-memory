-- =============================================================================
-- 20260506200000_b_4_brain_consumer_freshness_warden.sql
--
-- Class kill B-4 ship per Cowork brief 2026-05-06 (paired with B-3 Phase A
-- diagnose-only, separate PR). Adds warden invariant
-- brain_consumer_freshness_rth covering the RTH-frequent brain consumer
-- subset. Sibling shape to D2.2's specialist_per_ticker_freshness_rth ship
-- (2026-05-06T18:50Z) — same RTH-guarded freshness check, same per-target
-- threshold pattern, applied to a different consumer set.
--
-- Phase A audit (per Cowork brief Track 2): cross-referenced PR #42's
-- auto-discover output. 18 brain consumers import _shared/claudeReadSurface.
-- Of those, only 9 fired ≥1 row in the last 1h (RTH activity sample
-- 2026-05-06 19:10Z): tape-reader, watcher, curiosity, news-sweep,
-- hypothesis-health-check, hypothesis-proposer, alert-post-mortem,
-- self-grader, daily-brief.
--
-- Strategy: cover the 9 RTH-frequent consumers with per-consumer thresholds.
-- The 9 event-driven consumers (chat, debate-outcome-scorer, eod-report,
-- eod-summary, eod-specialist-narrative, lessons-curator, playbook-curator,
-- trade-advisories, trade-idea-generator) are NOT covered — they
-- legitimately go silent for hours-to-days between events.
--
-- Why this exists:
-- Class kill A (PR #33 deno check) catches build-time errors. B-1 (PR #39
-- failure propagation) catches deploy-time failures. B-2 (PR #42 auto-
-- discover) catches deploy-coverage gaps. B-3 (Phase A diagnose-only,
-- separate PR) probes runtime success at deploy time. B-4 (this) catches
-- runtime drift over time — if a brain consumer goes silent during RTH for
-- any reason post-deploy (env var divergence, downstream write fail, etc.),
-- this invariant fires within ~30-90 min (warden cadence + threshold).
-- Defense-in-depth backstop to B-3.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- Configurable default threshold (lifted to ct_config per Tenet 16). Per-
-- consumer overrides handled via the CASE inside the invariant SQL — could
-- also be lifted to ct_config.warden.brain_consumer_silence_threshold_hours
-- per-consumer rows in a future iteration if needed.
-- -----------------------------------------------------------------------------

INSERT INTO public.ct_config (key, value, description, category, min_value, max_value, default_value) VALUES
  ('warden.brain_consumer_silence_threshold_hours', '1.5'::jsonb,
    'Default hours since last brain-consumer write (any RTH-frequent consumer) before brain_consumer_freshness_rth invariant fires warn. Per-consumer overrides hardcoded in invariant SQL CASE for now (e.g., daily-brief 26h vs tape-reader 0.5h). RTH-only check — invariant returns 0 outside RTH (UTC weekday 14-19) to avoid weekend false-trip.',
    'warden', 0.25, 168, '1.5'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- -----------------------------------------------------------------------------
-- New invariant: brain_consumer_freshness_rth
--
-- Per-consumer freshness check during RTH. Active brain consumers must
-- write at least one row to ct_brain_telemetry every <threshold> hours
-- during RTH. Different consumers have different cadences (tape-reader
-- 10-min vs daily-brief once/day vs hypothesis-health-check periodic) —
-- per-consumer threshold encoded via CASE.
-- -----------------------------------------------------------------------------

INSERT INTO public.ct_invariants (name, category, description, query_sql, expected_min, expected_max, expected_bool, severity, runbook_path) VALUES
  ('brain_consumer_freshness_rth',
   'silent_failure',
   'RTH-frequent brain consumers (9 of 18 importers of _shared/claudeReadSurface.ts) must write to ct_brain_telemetry every <consumer-specific threshold> hours. Pair-ships with B-3 (post-deploy probe) to catch runtime drift over time. Per-consumer thresholds reflect actual cron cadence + sane buffer. Coverage: tape-reader, watcher, curiosity, news-sweep, hypothesis-health-check, hypothesis-proposer, alert-post-mortem, self-grader, daily-brief. NOT covered: event-driven consumers (chat, debate-outcome-scorer, eod-*, lessons-curator, playbook-curator, trade-advisories, trade-idea-generator) which legitimately go silent for hours-to-days.',
$$
WITH context AS (
  SELECT
    extract(isodow from now())::int AS utc_dow,
    extract(hour   from now())::int AS utc_hour
),
is_rth AS (
  SELECT
    (utc_dow BETWEEN 1 AND 5) AND (utc_hour BETWEEN 14 AND 19) AS rth
  FROM context
),
covered_consumers(consumer_name, threshold_hours) AS (
  VALUES
    ('ct-tape-reader',             0.5),    -- cron */10 RTH
    ('ct-watcher',                 1.0),    -- watch-driven, every-N-min RTH
    ('ct-curiosity',               2.0),    -- periodic; some gaps OK
    ('ct-news-sweep',              2.0),    -- periodic; gaps OK
    ('ct-hypothesis-health-check', 1.0),    -- frequent
    ('ct-hypothesis-proposer',     2.0),    -- periodic
    ('ct-alert-post-mortem',       4.0),    -- alert-driven; longer tolerance
    ('ct-self-grader',             4.0),    -- periodic
    ('ct-daily-brief',            26.0)     -- daily ~14 UTC; 26h covers 1 day + 2h slack
),
per_consumer_freshness AS (
  SELECT
    cc.consumer_name,
    cc.threshold_hours,
    MAX(t.created_at) AS last_write_at,
    EXTRACT(EPOCH FROM (now() - COALESCE(MAX(t.created_at), now() - interval '999 hours'))) / 3600.0 AS hours_since_last_write
  FROM covered_consumers cc
  LEFT JOIN public.ct_brain_telemetry t
    ON t.consumer_name = cc.consumer_name
   AND t.created_at >= now() - interval '7 days'
  GROUP BY cc.consumer_name, cc.threshold_hours
),
silent AS (
  SELECT consumer_name, hours_since_last_write, threshold_hours
  FROM per_consumer_freshness
  WHERE hours_since_last_write > threshold_hours
)
SELECT
  CASE WHEN (SELECT rth FROM is_rth)
    THEN (SELECT COUNT(*)::numeric FROM silent)
    ELSE 0::numeric
  END AS metric_value,
  CASE WHEN NOT (SELECT rth FROM is_rth) THEN 'off-RTH skip'
       WHEN (SELECT COUNT(*) FROM silent) = 0 THEN 'all RTH-frequent brain consumers fresh'
       ELSE 'silent_consumers: ' || (
         SELECT string_agg(consumer_name || '(' || ROUND(hours_since_last_write::numeric, 1) || 'h>' || threshold_hours || 'h)', ',' ORDER BY hours_since_last_write DESC)
         FROM silent
       )
  END AS message
$$,
   NULL,
   0,
   NULL,
   'warn',
   'docs/audit/2026-05-06-class-kill-b-post-deploy-probe-phase-a.md')
ON CONFLICT (name) DO UPDATE
  SET query_sql      = EXCLUDED.query_sql,
      description    = EXCLUDED.description,
      expected_min   = EXCLUDED.expected_min,
      expected_max   = EXCLUDED.expected_max,
      severity       = EXCLUDED.severity,
      runbook_path   = EXCLUDED.runbook_path,
      category       = EXCLUDED.category;
