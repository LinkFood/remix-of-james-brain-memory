-- flow_alerts_freshness_rth: tighten WHERE scan window 1h → 15min.
-- Threshold is 8min, grace at open is 5min; 15min comfortably covers both
-- without scanning unneeded index range. 4x scan reduction kills the
-- intermittent statement-timeout class observed at :00/:30 contention
-- spikes (07:00 + 09:30 UTC on 2026-05-07).
--
-- Authoring per docs/runbooks/ct_invariants_sql_authoring.md.

UPDATE public.ct_invariants
SET query_sql = $inv$SELECT CASE WHEN extract(dow from now() AT TIME ZONE 'America/New_York') NOT IN (1,2,3,4,5) THEN 0 WHEN (now() AT TIME ZONE 'America/New_York')::time < '09:35' THEN 0 WHEN (now() AT TIME ZONE 'America/New_York')::time > '15:58' THEN 0 ELSE COALESCE(EXTRACT(EPOCH FROM (now() - MAX(ingested_at)))/60, 999) END::numeric AS metric_value, 'minutes since latest ct_flow_alerts row (RTH-only, 5min grace at open)' AS message FROM ct_flow_alerts WHERE ingested_at > now() - interval '15 minutes'$inv$
WHERE name = 'flow_alerts_freshness_rth';
