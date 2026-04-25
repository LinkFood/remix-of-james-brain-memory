-- ============================================================================
-- Co-Trader cron audit — Phase C of trading-clock fix (2026-04-24)
-- ============================================================================
--
-- The trading day is the heartbeat. Mon-Fri 9:30am-4pm ET = active. Weekends
-- are dormant EXCEPT for forward-looking exceptions: Sunday-evening news +
-- Monday-morning oi-snapshot-open. Anything else firing on weekends with no
-- live tape is a bug — it bakes stale Friday-close prices into outcomes.
--
-- This migration only RESCHEDULES. Cron bodies are preserved verbatim;
-- only the schedule string changes. We do NOT unschedule anything outright.
--
-- BEFORE / AFTER table:
--
--   bucket "RTH-active" (was every-N-min-always → fire only during RTH)
--     ct-flag-grader              */30 * * * *        → */30 13-20 * * 1-5
--     ct-grader                   */15 * * * *        → */15 13-20 * * 1-5
--     ct-news-causality           */15 * * * *        → */15 13-20 * * 1-5
--     ct-alert-post-mortem        */30 * * * *        → */30 13-20 * * 1-5
--     ct-self-grader              0 */2 * * *         → 0 13-20/2 * * 1-5
--     ct-slack-push-flag          * * * * *           → * 13-20 * * 1-5
--     ct-event-calendar-ingester  0 */4 * * *         → 0 */4 * * 1-5
--
--   bucket "trading-day-close" (was nightly all-days → weekday only)
--     ct-debate-outcome-scorer    0 22 * * *          → 0 22 * * 1-5
--     ct-score-self-grade-nightly 0 22 * * *          → 0 22 * * 1-5
--     ct-reflect-to-jac           30 22 * * *         → 30 22 * * 1-5
--     ct-ticker-baselines-nightly 45 22 * * *         → 45 22 * * 1-5
--     ct-hypothesis-reaper        0 6 * * *           → 0 6 * * 1-5
--     ct-price-ticks-retention    0 6 * * *           → 0 6 * * 1-5
--
--   bucket "weekday-only ingesters" (data sources publish weekdays)
--     ct-central-bank-ingester           0 9 * * *  → 0 9 * * 1-5
--     ct-correlations-ingester           0 9 * * *  → 0 9 * * 1-5
--     ct-political-ingester              0 7 * * *  → 0 7 * * 1-5
--     ct-prediction-markets-ingester     0 9 * * *  → 0 9 * * 1-5
--     ct-prediction-smart-money-ingester 0 8 * * *  → 0 8 * * 1-5
--     ct-insider-ingester                0 7 * * *  → 0 7 * * 1-5
--     ct-short-interest-ingester         0 8 * * *  → 0 8 * * 1-5
--     ct-skew-ingester                   30 9 * * * → 30 9 * * 1-5
--     ct-yield-curve-ingester            0 9 * * *  → 0 9 * * 1-5
--     ct-uw-endpoint-health-check        0 5 * * *  → 0 5 * * 1-5
--     ct-uw-mcp-scout                    0 4 * * *  → 0 4 * * 1-5
--
--   KEPT all-week (intentional weekend coverage):
--     ct-cron-health-check              */10 * * * *   — watchdog, MUST run weekends
--     ct-news-ingester-weekend          0 * * * 6,0    — Sunday-evening news
--     ct-tavily-news-watcher-weekend    0 */2 * * 6,0  — Sunday-evening news
--     ct-earnings-moves-sync            15 22 * * 0    — Sunday earnings prep
--     ct-earnings-sync                  0 12 * * 0     — Sunday earnings prep
--     ct-fundamentals-sync              0 22 * * 0     — Sunday data refresh
--     ct-institutional-ingester         0 22 * * 0     — Sunday filing refresh
--     ct-lessons-curator                0 23 * * 0     — Sunday weekly review
--     ct-playbook-curator               45 22 * * 0    — Sunday weekly review
--     ct-seasonality-ingester           0 22 * * 0     — Sunday data refresh
--
-- Note: bodies below are literal copies of what is currently scheduled
-- (queried via get_cron_status RPC pre-migration). Any whitespace difference
-- is faithful to the live job source.
-- ============================================================================

SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- RTH-active bucket
-- ----------------------------------------------------------------------------

DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-flag-grader') THEN
    PERFORM cron.unschedule('ct-flag-grader');
  END IF;
  PERFORM cron.schedule(
    'ct-flag-grader',
    '*/30 13-20 * * 1-5',
    $body$ SELECT public.trigger_ct_flag_grader(); $body$
  );
