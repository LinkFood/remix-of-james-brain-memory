-- Warden invariants for the Flow Butterfly Rank 1 ship.
--
-- Per PR #64 design pass § C.5. EXISTS-guard pattern (per
-- feedback_warden_dormant_until_active_pattern.md): each invariant returns
-- metric_value=0 (passing) until the producer it watches has fired at
-- least once in the relevant window. Auto-engages on first real signal
-- so we don't carry yellow during ramp-up.
--
-- Authoring per docs/runbooks/ct_invariants_sql_authoring.md (PR #55):
--   single SELECT, no inline comments, terminal semicolon only.

INSERT INTO public.ct_invariants
  (name, category, description, query_sql, expected_min, expected_max, expected_bool, severity, runbook_path)
VALUES
  ('butterfly_cross_events_today_rth',
   'flow_butterfly',
   'At least 5 butterfly cross events should land in ct_butterfly_cross_events between RTH open and now on a trading day. Dormant on weekends, pre-bell, and during initial detector ramp-up (EXISTS guard).',
   $inv$WITH active AS (SELECT EXISTS(SELECT 1 FROM public.ct_butterfly_cross_events WHERE detected_at >= now() - interval '24 hours') AS is_active), today_count AS (SELECT COUNT(*) AS n FROM public.ct_butterfly_cross_events WHERE session_date = (now() AT TIME ZONE 'America/New_York')::date AND extract(dow FROM now() AT TIME ZONE 'America/New_York') BETWEEN 1 AND 5 AND extract(hour FROM now() AT TIME ZONE 'UTC') >= 14 AND extract(hour FROM now() AT TIME ZONE 'UTC') < 21) SELECT CASE WHEN active.is_active AND extract(dow FROM now() AT TIME ZONE 'America/New_York') BETWEEN 1 AND 5 AND extract(hour FROM now() AT TIME ZONE 'UTC') >= 15 AND extract(hour FROM now() AT TIME ZONE 'UTC') < 21 THEN today_count.n::numeric ELSE 5::numeric END AS metric_value, CASE WHEN NOT active.is_active THEN 'butterfly detector not yet active (EXISTS guard)' WHEN today_count.n >= 5 THEN today_count.n || ' butterfly cross events today RTH' ELSE 'LOW DETECTION: only ' || today_count.n || ' butterfly cross events today RTH (expected ≥5)' END AS message FROM active, today_count$inv$,
   5, NULL, NULL, 'warn', 'docs/audits/flow-butterfly-empirical-design-pass.md'),

  ('butterfly_grader_intraday_lag',
   'flow_butterfly',
   'Cross events older than 4 hours during RTH should have intraday windows graded. Dormant until grader has fired at least once (EXISTS guard).',
   $inv$WITH active AS (SELECT EXISTS(SELECT 1 FROM public.ct_butterfly_cross_events WHERE graded_at IS NOT NULL AND graded_at >= now() - interval '7 days') AS is_active), ungraded AS (SELECT COUNT(*) AS n FROM public.ct_butterfly_cross_events WHERE graded_at IS NULL AND cross_at < now() - interval '4 hours' AND cross_at >= now() - interval '24 hours') SELECT CASE WHEN active.is_active THEN ungraded.n::numeric ELSE 0::numeric END AS metric_value, CASE WHEN NOT active.is_active THEN 'butterfly grader not yet active (EXISTS guard)' WHEN ungraded.n = 0 THEN 'all settled cross events graded for intraday' ELSE 'GRADER LAG: ' || ungraded.n || ' cross events older than 4h still ungraded' END AS message FROM active, ungraded$inv$,
   NULL, 5, NULL, 'warn', 'docs/audits/flow-butterfly-empirical-design-pass.md'),

  ('butterfly_nextclose_grade_lag',
   'flow_butterfly',
   'Cross events from prior trading day should have NextClose graded by now. Dormant until grader has fired at least once.',
   $inv$WITH active AS (SELECT EXISTS(SELECT 1 FROM public.ct_butterfly_cross_events WHERE hit_nextclose IS NOT NULL AND graded_at >= now() - interval '7 days') AS is_active), ungraded AS (SELECT COUNT(*) AS n FROM public.ct_butterfly_cross_events WHERE hit_nextclose IS NULL AND graded_at IS NOT NULL AND cross_at < now() - interval '36 hours' AND cross_at >= now() - interval '5 days') SELECT CASE WHEN active.is_active THEN ungraded.n::numeric ELSE 0::numeric END AS metric_value, CASE WHEN NOT active.is_active THEN 'butterfly nextclose grader not yet active (EXISTS guard)' WHEN ungraded.n = 0 THEN 'all eligible cross events have NextClose grade' ELSE 'NEXTCLOSE GRADER LAG: ' || ungraded.n || ' events older than 36h missing NextClose' END AS message FROM active, ungraded$inv$,
   NULL, 5, NULL, 'warn', 'docs/audits/flow-butterfly-empirical-design-pass.md'),

  ('butterfly_rpc_responsive',
   'flow_butterfly',
   'ct_net_premium_expiry_split RPC should return at least one row when called with SPY and a recent window during RTH. Dormant outside RTH.',
   $inv$SELECT CASE WHEN extract(dow FROM now() AT TIME ZONE 'America/New_York') BETWEEN 1 AND 5 AND extract(hour FROM now() AT TIME ZONE 'UTC') >= 14 AND extract(hour FROM now() AT TIME ZONE 'UTC') < 21 THEN (SELECT COUNT(*) FROM public.ct_net_premium_expiry_split('SPY', (now() - interval '15 minutes')::timestamptz))::numeric ELSE 1::numeric END AS metric_value, CASE WHEN extract(dow FROM now() AT TIME ZONE 'America/New_York') NOT BETWEEN 1 AND 5 OR extract(hour FROM now() AT TIME ZONE 'UTC') < 14 OR extract(hour FROM now() AT TIME ZONE 'UTC') >= 21 THEN 'outside RTH window — invariant dormant' WHEN (SELECT COUNT(*) FROM public.ct_net_premium_expiry_split('SPY', (now() - interval '15 minutes')::timestamptz)) > 0 THEN 'RPC returning rows for SPY trailing 15min' ELSE 'CRITICAL: ct_net_premium_expiry_split returning zero rows for SPY trailing 15min during RTH' END AS message$inv$,
   1, NULL, NULL, 'critical', 'docs/audits/flow-butterfly-empirical-design-pass.md');
