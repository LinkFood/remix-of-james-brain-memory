-- Backfill afternoon zero-score flags after the executed_at-fallback fix.
--
-- Same race signature as the earlier morning backfill but a different root
-- cause: executed_at is null on RepeatedHits* alerts (~30% of UW flow), so
-- the per-alert score recovery's `&& a.executed_at` guard skipped them
-- entirely. Watcher fired with score=0. Fixed at ~2:18pm ET to fall back
-- to ingested_at; this migration cleans up the residue.
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

UPDATE public.ct_signature_alarm_log al
SET score = ROUND(sf.score)::numeric
FROM public.ct_scored_flow sf
WHERE al.score IS NULL
  AND al.fired_at >= (CURRENT_DATE)::timestamptz
  AND sf.source_table = 'ct_flow_alerts'
  AND sf.source_id   = al.alert_id
  AND sf.score IS NOT NULL;