END $mig$;

DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-grader') THEN
    PERFORM cron.unschedule('ct-grader');
  END IF;
  PERFORM cron.schedule(
    'ct-grader',
    '*/15 13-20 * * 1-5',
    $body$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-grader',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    )
  $body$
  );
END $mig$;

DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-news-causality') THEN
    PERFORM cron.unschedule('ct-news-causality');
  END IF;
  PERFORM cron.schedule(
    'ct-news-causality',
    '*/15 13-20 * * 1-5',
    $body$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-news-causality',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    )
  $body$
  );
END $mig$;

DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-alert-post-mortem') THEN
    PERFORM cron.unschedule('ct-alert-post-mortem');
  END IF;
  PERFORM cron.schedule(
    'ct-alert-post-mortem',
    '*/30 13-20 * * 1-5',
    $body$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-alert-post-mortem',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $body$
  );
END $mig$;

DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-self-grader') THEN
    PERFORM cron.unschedule('ct-self-grader');
  END IF;
  PERFORM cron.schedule(
    'ct-self-grader',
    '0 13-20/2 * * 1-5',
    $body$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-self-grader',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    )
  $body$
  );
END $mig$;

DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-slack-push-flag') THEN
    PERFORM cron.unschedule('ct-slack-push-flag');
  END IF;
  PERFORM cron.schedule(
    'ct-slack-push-flag',
    '* 13-20 * * 1-5',
    $body$ SELECT public.trigger_ct_slack_push_flag(); $body$
  );
END $mig$;

DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-event-calendar-ingester') THEN
    PERFORM cron.unschedule('ct-event-calendar-ingester');
  END IF;
  PERFORM cron.schedule(
    'ct-event-calendar-ingester',
    '0 */4 * * 1-5',
    $body$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-event-calendar-ingester',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    )
  $body$
  );
END $mig$;

-- ----------------------------------------------------------------------------
-- Trading-day-close bucket
-- ----------------------------------------------------------------------------

DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-debate-outcome-scorer') THEN
    PERFORM cron.unschedule('ct-debate-outcome-scorer');
  END IF;
  PERFORM cron.schedule(
    'ct-debate-outcome-scorer',
    '0 22 * * 1-5',
    $body$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-debate-outcome-scorer',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $body$
  );
END $mig$;

DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-score-self-grade-nightly') THEN
    PERFORM cron.unschedule('ct-score-self-grade-nightly');
  END IF;
  PERFORM cron.schedule(
    'ct-score-self-grade-nightly',
    '0 22 * * 1-5',
    $body$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-score-self-grade',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
    ),
    body := jsonb_build_object('window_days', 7)
  );
  $body$
  );
END $mig$;

DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-reflect-to-jac') THEN
    PERFORM cron.unschedule('ct-reflect-to-jac');
  END IF;
  PERFORM cron.schedule(
    'ct-reflect-to-jac',
    '30 22 * * 1-5',
    $body$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-reflect-to-jac',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $body$
  );
END $mig$;

DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-ticker-baselines-nightly') THEN
    PERFORM cron.unschedule('ct-ticker-baselines-nightly');
  END IF;
  PERFORM cron.schedule(
    'ct-ticker-baselines-nightly',
    '45 22 * * 1-5',
    $body$ SELECT public.ct_rollup_ticker_baselines(); $body$
  );
END $mig$;

DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-hypothesis-reaper') THEN
    PERFORM cron.unschedule('ct-hypothesis-reaper');
  END IF;
  PERFORM cron.schedule(
    'ct-hypothesis-reaper',
    '0 6 * * 1-5',
    $body$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-hypothesis-reaper',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $body$
  );
END $mig$;

DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-price-ticks-retention') THEN
    PERFORM cron.unschedule('ct-price-ticks-retention');
  END IF;
  PERFORM cron.schedule(
    'ct-price-ticks-retention',
    '0 6 * * 1-5',
    $body$
    DELETE FROM public.ct_price_ticks
    WHERE tick_time < now() - INTERVAL '7 days'
  $body$
  );
END $mig$;

-- ----------------------------------------------------------------------------
-- Weekday-only ingester bucket (data sources publish weekdays)
-- ----------------------------------------------------------------------------

DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-central-bank-ingester') THEN
    PERFORM cron.unschedule('ct-central-bank-ingester');
  END IF;
  PERFORM cron.schedule(
    'ct-central-bank-ingester',
    '0 9 * * 1-5',
    $body$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-central-bank-ingester',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $body$
  );
