-- =============================================================================
-- 20260430154000_flow_stack_v1_detector.sql
--
-- Flow Stack v1 — heatmap concentration alarm.
--
-- Fires when aggressive_directional_premium_decay for a single
-- (ticker, expiry_bucket_week) cell exceeds N std deviations vs the trailing
-- 7-day distribution of that ticker's heatmap cell values. Uses the
-- ct_flow_heatmap_snapshots table populated by ct-heatmap-snapshot. SHADOW
-- mode at launch (tenet 10): writes to ct_flags only, NO Slack push. Lifecycle
-- promotion to 'live' deferred until ≥1 week of baseline data + a manual hit-rate
-- review.
-- =============================================================================
SET search_path = public, extensions;

INSERT INTO public.ct_detectors (id, name, description, status, dte_class, config, thesis) VALUES
  ('flow_stack_v1',
   'Flow Stack v1 — heatmap concentration alarm',
   'Fires when aggressive_directional_premium_decay for a single (ticker, expiry_bucket_week) exceeds N std dev vs trailing 7d distribution for that ticker',
   'shadow',
   'all',
   '{"std_dev_threshold":2.5,"min_baseline_samples":50,"evaluation_window_minutes":5,"baseline_window_days":7,"dedupe_min":60}'::jsonb,
   'Visualize-then-detect: when premium concentration on one expiry bucket spikes 2.5+ std dev above its own trailing 7d distribution, that bucket is being repriced. Direction inferred from sign of decay-weighted directional premium.')
ON CONFLICT (id) DO UPDATE SET
  name        = EXCLUDED.name,
  description = EXCLUDED.description,
  config      = EXCLUDED.config,
  thesis      = EXCLUDED.thesis,
  dte_class   = EXCLUDED.dte_class,
  updated_at  = now();

-- Cron — runs offset by 2 minutes from ct-heatmap-snapshot's */5 schedule
-- so the latest snapshot row has settled before evaluation. RTH only,
-- weekdays only (matches detector portfolio convention).
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-detector-flow-stack-v1') THEN
    PERFORM cron.unschedule('ct-detector-flow-stack-v1');
  END IF;

  PERFORM cron.schedule(
    'ct-detector-flow-stack-v1',
    '2-58/5 13-20 * * 1-5',
    $body$SELECT public.invoke_edge_function('ct-detector-flow-stack-v1', '{}'::jsonb);$body$
  );
END
$cron$;
