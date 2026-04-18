-- ct_spy_daily — SPY daily close history.
--
-- Powers the benchmark half of RiskMetricsPanel (beta/alpha vs SPY). Before
-- this table existed the panel fell back to "—" because nothing persisted a
-- daily close series. Captured 4:05 PM ET weekdays via ct-spy-capture, which
-- leans on UW's already-called spot-exposures endpoint (underlying_price
-- field) — no new UW calls added.
--
-- First-row sentinel: when no prior row exists, ct-spy-capture writes
-- prev_close = close so the generated column yields 0.0 instead of NULL or
-- a divide-by-zero. Downstream consumers should still treat the oldest row
-- as "no return" implicitly (same handling ct_book gets for day 0).
--
-- Forward-only by design. UW's SKILL.md wrapped in uwClient.ts exposes no
-- historical-bars endpoint, and the Sharpe/beta stats that need SPY weight
-- recent returns anyway — an empty tail for the first ~10 sessions is the
-- acceptable trade.
SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- Table
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_spy_daily (
  date             date PRIMARY KEY,
  open             numeric,
  high             numeric,
  low              numeric,
  close            numeric,
  volume           bigint,
  prev_close       numeric,
  daily_return_pct numeric GENERATED ALWAYS AS (
                     CASE
                       WHEN prev_close IS NULL OR prev_close = 0 THEN 0
                       ELSE (close - prev_close) / prev_close * 100
                     END
                   ) STORED,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ct_spy_daily_date_desc ON ct_spy_daily (date DESC);

-- -----------------------------------------------------------------------------
-- RLS — authenticated read, service role full
-- -----------------------------------------------------------------------------
ALTER TABLE ct_spy_daily ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ct_spy_daily_read ON ct_spy_daily;
DROP POLICY IF EXISTS ct_spy_daily_svc  ON ct_spy_daily;

CREATE POLICY ct_spy_daily_read
  ON ct_spy_daily FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY ct_spy_daily_svc
  ON ct_spy_daily FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- Trigger RPC — pattern matches other ct-* functions (see _ct_post helper
-- defined in 20260416000006_ct_day4_crons.sql).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trigger_ct_spy_capture()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-spy-capture'); $fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_spy_capture() TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Cron — 5 minutes after US cash close (4:00 PM ET = 21:00 UTC during DST).
-- Weekdays only. 21:05 UTC gives UW a moment to settle the closing print.
-- -----------------------------------------------------------------------------
SELECT cron.schedule(
  'ct-spy-capture',
  '5 21 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-spy-capture',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);