END $mig$;

DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-correlations-ingester') THEN
    PERFORM cron.unschedule('ct-correlations-ingester');
  END IF;
  PERFORM cron.schedule(
    'ct-correlations-ingester',
    '0 9 * * 1-5',
    $body$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-correlations-ingester',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $body$
  );
END $mig$;

DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-political-ingester') THEN
    PERFORM cron.unschedule('ct-political-ingester');
  END IF;
  PERFORM cron.schedule(
    'ct-political-ingester',
    '0 7 * * 1-5',
    $body$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-political-ingester',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $body$
  );
END $mig$;

DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-prediction-markets-ingester') THEN
    PERFORM cron.unschedule('ct-prediction-markets-ingester');
  END IF;
  PERFORM cron.schedule(
    'ct-prediction-markets-ingester',
    '0 9 * * 1-5',
    $body$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-prediction-markets-ingester',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $body$
  );
END $mig$;

DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-prediction-smart-money-ingester') THEN
    PERFORM cron.unschedule('ct-prediction-smart-money-ingester');
  END IF;
  PERFORM cron.schedule(
    'ct-prediction-smart-money-ingester',
    '0 8 * * 1-5',
    $body$ SELECT public.trigger_ct_prediction_smart_money_ingester(); $body$
  );
END $mig$;

DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-insider-ingester') THEN
    PERFORM cron.unschedule('ct-insider-ingester');
  END IF;
  PERFORM cron.schedule(
    'ct-insider-ingester',
    '0 7 * * 1-5',
    $body$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-insider-ingester',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $body$
  );
END $mig$;

DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-short-interest-ingester') THEN
    PERFORM cron.unschedule('ct-short-interest-ingester');
  END IF;
  PERFORM cron.schedule(
    'ct-short-interest-ingester',
    '0 8 * * 1-5',
    $body$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-short-interest-ingester',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $body$
  );
END $mig$;

DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-skew-ingester') THEN
    PERFORM cron.unschedule('ct-skew-ingester');
  END IF;
  PERFORM cron.schedule(
    'ct-skew-ingester',
    '30 9 * * 1-5',
    $body$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-skew-ingester',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $body$
  );
END $mig$;

DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-yield-curve-ingester') THEN
    PERFORM cron.unschedule('ct-yield-curve-ingester');
  END IF;
  PERFORM cron.schedule(
    'ct-yield-curve-ingester',
    '0 9 * * 1-5',
    $body$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-yield-curve-ingester',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $body$
  );
END $mig$;

DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-uw-endpoint-health-check') THEN
    PERFORM cron.unschedule('ct-uw-endpoint-health-check');
  END IF;
  PERFORM cron.schedule(
    'ct-uw-endpoint-health-check',
    '0 5 * * 1-5',
    $body$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-uw-endpoint-health-check',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $body$
  );
END $mig$;

DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-uw-mcp-scout') THEN
    PERFORM cron.unschedule('ct-uw-mcp-scout');
  END IF;
  PERFORM cron.schedule(
    'ct-uw-mcp-scout',
    '0 4 * * 1-5',
    $body$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-uw-mcp-scout',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $body$
  );
END $mig$;

-- ----------------------------------------------------------------------------
-- Trigger fix — _ct_flags_compute_horizon_ts now uses trading-hour math.
-- ----------------------------------------------------------------------------
-- The original trigger (migration 20260423000026) computed
--   horizon_ts = created_at + horizon_hours * INTERVAL '1 hour'
-- which let calendar weekend hours count as trading hours. A 24h horizon
-- written Friday afternoon landed Saturday afternoon with no live tape.
-- Phase A repaired the 32 stuck rows; this fix prevents the next cohort.
--
-- specialistRunner.ts now passes horizon_ts explicitly (computed via the TS
-- addTradingHours), so this trigger is defense-in-depth for any direct insert
-- (backfill scripts, manual SQL, future v3 paths) that doesn't pre-compute.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._ct_flags_compute_horizon_ts()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.horizon_ts IS NULL THEN
      NEW.horizon_ts = public.add_trading_hours(NEW.created_at, NEW.horizon_hours::numeric);
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.horizon_hours IS DISTINCT FROM OLD.horizon_hours THEN
      NEW.horizon_ts = public.add_trading_hours(NEW.created_at, NEW.horizon_hours::numeric);
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;
