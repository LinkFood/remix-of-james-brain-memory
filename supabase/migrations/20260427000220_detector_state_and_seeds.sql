-- Detector portfolio Wave 2 — three new pure-data detectors.
-- Realizes tenets 8/24/25: each detector is a registered row, writes alarms
-- via shared schema (ct_flags), and adding more is a SQL INSERT not a deploy.
--
-- Detectors land in 'shadow' status — they write alarms to /alarms but do
-- NOT push Slack (Slack is gated by signature_alarm_slack_enabled which is
-- OFF by default; detector_alarm has no Slack wiring this wave).
SET search_path = public, extensions;

-- 1. Per-detector watermark + state. Each detector tracks its own cursor so
--    parallel detectors never share stepping state and a slow one can't
--    starve the others.
CREATE TABLE IF NOT EXISTS public.ct_detector_state (
  detector_id text PRIMARY KEY,
  last_processed_at timestamptz NOT NULL DEFAULT now() - interval '5 minutes',
  last_run_at timestamptz NOT NULL DEFAULT now(),
  meta jsonb NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE public.ct_detector_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY ct_detector_state_service ON public.ct_detector_state
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY ct_detector_state_read ON public.ct_detector_state
  FOR SELECT TO authenticated USING (true);

-- 2. Extend ct_flags.source CHECK constraint to include 'detector_alarm'.
--    Previous constraint allowed only ('specialist','james_star','signature_alarm').
ALTER TABLE public.ct_flags
  DROP CONSTRAINT IF EXISTS ct_flags_source_check;

ALTER TABLE public.ct_flags
  ADD CONSTRAINT ct_flags_source_check
  CHECK (source IN ('specialist', 'james_star', 'signature_alarm', 'detector_alarm'));

-- 3. Seed the 3 new detectors as rows in ct_detectors.
INSERT INTO public.ct_detectors (id, name, description, status, config, thesis) VALUES
  ('whale_v1',
   'Whale detector',
   'Single-print premium > $250k. Smart money big bets.',
   'shadow',
   '{"min_premium":250000,"dedupe_min":30}'::jsonb,
   'Large single-print premium signals institutional conviction. Filter for >$250k.'),
  ('unusual_oi_v1',
   'Unusual OI',
   'Volume / open_interest > 5x. Net new positioning, not churn.',
   'shadow',
   '{"min_ratio":5.0,"min_volume":100,"dedupe_min":30}'::jsonb,
   'When today''s volume vastly exceeds existing open interest, new conviction is being built (not churn).'),
  ('pair_qqq_iwm_v1',
   'QQQ-IWM pair divergence',
   'Pulse divergence: QQQ vs IWM moving opposite directions.',
   'shadow',
   '{"min_slope_threshold":80000,"dedupe_min":60}'::jsonb,
   'Large-cap (QQQ) vs small-cap (IWM) Pulse divergence is a sector-rotation tell. Either the leaders or the laggards are repricing.')
ON CONFLICT (id) DO NOTHING;

-- 4. Seed initial watermarks (5 min back so first sweep has a window to look in).
INSERT INTO public.ct_detector_state (detector_id, last_processed_at) VALUES
  ('whale_v1', now() - interval '5 minutes'),
  ('unusual_oi_v1', now() - interval '5 minutes'),
  ('pair_qqq_iwm_v1', now() - interval '5 minutes')
ON CONFLICT (detector_id) DO NOTHING;

-- 5. Schedule crons. RTH = 13-20 UTC weekdays (= 9-4 ET). Whale also runs
--    off-hours (premarket/aftermarket) at lower frequency for unusual flow.
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-detector-whale-rth') THEN
    PERFORM cron.unschedule('ct-detector-whale-rth');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-detector-whale-off') THEN
    PERFORM cron.unschedule('ct-detector-whale-off');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-detector-unusual-oi-rth') THEN
    PERFORM cron.unschedule('ct-detector-unusual-oi-rth');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-detector-pair-qqq-iwm-rth') THEN
    PERFORM cron.unschedule('ct-detector-pair-qqq-iwm-rth');
  END IF;

  PERFORM cron.schedule(
    'ct-detector-whale-rth',
    '*/5 13-20 * * 1-5',
    $body$SELECT public.invoke_edge_function('ct-detector-whale', '{}'::jsonb);$body$
  );
  PERFORM cron.schedule(
    'ct-detector-whale-off',
    '0 0,4,8,21 * * *',
    $body$SELECT public.invoke_edge_function('ct-detector-whale', '{}'::jsonb);$body$
  );
  PERFORM cron.schedule(
    'ct-detector-unusual-oi-rth',
    '*/5 13-20 * * 1-5',
    $body$SELECT public.invoke_edge_function('ct-detector-unusual-oi', '{}'::jsonb);$body$
  );
  PERFORM cron.schedule(
    'ct-detector-pair-qqq-iwm-rth',
    '*/5 13-20 * * 1-5',
    $body$SELECT public.invoke_edge_function('ct-detector-pair-qqq-iwm', '{}'::jsonb);$body$
  );
END
$cron$;
