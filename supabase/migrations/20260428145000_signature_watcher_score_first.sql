-- Fix the signature-watcher race that nukes scores to 0.
--
-- Pipeline:
--   1. ct-flow-ingester writes ct_flow_alerts
--   2. ct-score-flow-continuous (every 2 min) reads alerts, scores them,
--      writes to ct_scored_flow
--   3. ct-signature-watcher (every 1 min) reads alerts, calls
--      loadScoreForAlert() which queries ct_scored_flow.score
--   4. If watcher runs between scoring fires, score is NULL → flag.score = 0
--   5. Dedupe in ct_signature_alarm_log prevents re-fire when score arrives
--
-- Result today: 24/26 signature_v1 flags have score=0. Yesterday: 40/54.
-- Top scored flag today: 45 (vs yesterday 85).
--
-- Two changes:
--   1. Reschedule watcher cron to run ct_score_existing_flow() FIRST in the
--      same statement, so by the time the watcher fires the scored_flow row
--      always exists. p_since=15min keeps the work bounded.
--   2. Backfill today's score=0 signature/cluster flags from ct_scored_flow
--      via ct_signature_alarm_log JOIN.
SET search_path = public, extensions;

-- ---- 1. Backfill today's score=0 signature/cluster flags ----
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

-- Patch the alarm log so future analytics don't see null scores
-- on rows where scoring caught up after the fact.
UPDATE public.ct_signature_alarm_log al
SET score = ROUND(sf.score)::numeric
FROM public.ct_scored_flow sf
WHERE al.score IS NULL
  AND al.fired_at >= (CURRENT_DATE)::timestamptz
  AND sf.source_table = 'ct_flow_alerts'
  AND sf.source_id   = al.alert_id
  AND sf.score IS NOT NULL;

-- ---- 2. Reschedule watcher cron to score first, then watch ----
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-signature-watcher-rth') THEN
    PERFORM cron.unschedule('ct-signature-watcher-rth');
  END IF;
END
$cron$;

SELECT cron.schedule(
  'ct-signature-watcher-rth',
  '* 13-20 * * 1-5',
  $body$
    SELECT public.ct_score_existing_flow(now() - interval '15 minutes');
    SELECT public.invoke_edge_function('ct-signature-watcher', '{}'::jsonb);
  $body$
);
