-- Bundle Phase 2 pair-ship: 10 metadata-completeness warden invariants,
-- one per organ in the Phase 2 progress table. Active for organs that have
-- shipped producer writes (news_causality, flow_heatmap, pulse); auto-engage
-- for the remaining 7 the moment their producer ships.
--
-- Each invariant fires only when the organ has produced at least one row with
-- organ_status set in the last 24h (the EXISTS guard). Until that signal,
-- metric_value=0 (passing). This is the structural defense net's 6th layer
-- for organ-metadata integrity.
--
-- Authoring per docs/runbooks/ct_invariants_sql_authoring.md (PR #55):
--   single SELECT, no inline comments, terminal semicolon only.

INSERT INTO public.ct_invariants
  (name, category, description, query_sql, expected_min, expected_max, expected_bool, severity, runbook_path)
VALUES
  ('organ_metadata_completeness_news_causality',
   'organ_metadata',
   'Bundle Phase 2 metadata-completeness check for news_causality. Fails when any successful telemetry row in the last 1h is missing organ_status, given the organ has produced at least one populated row in the last 24h. Active since 2026-05-07 producer ship.',
   $inv$WITH active AS (SELECT EXISTS(SELECT 1 FROM public.ct_brain_telemetry WHERE helper_name = 'news_causality' AND organ_status IS NOT NULL AND created_at >= now() - interval '24 hours') AS is_active), nulls AS (SELECT COUNT(*) AS n FROM public.ct_brain_telemetry WHERE helper_name = 'news_causality' AND organ_status IS NULL AND error IS NULL AND created_at >= now() - interval '1 hour') SELECT CASE WHEN active.is_active THEN nulls.n::numeric ELSE 0::numeric END AS metric_value, CASE WHEN NOT active.is_active THEN 'organ news_causality not yet Phase 2 metadata-active (no organ_status writes in 24h)' WHEN nulls.n = 0 THEN 'all news_causality rows in last 1h have organ_status populated' ELSE 'METADATA LEAK: ' || nulls.n || ' news_causality rows missing organ_status in last 1h' END AS message FROM active, nulls$inv$,
   NULL, 0, NULL, 'warn', 'docs/system-map/organ-metadata-schema.md'),

  ('organ_metadata_completeness_flow_heatmap',
   'organ_metadata',
   'Bundle Phase 2 metadata-completeness check for flow_heatmap. Active since 2026-05-08 producer ship.',
   $inv$WITH active AS (SELECT EXISTS(SELECT 1 FROM public.ct_brain_telemetry WHERE helper_name = 'flow_heatmap' AND organ_status IS NOT NULL AND created_at >= now() - interval '24 hours') AS is_active), nulls AS (SELECT COUNT(*) AS n FROM public.ct_brain_telemetry WHERE helper_name = 'flow_heatmap' AND organ_status IS NULL AND error IS NULL AND created_at >= now() - interval '1 hour') SELECT CASE WHEN active.is_active THEN nulls.n::numeric ELSE 0::numeric END AS metric_value, CASE WHEN NOT active.is_active THEN 'organ flow_heatmap not yet Phase 2 metadata-active (no organ_status writes in 24h)' WHEN nulls.n = 0 THEN 'all flow_heatmap rows in last 1h have organ_status populated' ELSE 'METADATA LEAK: ' || nulls.n || ' flow_heatmap rows missing organ_status in last 1h' END AS message FROM active, nulls$inv$,
   NULL, 0, NULL, 'warn', 'docs/system-map/organ-metadata-schema.md'),

  ('organ_metadata_completeness_pulse',
   'organ_metadata',
   'Bundle Phase 2 metadata-completeness check for pulse. Active since 2026-05-09 producer ship.',
   $inv$WITH active AS (SELECT EXISTS(SELECT 1 FROM public.ct_brain_telemetry WHERE helper_name = 'pulse' AND organ_status IS NOT NULL AND created_at >= now() - interval '24 hours') AS is_active), nulls AS (SELECT COUNT(*) AS n FROM public.ct_brain_telemetry WHERE helper_name = 'pulse' AND organ_status IS NULL AND error IS NULL AND created_at >= now() - interval '1 hour') SELECT CASE WHEN active.is_active THEN nulls.n::numeric ELSE 0::numeric END AS metric_value, CASE WHEN NOT active.is_active THEN 'organ pulse not yet Phase 2 metadata-active (no organ_status writes in 24h)' WHEN nulls.n = 0 THEN 'all pulse rows in last 1h have organ_status populated' ELSE 'METADATA LEAK: ' || nulls.n || ' pulse rows missing organ_status in last 1h' END AS message FROM active, nulls$inv$,
   NULL, 0, NULL, 'warn', 'docs/system-map/organ-metadata-schema.md'),

  ('organ_metadata_completeness_specialist',
   'organ_metadata',
   'Bundle Phase 2 metadata-completeness check for specialist. Dormant until producer ship engages the EXISTS guard.',
   $inv$WITH active AS (SELECT EXISTS(SELECT 1 FROM public.ct_brain_telemetry WHERE helper_name = 'specialist' AND organ_status IS NOT NULL AND created_at >= now() - interval '24 hours') AS is_active), nulls AS (SELECT COUNT(*) AS n FROM public.ct_brain_telemetry WHERE helper_name = 'specialist' AND organ_status IS NULL AND error IS NULL AND created_at >= now() - interval '1 hour') SELECT CASE WHEN active.is_active THEN nulls.n::numeric ELSE 0::numeric END AS metric_value, CASE WHEN NOT active.is_active THEN 'organ specialist not yet Phase 2 metadata-active (no organ_status writes in 24h)' WHEN nulls.n = 0 THEN 'all specialist rows in last 1h have organ_status populated' ELSE 'METADATA LEAK: ' || nulls.n || ' specialist rows missing organ_status in last 1h' END AS message FROM active, nulls$inv$,
   NULL, 0, NULL, 'warn', 'docs/system-map/organ-metadata-schema.md'),

  ('organ_metadata_completeness_detector',
   'organ_metadata',
   'Bundle Phase 2 metadata-completeness check for detector. Dormant until producer ship engages the EXISTS guard.',
   $inv$WITH active AS (SELECT EXISTS(SELECT 1 FROM public.ct_brain_telemetry WHERE helper_name = 'detector' AND organ_status IS NOT NULL AND created_at >= now() - interval '24 hours') AS is_active), nulls AS (SELECT COUNT(*) AS n FROM public.ct_brain_telemetry WHERE helper_name = 'detector' AND organ_status IS NULL AND error IS NULL AND created_at >= now() - interval '1 hour') SELECT CASE WHEN active.is_active THEN nulls.n::numeric ELSE 0::numeric END AS metric_value, CASE WHEN NOT active.is_active THEN 'organ detector not yet Phase 2 metadata-active (no organ_status writes in 24h)' WHEN nulls.n = 0 THEN 'all detector rows in last 1h have organ_status populated' ELSE 'METADATA LEAK: ' || nulls.n || ' detector rows missing organ_status in last 1h' END AS message FROM active, nulls$inv$,
   NULL, 0, NULL, 'warn', 'docs/system-map/organ-metadata-schema.md'),

  ('organ_metadata_completeness_tape',
   'organ_metadata',
   'Bundle Phase 2 metadata-completeness check for tape. Dormant until producer ship engages the EXISTS guard.',
   $inv$WITH active AS (SELECT EXISTS(SELECT 1 FROM public.ct_brain_telemetry WHERE helper_name = 'tape' AND organ_status IS NOT NULL AND created_at >= now() - interval '24 hours') AS is_active), nulls AS (SELECT COUNT(*) AS n FROM public.ct_brain_telemetry WHERE helper_name = 'tape' AND organ_status IS NULL AND error IS NULL AND created_at >= now() - interval '1 hour') SELECT CASE WHEN active.is_active THEN nulls.n::numeric ELSE 0::numeric END AS metric_value, CASE WHEN NOT active.is_active THEN 'organ tape not yet Phase 2 metadata-active (no organ_status writes in 24h)' WHEN nulls.n = 0 THEN 'all tape rows in last 1h have organ_status populated' ELSE 'METADATA LEAK: ' || nulls.n || ' tape rows missing organ_status in last 1h' END AS message FROM active, nulls$inv$,
   NULL, 0, NULL, 'warn', 'docs/system-map/organ-metadata-schema.md'),

  ('organ_metadata_completeness_james_flags',
   'organ_metadata',
   'Bundle Phase 2 metadata-completeness check for james_flags. Dormant until producer ship engages the EXISTS guard.',
   $inv$WITH active AS (SELECT EXISTS(SELECT 1 FROM public.ct_brain_telemetry WHERE helper_name = 'james_flags' AND organ_status IS NOT NULL AND created_at >= now() - interval '24 hours') AS is_active), nulls AS (SELECT COUNT(*) AS n FROM public.ct_brain_telemetry WHERE helper_name = 'james_flags' AND organ_status IS NULL AND error IS NULL AND created_at >= now() - interval '1 hour') SELECT CASE WHEN active.is_active THEN nulls.n::numeric ELSE 0::numeric END AS metric_value, CASE WHEN NOT active.is_active THEN 'organ james_flags not yet Phase 2 metadata-active (no organ_status writes in 24h)' WHEN nulls.n = 0 THEN 'all james_flags rows in last 1h have organ_status populated' ELSE 'METADATA LEAK: ' || nulls.n || ' james_flags rows missing organ_status in last 1h' END AS message FROM active, nulls$inv$,
   NULL, 0, NULL, 'warn', 'docs/system-map/organ-metadata-schema.md'),

  ('organ_metadata_completeness_event_recency',
   'organ_metadata',
   'Bundle Phase 2 metadata-completeness check for event_recency. Dormant until producer ship engages the EXISTS guard.',
   $inv$WITH active AS (SELECT EXISTS(SELECT 1 FROM public.ct_brain_telemetry WHERE helper_name = 'event_recency' AND organ_status IS NOT NULL AND created_at >= now() - interval '24 hours') AS is_active), nulls AS (SELECT COUNT(*) AS n FROM public.ct_brain_telemetry WHERE helper_name = 'event_recency' AND organ_status IS NULL AND error IS NULL AND created_at >= now() - interval '1 hour') SELECT CASE WHEN active.is_active THEN nulls.n::numeric ELSE 0::numeric END AS metric_value, CASE WHEN NOT active.is_active THEN 'organ event_recency not yet Phase 2 metadata-active (no organ_status writes in 24h)' WHEN nulls.n = 0 THEN 'all event_recency rows in last 1h have organ_status populated' ELSE 'METADATA LEAK: ' || nulls.n || ' event_recency rows missing organ_status in last 1h' END AS message FROM active, nulls$inv$,
   NULL, 0, NULL, 'warn', 'docs/system-map/organ-metadata-schema.md'),

  ('organ_metadata_completeness_analogs',
   'organ_metadata',
   'Bundle Phase 2 metadata-completeness check for analogs. Dormant until producer ship engages the EXISTS guard.',
   $inv$WITH active AS (SELECT EXISTS(SELECT 1 FROM public.ct_brain_telemetry WHERE helper_name = 'analogs' AND organ_status IS NOT NULL AND created_at >= now() - interval '24 hours') AS is_active), nulls AS (SELECT COUNT(*) AS n FROM public.ct_brain_telemetry WHERE helper_name = 'analogs' AND organ_status IS NULL AND error IS NULL AND created_at >= now() - interval '1 hour') SELECT CASE WHEN active.is_active THEN nulls.n::numeric ELSE 0::numeric END AS metric_value, CASE WHEN NOT active.is_active THEN 'organ analogs not yet Phase 2 metadata-active (no organ_status writes in 24h)' WHEN nulls.n = 0 THEN 'all analogs rows in last 1h have organ_status populated' ELSE 'METADATA LEAK: ' || nulls.n || ' analogs rows missing organ_status in last 1h' END AS message FROM active, nulls$inv$,
   NULL, 0, NULL, 'warn', 'docs/system-map/organ-metadata-schema.md'),

  ('organ_metadata_completeness_specialist_recall',
   'organ_metadata',
   'Bundle Phase 2 metadata-completeness check for specialist_recall. Dormant until producer ship engages the EXISTS guard.',
   $inv$WITH active AS (SELECT EXISTS(SELECT 1 FROM public.ct_brain_telemetry WHERE helper_name = 'specialist_recall' AND organ_status IS NOT NULL AND created_at >= now() - interval '24 hours') AS is_active), nulls AS (SELECT COUNT(*) AS n FROM public.ct_brain_telemetry WHERE helper_name = 'specialist_recall' AND organ_status IS NULL AND error IS NULL AND created_at >= now() - interval '1 hour') SELECT CASE WHEN active.is_active THEN nulls.n::numeric ELSE 0::numeric END AS metric_value, CASE WHEN NOT active.is_active THEN 'organ specialist_recall not yet Phase 2 metadata-active (no organ_status writes in 24h)' WHEN nulls.n = 0 THEN 'all specialist_recall rows in last 1h have organ_status populated' ELSE 'METADATA LEAK: ' || nulls.n || ' specialist_recall rows missing organ_status in last 1h' END AS message FROM active, nulls$inv$,
   NULL, 0, NULL, 'warn', 'docs/system-map/organ-metadata-schema.md');
