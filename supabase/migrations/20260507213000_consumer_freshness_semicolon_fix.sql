-- Hotfix for 20260507210000 — two invariants (tape_reader, watcher) had
-- semicolons in message string literals (' pass; last_write='). Warden's
-- "no mid-query semicolons" guard is naive (no string-literal awareness),
-- so any `;` anywhere in query_sql triggers an error regardless of context.
--
-- Cascade catalog instance candidate (sub-class of #35): warden-parser-
-- semicolon-blind. Authoring rule strengthens to: NO LITERAL semicolons
-- anywhere in query_sql, including inside dollar-quoted string content.
--
-- Replace `;` → ` —` in the affected message literals. Other 7 invariants
-- in the same migration didn't trip the rule (no semicolons in message
-- bodies). Status post-fix: 9 of 9 should engage on next warden tick.

SET search_path = public, extensions;

UPDATE public.ct_invariants
SET query_sql = $inv$WITH active AS (SELECT EXISTS(SELECT 1 FROM public.ct_brain_telemetry WHERE consumer_name='ct-tape-reader' AND created_at >= now() - interval '7 days') AS is_active), last_run AS (SELECT MAX(created_at) AS last_at FROM public.ct_brain_telemetry WHERE consumer_name='ct-tape-reader' AND created_at >= now() - interval '7 days'), clk AS (SELECT EXTRACT(DOW FROM now() AT TIME ZONE 'UTC')::int AS dow, EXTRACT(HOUR FROM now() AT TIME ZONE 'UTC')::int AS hr), phase AS (SELECT CASE WHEN clk.dow NOT BETWEEN 1 AND 5 THEN 'weekend' WHEN clk.hr BETWEEN 13 AND 20 THEN 'rth' WHEN clk.hr IN (10, 11, 12, 21, 22) THEN 'offhours_active' ELSE 'dead_of_night' END AS p FROM clk), age AS (SELECT CASE WHEN last_at IS NULL THEN 0 ELSE EXTRACT(EPOCH FROM (now() - last_at)) / 60 END AS age_min, last_at FROM last_run) SELECT CASE WHEN NOT active.is_active THEN 0 WHEN phase.p IN ('weekend','offhours_active','dead_of_night') THEN 0 WHEN age.age_min > 30 THEN age.age_min ELSE 0 END::numeric AS metric_value, CASE WHEN NOT active.is_active THEN '[ct-tape-reader] dormant — no rows in 7d (EXISTS-guard)' WHEN phase.p IN ('weekend','offhours_active','dead_of_night') THEN '[ct-tape-reader] phase=' || phase.p || ' pass — last_write=' || COALESCE(ROUND(age.age_min)::text || 'min ago', 'never') WHEN age.age_min > 30 THEN '[ct-tape-reader] STALE in rth — ' || ROUND(age.age_min)::text || 'min since last write (threshold 30min)' ELSE '[ct-tape-reader] fresh in rth — ' || ROUND(age.age_min)::text || 'min ago' END AS message FROM active, phase, age$inv$
WHERE name = 'consumer_freshness_tape_reader_24x7';

UPDATE public.ct_invariants
SET query_sql = $inv$WITH active AS (SELECT EXISTS(SELECT 1 FROM public.ct_brain_telemetry WHERE consumer_name='ct-watcher' AND created_at >= now() - interval '7 days') AS is_active), last_run AS (SELECT MAX(created_at) AS last_at FROM public.ct_brain_telemetry WHERE consumer_name='ct-watcher' AND created_at >= now() - interval '7 days'), clk AS (SELECT EXTRACT(DOW FROM now() AT TIME ZONE 'UTC')::int AS dow, EXTRACT(HOUR FROM now() AT TIME ZONE 'UTC')::int AS hr), phase AS (SELECT CASE WHEN clk.dow NOT BETWEEN 1 AND 5 THEN 'weekend' WHEN clk.hr BETWEEN 13 AND 20 THEN 'rth' WHEN clk.hr IN (10, 11, 12, 21, 22) THEN 'offhours_active' ELSE 'dead_of_night' END AS p FROM clk), age AS (SELECT CASE WHEN last_at IS NULL THEN 0 ELSE EXTRACT(EPOCH FROM (now() - last_at)) / 60 END AS age_min, last_at FROM last_run) SELECT CASE WHEN NOT active.is_active THEN 0 WHEN phase.p IN ('weekend','offhours_active','dead_of_night') THEN 0 WHEN age.age_min > 60 THEN age.age_min ELSE 0 END::numeric AS metric_value, CASE WHEN NOT active.is_active THEN '[ct-watcher] dormant — no rows in 7d' WHEN phase.p IN ('weekend','offhours_active','dead_of_night') THEN '[ct-watcher] phase=' || phase.p || ' pass — last_write=' || COALESCE(ROUND(age.age_min)::text || 'min ago', 'never') WHEN age.age_min > 60 THEN '[ct-watcher] STALE in rth — ' || ROUND(age.age_min)::text || 'min (threshold 60min)' ELSE '[ct-watcher] fresh in rth — ' || ROUND(age.age_min)::text || 'min ago' END AS message FROM active, phase, age$inv$
WHERE name = 'consumer_freshness_watcher_24x7';
