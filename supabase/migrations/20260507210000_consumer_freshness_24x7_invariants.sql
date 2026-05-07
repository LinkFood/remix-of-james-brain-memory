-- Class-kill C Phase B (rescoped) — 24/7 brain-consumer freshness coverage.
--
-- Phase A finding: brief's "23-40 invariants" estimate didn't survive
-- empirical state verification.
--   - 18 recurring brain consumers exist; B-4 covers 9 RTH-frequent ones
--   - 9 event-driven consumers (chat, debate, eod-*, lessons-curator,
--     playbook-curator, trade-advisories, trade-idea-generator) have
--     legitimate hours-to-days silence — freshness invariants would
--     generate noise, not signal
--   - 20 specialist consumers (10 base + 10 /peers) already have 4
--     invariants in specialist/specialists categories; specialist
--     freshness measurement-shape bug (instance #40) is queued
--     post-D2.2 5/14
--   - 4 named cron-consumers all already covered:
--     flow_alerts_freshness_rth, news_pipeline_freshness_rth,
--     morning_brief_freshness, eod_report_yesterday_landed
--
-- Real coverage gap = 9 invariants supplementing B-4 with 24/7 reach.
--
-- Empirical justification: today (2026-05-07) at ~10:00 UTC the
-- gateway-rewrite incident silently broke jac-morning-brief +
-- ct-daily-brief. B-4's RTH-only gate (UTC hr 14-19) couldn't see the
-- failure until 14:00 UTC — 4 hours after the missed fire. Tighter
-- offhours-active thresholds in this ship catch the ~25h-since-last-fire
-- boundary 2-4 hours earlier (~13:00-14:00 UTC).
--
-- Phase classifier mirrors regime_state_freshness_rth (Class B Phase B
-- fix at 20260510000000_class_b_dead_of_night_fix.sql). Four phases:
--   - weekend         (UTC dow not 1-5)
--   - rth             (UTC hr 13-20, weekday)
--   - offhours_active (UTC hr 10-12 or 21-22, weekday)
--   - dead_of_night   (everything else)
--
-- Per-consumer threshold profile reflects actual cron firing pattern
-- (RTH-only consumers pass during silence windows; daily-brief +
-- news-sweep are 24/7 with looser overnight thresholds).
--
-- EXISTS-guard pattern: each invariant returns metric_value=0 with a
-- dormant message until the consumer has any row in the last 7 days,
-- then the active check engages. A consumer dead for 8+ days is
-- already covered by brain_telemetry_consumer_coverage_24h.
--
-- Authoring per docs/runbooks/ct_invariants_sql_authoring.md (Path C):
-- single SELECT per query_sql, no inline comments, $inv$ dollar-quoted.
--
-- D2.2 contamination: zero. Pure passive monitoring; no producer
-- behavior change; no consumer code path touched; no specialist surface
-- modified.

SET search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. ct-tape-reader: RTH-only freshness (30min RTH, pass otherwise)
-- ---------------------------------------------------------------------------

INSERT INTO public.ct_invariants
  (name, category, description, query_sql, expected_min, expected_max, expected_bool, severity, runbook_path, enabled)
VALUES (
  'consumer_freshness_tape_reader_24x7',
  'consumer_freshness',
  'ct-tape-reader brain consumer freshness — 24/7 phase-classifier supplement to B-4 (which is RTH-gated). RTH ≤30min; weekend/offhours_active/dead_of_night = pass (tape-reader fires on RTH flow-alert waves only). Dormant until first row in 7d.',
  $inv$WITH active AS (SELECT EXISTS(SELECT 1 FROM public.ct_brain_telemetry WHERE consumer_name='ct-tape-reader' AND created_at >= now() - interval '7 days') AS is_active), last_run AS (SELECT MAX(created_at) AS last_at FROM public.ct_brain_telemetry WHERE consumer_name='ct-tape-reader' AND created_at >= now() - interval '7 days'), clk AS (SELECT EXTRACT(DOW FROM now() AT TIME ZONE 'UTC')::int AS dow, EXTRACT(HOUR FROM now() AT TIME ZONE 'UTC')::int AS hr), phase AS (SELECT CASE WHEN clk.dow NOT BETWEEN 1 AND 5 THEN 'weekend' WHEN clk.hr BETWEEN 13 AND 20 THEN 'rth' WHEN clk.hr IN (10, 11, 12, 21, 22) THEN 'offhours_active' ELSE 'dead_of_night' END AS p FROM clk), age AS (SELECT CASE WHEN last_at IS NULL THEN 0 ELSE EXTRACT(EPOCH FROM (now() - last_at)) / 60 END AS age_min, last_at FROM last_run) SELECT CASE WHEN NOT active.is_active THEN 0 WHEN phase.p IN ('weekend','offhours_active','dead_of_night') THEN 0 WHEN age.age_min > 30 THEN age.age_min ELSE 0 END::numeric AS metric_value, CASE WHEN NOT active.is_active THEN '[ct-tape-reader] dormant — no rows in 7d (EXISTS-guard)' WHEN phase.p IN ('weekend','offhours_active','dead_of_night') THEN '[ct-tape-reader] phase=' || phase.p || ' pass; last_write=' || COALESCE(ROUND(age.age_min)::text || 'min ago', 'never') WHEN age.age_min > 30 THEN '[ct-tape-reader] STALE in rth — ' || ROUND(age.age_min)::text || 'min since last write (threshold 30min)' ELSE '[ct-tape-reader] fresh in rth — ' || ROUND(age.age_min)::text || 'min ago' END AS message FROM active, phase, age$inv$,
  NULL, 0, NULL, 'warn',
  'docs/audit/2026-05-07-class-kill-c-phase-b-rescope.md', true
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description, query_sql = EXCLUDED.query_sql,
  expected_max = EXCLUDED.expected_max, severity = EXCLUDED.severity,
  enabled = EXCLUDED.enabled, runbook_path = EXCLUDED.runbook_path;

-- ---------------------------------------------------------------------------
-- 2. ct-watcher: RTH-only (60min RTH, pass otherwise)
-- ---------------------------------------------------------------------------

INSERT INTO public.ct_invariants
  (name, category, description, query_sql, expected_min, expected_max, expected_bool, severity, runbook_path, enabled)
VALUES (
  'consumer_freshness_watcher_24x7',
  'consumer_freshness',
  'ct-watcher brain consumer freshness — 24/7 phase-classifier supplement to B-4. RTH ≤60min; weekend/offhours_active/dead_of_night = pass.',
  $inv$WITH active AS (SELECT EXISTS(SELECT 1 FROM public.ct_brain_telemetry WHERE consumer_name='ct-watcher' AND created_at >= now() - interval '7 days') AS is_active), last_run AS (SELECT MAX(created_at) AS last_at FROM public.ct_brain_telemetry WHERE consumer_name='ct-watcher' AND created_at >= now() - interval '7 days'), clk AS (SELECT EXTRACT(DOW FROM now() AT TIME ZONE 'UTC')::int AS dow, EXTRACT(HOUR FROM now() AT TIME ZONE 'UTC')::int AS hr), phase AS (SELECT CASE WHEN clk.dow NOT BETWEEN 1 AND 5 THEN 'weekend' WHEN clk.hr BETWEEN 13 AND 20 THEN 'rth' WHEN clk.hr IN (10, 11, 12, 21, 22) THEN 'offhours_active' ELSE 'dead_of_night' END AS p FROM clk), age AS (SELECT CASE WHEN last_at IS NULL THEN 0 ELSE EXTRACT(EPOCH FROM (now() - last_at)) / 60 END AS age_min, last_at FROM last_run) SELECT CASE WHEN NOT active.is_active THEN 0 WHEN phase.p IN ('weekend','offhours_active','dead_of_night') THEN 0 WHEN age.age_min > 60 THEN age.age_min ELSE 0 END::numeric AS metric_value, CASE WHEN NOT active.is_active THEN '[ct-watcher] dormant — no rows in 7d' WHEN phase.p IN ('weekend','offhours_active','dead_of_night') THEN '[ct-watcher] phase=' || phase.p || ' pass; last_write=' || COALESCE(ROUND(age.age_min)::text || 'min ago', 'never') WHEN age.age_min > 60 THEN '[ct-watcher] STALE in rth — ' || ROUND(age.age_min)::text || 'min (threshold 60min)' ELSE '[ct-watcher] fresh in rth — ' || ROUND(age.age_min)::text || 'min ago' END AS message FROM active, phase, age$inv$,
  NULL, 0, NULL, 'warn',
  'docs/audit/2026-05-07-class-kill-c-phase-b-rescope.md', true
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description, query_sql = EXCLUDED.query_sql,
  expected_max = EXCLUDED.expected_max, severity = EXCLUDED.severity,
  enabled = EXCLUDED.enabled, runbook_path = EXCLUDED.runbook_path;

-- ---------------------------------------------------------------------------
-- 3. ct-curiosity: RTH-only (120min RTH, pass otherwise)
-- ---------------------------------------------------------------------------

INSERT INTO public.ct_invariants
  (name, category, description, query_sql, expected_min, expected_max, expected_bool, severity, runbook_path, enabled)
VALUES (
  'consumer_freshness_curiosity_24x7',
  'consumer_freshness',
  'ct-curiosity brain consumer freshness — 24/7 phase-classifier supplement to B-4. RTH ≤120min; weekend/offhours_active/dead_of_night = pass.',
  $inv$WITH active AS (SELECT EXISTS(SELECT 1 FROM public.ct_brain_telemetry WHERE consumer_name='ct-curiosity' AND created_at >= now() - interval '7 days') AS is_active), last_run AS (SELECT MAX(created_at) AS last_at FROM public.ct_brain_telemetry WHERE consumer_name='ct-curiosity' AND created_at >= now() - interval '7 days'), clk AS (SELECT EXTRACT(DOW FROM now() AT TIME ZONE 'UTC')::int AS dow, EXTRACT(HOUR FROM now() AT TIME ZONE 'UTC')::int AS hr), phase AS (SELECT CASE WHEN clk.dow NOT BETWEEN 1 AND 5 THEN 'weekend' WHEN clk.hr BETWEEN 13 AND 20 THEN 'rth' WHEN clk.hr IN (10, 11, 12, 21, 22) THEN 'offhours_active' ELSE 'dead_of_night' END AS p FROM clk), age AS (SELECT CASE WHEN last_at IS NULL THEN 0 ELSE EXTRACT(EPOCH FROM (now() - last_at)) / 60 END AS age_min, last_at FROM last_run) SELECT CASE WHEN NOT active.is_active THEN 0 WHEN phase.p IN ('weekend','offhours_active','dead_of_night') THEN 0 WHEN age.age_min > 120 THEN age.age_min ELSE 0 END::numeric AS metric_value, CASE WHEN NOT active.is_active THEN '[ct-curiosity] dormant — no rows in 7d' WHEN phase.p IN ('weekend','offhours_active','dead_of_night') THEN '[ct-curiosity] phase=' || phase.p || ' pass' WHEN age.age_min > 120 THEN '[ct-curiosity] STALE in rth — ' || ROUND(age.age_min)::text || 'min (threshold 120min)' ELSE '[ct-curiosity] fresh in rth — ' || ROUND(age.age_min)::text || 'min ago' END AS message FROM active, phase, age$inv$,
  NULL, 0, NULL, 'warn',
  'docs/audit/2026-05-07-class-kill-c-phase-b-rescope.md', true
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description, query_sql = EXCLUDED.query_sql,
  expected_max = EXCLUDED.expected_max, severity = EXCLUDED.severity,
  enabled = EXCLUDED.enabled, runbook_path = EXCLUDED.runbook_path;

-- ---------------------------------------------------------------------------
-- 4. ct-news-sweep: 24/7 (news doesn't sleep)
--    weekend 720min, dead_of_night 480min, offhours_active 120min, rth 120min
-- ---------------------------------------------------------------------------

INSERT INTO public.ct_invariants
  (name, category, description, query_sql, expected_min, expected_max, expected_bool, severity, runbook_path, enabled)
VALUES (
  'consumer_freshness_news_sweep_24x7',
  'consumer_freshness',
  'ct-news-sweep brain consumer freshness — 24/7 with looser overnight (news doesn''t sleep). weekend ≤720min / dead_of_night ≤480min / offhours_active ≤120min / rth ≤120min.',
  $inv$WITH active AS (SELECT EXISTS(SELECT 1 FROM public.ct_brain_telemetry WHERE consumer_name='ct-news-sweep' AND created_at >= now() - interval '7 days') AS is_active), last_run AS (SELECT MAX(created_at) AS last_at FROM public.ct_brain_telemetry WHERE consumer_name='ct-news-sweep' AND created_at >= now() - interval '7 days'), clk AS (SELECT EXTRACT(DOW FROM now() AT TIME ZONE 'UTC')::int AS dow, EXTRACT(HOUR FROM now() AT TIME ZONE 'UTC')::int AS hr), phase AS (SELECT CASE WHEN clk.dow NOT BETWEEN 1 AND 5 THEN 'weekend' WHEN clk.hr BETWEEN 13 AND 20 THEN 'rth' WHEN clk.hr IN (10, 11, 12, 21, 22) THEN 'offhours_active' ELSE 'dead_of_night' END AS p FROM clk), age AS (SELECT CASE WHEN last_at IS NULL THEN 0 ELSE EXTRACT(EPOCH FROM (now() - last_at)) / 60 END AS age_min, last_at FROM last_run), thresh AS (SELECT CASE phase.p WHEN 'weekend' THEN 720 WHEN 'dead_of_night' THEN 480 WHEN 'offhours_active' THEN 120 ELSE 120 END AS limit_min FROM phase) SELECT CASE WHEN NOT active.is_active THEN 0 WHEN age.age_min > thresh.limit_min THEN age.age_min ELSE 0 END::numeric AS metric_value, CASE WHEN NOT active.is_active THEN '[ct-news-sweep] dormant — no rows in 7d' WHEN age.age_min > thresh.limit_min THEN '[ct-news-sweep] STALE in ' || phase.p || ' — ' || ROUND(age.age_min)::text || 'min (threshold ' || thresh.limit_min || 'min)' ELSE '[ct-news-sweep] fresh in ' || phase.p || ' — ' || ROUND(age.age_min)::text || 'min ago' END AS message FROM active, phase, age, thresh$inv$,
  NULL, 0, NULL, 'warn',
  'docs/audit/2026-05-07-class-kill-c-phase-b-rescope.md', true
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description, query_sql = EXCLUDED.query_sql,
  expected_max = EXCLUDED.expected_max, severity = EXCLUDED.severity,
  enabled = EXCLUDED.enabled, runbook_path = EXCLUDED.runbook_path;

-- ---------------------------------------------------------------------------
-- 5. ct-hypothesis-health-check: RTH-only (60min RTH, pass otherwise)
-- ---------------------------------------------------------------------------

INSERT INTO public.ct_invariants
  (name, category, description, query_sql, expected_min, expected_max, expected_bool, severity, runbook_path, enabled)
VALUES (
  'consumer_freshness_hypothesis_health_check_24x7',
  'consumer_freshness',
  'ct-hypothesis-health-check brain consumer freshness — 24/7 phase-classifier supplement to B-4. RTH ≤60min; off otherwise.',
  $inv$WITH active AS (SELECT EXISTS(SELECT 1 FROM public.ct_brain_telemetry WHERE consumer_name='ct-hypothesis-health-check' AND created_at >= now() - interval '7 days') AS is_active), last_run AS (SELECT MAX(created_at) AS last_at FROM public.ct_brain_telemetry WHERE consumer_name='ct-hypothesis-health-check' AND created_at >= now() - interval '7 days'), clk AS (SELECT EXTRACT(DOW FROM now() AT TIME ZONE 'UTC')::int AS dow, EXTRACT(HOUR FROM now() AT TIME ZONE 'UTC')::int AS hr), phase AS (SELECT CASE WHEN clk.dow NOT BETWEEN 1 AND 5 THEN 'weekend' WHEN clk.hr BETWEEN 13 AND 20 THEN 'rth' WHEN clk.hr IN (10, 11, 12, 21, 22) THEN 'offhours_active' ELSE 'dead_of_night' END AS p FROM clk), age AS (SELECT CASE WHEN last_at IS NULL THEN 0 ELSE EXTRACT(EPOCH FROM (now() - last_at)) / 60 END AS age_min, last_at FROM last_run) SELECT CASE WHEN NOT active.is_active THEN 0 WHEN phase.p IN ('weekend','offhours_active','dead_of_night') THEN 0 WHEN age.age_min > 60 THEN age.age_min ELSE 0 END::numeric AS metric_value, CASE WHEN NOT active.is_active THEN '[ct-hypothesis-health-check] dormant — no rows in 7d' WHEN phase.p IN ('weekend','offhours_active','dead_of_night') THEN '[ct-hypothesis-health-check] phase=' || phase.p || ' pass' WHEN age.age_min > 60 THEN '[ct-hypothesis-health-check] STALE in rth — ' || ROUND(age.age_min)::text || 'min (threshold 60min)' ELSE '[ct-hypothesis-health-check] fresh in rth — ' || ROUND(age.age_min)::text || 'min ago' END AS message FROM active, phase, age$inv$,
  NULL, 0, NULL, 'warn',
  'docs/audit/2026-05-07-class-kill-c-phase-b-rescope.md', true
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description, query_sql = EXCLUDED.query_sql,
  expected_max = EXCLUDED.expected_max, severity = EXCLUDED.severity,
  enabled = EXCLUDED.enabled, runbook_path = EXCLUDED.runbook_path;

-- ---------------------------------------------------------------------------
-- 6. ct-hypothesis-proposer: RTH-only (120min RTH, pass otherwise)
-- ---------------------------------------------------------------------------

INSERT INTO public.ct_invariants
  (name, category, description, query_sql, expected_min, expected_max, expected_bool, severity, runbook_path, enabled)
VALUES (
  'consumer_freshness_hypothesis_proposer_24x7',
  'consumer_freshness',
  'ct-hypothesis-proposer brain consumer freshness — 24/7 phase-classifier supplement to B-4. RTH ≤120min; off otherwise.',
  $inv$WITH active AS (SELECT EXISTS(SELECT 1 FROM public.ct_brain_telemetry WHERE consumer_name='ct-hypothesis-proposer' AND created_at >= now() - interval '7 days') AS is_active), last_run AS (SELECT MAX(created_at) AS last_at FROM public.ct_brain_telemetry WHERE consumer_name='ct-hypothesis-proposer' AND created_at >= now() - interval '7 days'), clk AS (SELECT EXTRACT(DOW FROM now() AT TIME ZONE 'UTC')::int AS dow, EXTRACT(HOUR FROM now() AT TIME ZONE 'UTC')::int AS hr), phase AS (SELECT CASE WHEN clk.dow NOT BETWEEN 1 AND 5 THEN 'weekend' WHEN clk.hr BETWEEN 13 AND 20 THEN 'rth' WHEN clk.hr IN (10, 11, 12, 21, 22) THEN 'offhours_active' ELSE 'dead_of_night' END AS p FROM clk), age AS (SELECT CASE WHEN last_at IS NULL THEN 0 ELSE EXTRACT(EPOCH FROM (now() - last_at)) / 60 END AS age_min, last_at FROM last_run) SELECT CASE WHEN NOT active.is_active THEN 0 WHEN phase.p IN ('weekend','offhours_active','dead_of_night') THEN 0 WHEN age.age_min > 120 THEN age.age_min ELSE 0 END::numeric AS metric_value, CASE WHEN NOT active.is_active THEN '[ct-hypothesis-proposer] dormant — no rows in 7d' WHEN phase.p IN ('weekend','offhours_active','dead_of_night') THEN '[ct-hypothesis-proposer] phase=' || phase.p || ' pass' WHEN age.age_min > 120 THEN '[ct-hypothesis-proposer] STALE in rth — ' || ROUND(age.age_min)::text || 'min (threshold 120min)' ELSE '[ct-hypothesis-proposer] fresh in rth — ' || ROUND(age.age_min)::text || 'min ago' END AS message FROM active, phase, age$inv$,
  NULL, 0, NULL, 'warn',
  'docs/audit/2026-05-07-class-kill-c-phase-b-rescope.md', true
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description, query_sql = EXCLUDED.query_sql,
  expected_max = EXCLUDED.expected_max, severity = EXCLUDED.severity,
  enabled = EXCLUDED.enabled, runbook_path = EXCLUDED.runbook_path;

-- ---------------------------------------------------------------------------
-- 7. ct-alert-post-mortem: extends into offhours_active (240min both)
-- ---------------------------------------------------------------------------

INSERT INTO public.ct_invariants
  (name, category, description, query_sql, expected_min, expected_max, expected_bool, severity, runbook_path, enabled)
VALUES (
  'consumer_freshness_alert_post_mortem_24x7',
  'consumer_freshness',
  'ct-alert-post-mortem brain consumer freshness — extends into offhours_active (post-mortems lag RTH alerts). RTH ≤240min, offhours_active ≤240min, weekend/dead_of_night = pass.',
  $inv$WITH active AS (SELECT EXISTS(SELECT 1 FROM public.ct_brain_telemetry WHERE consumer_name='ct-alert-post-mortem' AND created_at >= now() - interval '7 days') AS is_active), last_run AS (SELECT MAX(created_at) AS last_at FROM public.ct_brain_telemetry WHERE consumer_name='ct-alert-post-mortem' AND created_at >= now() - interval '7 days'), clk AS (SELECT EXTRACT(DOW FROM now() AT TIME ZONE 'UTC')::int AS dow, EXTRACT(HOUR FROM now() AT TIME ZONE 'UTC')::int AS hr), phase AS (SELECT CASE WHEN clk.dow NOT BETWEEN 1 AND 5 THEN 'weekend' WHEN clk.hr BETWEEN 13 AND 20 THEN 'rth' WHEN clk.hr IN (10, 11, 12, 21, 22) THEN 'offhours_active' ELSE 'dead_of_night' END AS p FROM clk), age AS (SELECT CASE WHEN last_at IS NULL THEN 0 ELSE EXTRACT(EPOCH FROM (now() - last_at)) / 60 END AS age_min, last_at FROM last_run) SELECT CASE WHEN NOT active.is_active THEN 0 WHEN phase.p IN ('weekend','dead_of_night') THEN 0 WHEN age.age_min > 240 THEN age.age_min ELSE 0 END::numeric AS metric_value, CASE WHEN NOT active.is_active THEN '[ct-alert-post-mortem] dormant — no rows in 7d' WHEN phase.p IN ('weekend','dead_of_night') THEN '[ct-alert-post-mortem] phase=' || phase.p || ' pass' WHEN age.age_min > 240 THEN '[ct-alert-post-mortem] STALE in ' || phase.p || ' — ' || ROUND(age.age_min)::text || 'min (threshold 240min)' ELSE '[ct-alert-post-mortem] fresh in ' || phase.p || ' — ' || ROUND(age.age_min)::text || 'min ago' END AS message FROM active, phase, age$inv$,
  NULL, 0, NULL, 'warn',
  'docs/audit/2026-05-07-class-kill-c-phase-b-rescope.md', true
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description, query_sql = EXCLUDED.query_sql,
  expected_max = EXCLUDED.expected_max, severity = EXCLUDED.severity,
  enabled = EXCLUDED.enabled, runbook_path = EXCLUDED.runbook_path;

-- ---------------------------------------------------------------------------
-- 8. ct-self-grader: extends into offhours_active (240min both)
-- ---------------------------------------------------------------------------

INSERT INTO public.ct_invariants
  (name, category, description, query_sql, expected_min, expected_max, expected_bool, severity, runbook_path, enabled)
VALUES (
  'consumer_freshness_self_grader_24x7',
  'consumer_freshness',
  'ct-self-grader brain consumer freshness — extends into offhours_active (grading lags fires). RTH ≤240min, offhours_active ≤240min, weekend/dead_of_night = pass.',
  $inv$WITH active AS (SELECT EXISTS(SELECT 1 FROM public.ct_brain_telemetry WHERE consumer_name='ct-self-grader' AND created_at >= now() - interval '7 days') AS is_active), last_run AS (SELECT MAX(created_at) AS last_at FROM public.ct_brain_telemetry WHERE consumer_name='ct-self-grader' AND created_at >= now() - interval '7 days'), clk AS (SELECT EXTRACT(DOW FROM now() AT TIME ZONE 'UTC')::int AS dow, EXTRACT(HOUR FROM now() AT TIME ZONE 'UTC')::int AS hr), phase AS (SELECT CASE WHEN clk.dow NOT BETWEEN 1 AND 5 THEN 'weekend' WHEN clk.hr BETWEEN 13 AND 20 THEN 'rth' WHEN clk.hr IN (10, 11, 12, 21, 22) THEN 'offhours_active' ELSE 'dead_of_night' END AS p FROM clk), age AS (SELECT CASE WHEN last_at IS NULL THEN 0 ELSE EXTRACT(EPOCH FROM (now() - last_at)) / 60 END AS age_min, last_at FROM last_run) SELECT CASE WHEN NOT active.is_active THEN 0 WHEN phase.p IN ('weekend','dead_of_night') THEN 0 WHEN age.age_min > 240 THEN age.age_min ELSE 0 END::numeric AS metric_value, CASE WHEN NOT active.is_active THEN '[ct-self-grader] dormant — no rows in 7d' WHEN phase.p IN ('weekend','dead_of_night') THEN '[ct-self-grader] phase=' || phase.p || ' pass' WHEN age.age_min > 240 THEN '[ct-self-grader] STALE in ' || phase.p || ' — ' || ROUND(age.age_min)::text || 'min (threshold 240min)' ELSE '[ct-self-grader] fresh in ' || phase.p || ' — ' || ROUND(age.age_min)::text || 'min ago' END AS message FROM active, phase, age$inv$,
  NULL, 0, NULL, 'warn',
  'docs/audit/2026-05-07-class-kill-c-phase-b-rescope.md', true
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description, query_sql = EXCLUDED.query_sql,
  expected_max = EXCLUDED.expected_max, severity = EXCLUDED.severity,
  enabled = EXCLUDED.enabled, runbook_path = EXCLUDED.runbook_path;

-- ---------------------------------------------------------------------------
-- 9. ct-daily-brief: 24/7 daily fire (1500min active, 1560min weekend/dead)
--    13:00 UTC daily fire; 25h active threshold catches today's incident
--    at 14:00 UTC (1.5h after RTH gate would; B-4's 26h would catch at 15:00)
-- ---------------------------------------------------------------------------

INSERT INTO public.ct_invariants
  (name, category, description, query_sql, expected_min, expected_max, expected_bool, severity, runbook_path, enabled)
VALUES (
  'consumer_freshness_daily_brief_24x7',
  'consumer_freshness',
  'ct-daily-brief brain consumer freshness — 24/7 daily fire at 13:00 UTC. rth/offhours_active ≤1500min (25h), weekend/dead_of_night ≤1560min (26h). Catches gateway-rewrite-class incidents 2-4h earlier than B-4 RTH gate.',
  $inv$WITH active AS (SELECT EXISTS(SELECT 1 FROM public.ct_brain_telemetry WHERE consumer_name='ct-daily-brief' AND created_at >= now() - interval '7 days') AS is_active), last_run AS (SELECT MAX(created_at) AS last_at FROM public.ct_brain_telemetry WHERE consumer_name='ct-daily-brief' AND created_at >= now() - interval '7 days'), clk AS (SELECT EXTRACT(DOW FROM now() AT TIME ZONE 'UTC')::int AS dow, EXTRACT(HOUR FROM now() AT TIME ZONE 'UTC')::int AS hr), phase AS (SELECT CASE WHEN clk.dow NOT BETWEEN 1 AND 5 THEN 'weekend' WHEN clk.hr BETWEEN 13 AND 20 THEN 'rth' WHEN clk.hr IN (10, 11, 12, 21, 22) THEN 'offhours_active' ELSE 'dead_of_night' END AS p FROM clk), age AS (SELECT CASE WHEN last_at IS NULL THEN 0 ELSE EXTRACT(EPOCH FROM (now() - last_at)) / 60 END AS age_min, last_at FROM last_run), thresh AS (SELECT CASE phase.p WHEN 'rth' THEN 1500 WHEN 'offhours_active' THEN 1500 ELSE 1560 END AS limit_min FROM phase) SELECT CASE WHEN NOT active.is_active THEN 0 WHEN age.age_min > thresh.limit_min THEN age.age_min ELSE 0 END::numeric AS metric_value, CASE WHEN NOT active.is_active THEN '[ct-daily-brief] dormant — no rows in 7d' WHEN age.age_min > thresh.limit_min THEN '[ct-daily-brief] STALE in ' || phase.p || ' — ' || ROUND(age.age_min)::text || 'min (threshold ' || thresh.limit_min || 'min) — daily fire at 13:00 UTC may have failed' ELSE '[ct-daily-brief] fresh in ' || phase.p || ' — ' || ROUND(age.age_min)::text || 'min ago' END AS message FROM active, phase, age, thresh$inv$,
  NULL, 0, NULL, 'warn',
  'docs/audit/2026-05-07-class-kill-c-phase-b-rescope.md', true
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description, query_sql = EXCLUDED.query_sql,
  expected_max = EXCLUDED.expected_max, severity = EXCLUDED.severity,
  enabled = EXCLUDED.enabled, runbook_path = EXCLUDED.runbook_path;
