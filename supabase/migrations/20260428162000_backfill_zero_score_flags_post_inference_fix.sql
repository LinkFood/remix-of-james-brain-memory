-- Re-run the backfill for any zero-score signature/cluster flags that
-- accumulated after the morning's score-race fix but before the per-alert
-- inline score fix landed (~12:15 ET).
--
-- The morning migration (20260428145000) caught flags 0-9:55 ET. The watcher
-- redeploys at ~10:25 ET (directionInference fix) + the underlying race that
-- pg_cron-scheduling-of-scoring-then-watcher couldn't fully close left a
-- residual ~10% zero rate through to ~12:15 ET. ~12:15 ET deploy of
-- ct-signature-watcher adds inline score recovery per alert before tier eval,
-- which structurally closes the race going forward.
--
-- This migration just sweeps up the residue.
SET search_path = public, extensions;

UPDATE public.ct_flags f
SET score = ROUND(sf.score)::integer
FROM public.ct_signature_alarm_log al,
     public.ct_scored_flow sf
WHERE f.detector_id IN ('signature_v1','cluster_default','cluster_slow_stacker')
  AND f.source = 'signature_alarm'
  AND f.score = 0
  AND f.created_at >= (CURRENT_DATE)::timestamptz
  AND al.option_symbol = f.option_symbol
  AND ABS(EXTRACT(EPOCH FROM (f.created_at - al.fired_at))) < 10
  AND sf.source_table = 'ct_flow_alerts'
  AND sf.source_id   = al.alert_id
  AND sf.score IS NOT NULL
  AND ROUND(sf.score)::integer > 0;

-- Same for the alarm log so historical analysis sees the resolved score.
UPDATE public.ct_signature_alarm_log al
SET score = ROUND(sf.score)::numeric
FROM public.ct_scored_flow sf
WHERE al.score IS NULL
  AND al.fired_at >= (CURRENT_DATE)::timestamptz
  AND sf.source_table = 'ct_flow_alerts'
  AND sf.source_id   = al.alert_id
  AND sf.score IS NOT NULL;
