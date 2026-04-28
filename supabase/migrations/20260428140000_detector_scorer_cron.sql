-- Schedule ct-detector-scorer every 5min during RTH weekdays.
--
-- Picks up score=0 detector_alarm flags written by the 7 detectors firing
-- raw alarms (smart_money_repeat_v1, weekly_atm_voi_v1, zerodte_opening_call_v1,
-- zerodte_put_voi_extreme_v1, small_cap_inverted_put_v1, whale_v1, unusual_oi_v1)
-- and computes a 0-100 score from sig_class + cluster + V/OI + premium + pulse.
--
-- The existing ct-slack-push-flag template gates Slack on score >= threshold —
-- this scorer is the missing layer that turns shadow-mode detector alarms into
-- actionable signal James actually sees.
--
-- Schedule: */5 13-20 * * 1-5  (every 5min RTH 9:00am-4:00pm ET equivalent UTC)
SET search_path = public, extensions;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-detector-scorer-rth') THEN
    PERFORM cron.unschedule('ct-detector-scorer-rth');
  END IF;

  PERFORM cron.schedule(
    'ct-detector-scorer-rth',
    '*/5 13-20 * * 1-5',
    $body$
      SELECT net.http_post(
        url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-detector-scorer',
        headers := jsonb_build_object(
          'Content-Type',  'application/json',
          'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
        ),
        body    := '{}'::jsonb
      )
    $body$
  );
END
$cron$;
