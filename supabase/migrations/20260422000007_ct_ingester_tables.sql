-- =============================================================================
-- 20260422000007_ct_ingester_tables.sql
--
-- Phase 1 Wave C — ingest the 7 UW streams Claude is missing. Each ingester
-- gets one table + indexes + RLS policies (authenticated read, service_role
-- full), plus a pg_cron schedule and a manual-trigger RPC via the existing
-- _ct_post Vault-powered helper (see 20260416000006_ct_day4_crons.sql).
--
--   1. ct_insider_trades        — daily 07:00 UTC  (pre-open)
--   2. ct_political_trades      — daily 07:00 UTC
--   3. ct_analyst_actions       — every 2h,   12-22 UTC, weekdays
--   4. ct_short_interest        — daily 08:00 UTC
--   5. ct_sector_tide           — every 5m,   13-20 UTC, weekdays
--   6. ct_risk_reversal_skew    — daily 09:30 UTC
--   7. ct_technical_indicators  — every 15m,  13-20 UTC, weekdays
--
-- All 7 ingesters hit Unusual Whales; rate-limit budget is covered by
-- ct_uw_usage recording (see uwClient.ts).
-- =============================================================================

SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 1) ct_insider_trades — form-4 transactions filtered to watchlist tickers
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_insider_trades (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id     text NOT NULL,                   -- UW's stable id (fallback: url/hash)
  filing_date        date,
  trade_date         date,
  ticker             text NOT NULL,
  insider_name       text,
  insider_title      text,
  transaction_type   text,                            -- 'P-Purchase' | 'S-Sale' | 'A-Award' | ...
  shares             numeric,
  price              numeric,
  value_usd          numeric,
  ownership_type     text,                            -- 'Direct' | 'Indirect'
  raw                jsonb NOT NULL DEFAULT '{}'::jsonb,
  ingested_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ct_insider_trades_txn_unique UNIQUE (transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_ct_insider_trades_ticker_date
  ON ct_insider_trades (ticker, trade_date DESC);
CREATE INDEX IF NOT EXISTS idx_ct_insider_trades_ingested
  ON ct_insider_trades (ingested_at DESC);

ALTER TABLE ct_insider_trades ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ct_insider_trades' AND policyname = 'ct_insider_trades_authread') THEN
    EXECUTE 'CREATE POLICY ct_insider_trades_authread ON ct_insider_trades FOR SELECT TO authenticated USING (true)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ct_insider_trades' AND policyname = 'ct_insider_trades_svcall') THEN
    EXECUTE 'CREATE POLICY ct_insider_trades_svcall ON ct_insider_trades FOR ALL TO service_role USING (true) WITH CHECK (true)';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 2) ct_political_trades — congress / senate disclosures
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_political_trades (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  disclosure_id     text NOT NULL,
  traded_at         date,
  reported_at       date,
  trader_name       text,
  chamber           text,                             -- 'house' | 'senate'
  party             text,
  ticker            text,
  side              text,                             -- 'buy' | 'sell' | 'exchange'
  amount_band_usd   text,                             -- '$1,001-$15,000' etc (UW ships as string band)
  raw               jsonb NOT NULL DEFAULT '{}'::jsonb,
  ingested_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ct_political_trades_disclosure_unique UNIQUE (disclosure_id)
);

CREATE INDEX IF NOT EXISTS idx_ct_political_trades_ticker_date
  ON ct_political_trades (ticker, traded_at DESC);
CREATE INDEX IF NOT EXISTS idx_ct_political_trades_ingested
  ON ct_political_trades (ingested_at DESC);

ALTER TABLE ct_political_trades ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ct_political_trades' AND policyname = 'ct_political_trades_authread') THEN
    EXECUTE 'CREATE POLICY ct_political_trades_authread ON ct_political_trades FOR SELECT TO authenticated USING (true)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ct_political_trades' AND policyname = 'ct_political_trades_svcall') THEN
    EXECUTE 'CREATE POLICY ct_political_trades_svcall ON ct_political_trades FOR ALL TO service_role USING (true) WITH CHECK (true)';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 3) ct_analyst_actions — rating changes / price-target revisions
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_analyst_actions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id             text NOT NULL,
  action_date           date,
  ticker                text NOT NULL,
  analyst_firm          text,
  action_type           text,                         -- 'upgraded' | 'downgraded' | 'reiterated' | 'initiated' | 'target_raised' | 'target_lowered'
  from_rating           text,
  to_rating             text,
  price_target          numeric,
  prior_price_target    numeric,
  raw                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  ingested_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ct_analyst_actions_action_unique UNIQUE (action_id)
);

CREATE INDEX IF NOT EXISTS idx_ct_analyst_actions_ticker_date
  ON ct_analyst_actions (ticker, action_date DESC);
CREATE INDEX IF NOT EXISTS idx_ct_analyst_actions_ingested
  ON ct_analyst_actions (ingested_at DESC);

ALTER TABLE ct_analyst_actions ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ct_analyst_actions' AND policyname = 'ct_analyst_actions_authread') THEN
    EXECUTE 'CREATE POLICY ct_analyst_actions_authread ON ct_analyst_actions FOR SELECT TO authenticated USING (true)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ct_analyst_actions' AND policyname = 'ct_analyst_actions_svcall') THEN
    EXECUTE 'CREATE POLICY ct_analyst_actions_svcall ON ct_analyst_actions FOR ALL TO service_role USING (true) WITH CHECK (true)';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 4) ct_short_interest — bi-monthly short interest + short-volume ratio
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_short_interest (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker                       text NOT NULL,
  report_date                  date,
  short_interest_shares        numeric,
  short_interest_pct_float     numeric,
  days_to_cover                numeric,
  short_volume_ratio_recent    numeric,              -- most-recent daily short/total volume ratio
  raw                          jsonb NOT NULL DEFAULT '{}'::jsonb,
  ingested_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ct_short_interest_ticker_report_unique UNIQUE (ticker, report_date)
);

CREATE INDEX IF NOT EXISTS idx_ct_short_interest_ticker
  ON ct_short_interest (ticker, report_date DESC);
CREATE INDEX IF NOT EXISTS idx_ct_short_interest_ingested
  ON ct_short_interest (ingested_at DESC);

ALTER TABLE ct_short_interest ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ct_short_interest' AND policyname = 'ct_short_interest_authread') THEN
    EXECUTE 'CREATE POLICY ct_short_interest_authread ON ct_short_interest FOR SELECT TO authenticated USING (true)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ct_short_interest' AND policyname = 'ct_short_interest_svcall') THEN
    EXECUTE 'CREATE POLICY ct_short_interest_svcall ON ct_short_interest FOR ALL TO service_role USING (true) WITH CHECK (true)';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 5) ct_sector_tide — sector-level net call/put premium (5-min cadence)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_sector_tide (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sector              text NOT NULL,
  captured_at         timestamptz NOT NULL,           -- UW's own timestamp, not ingested_at
  net_call_premium    numeric,
  net_put_premium     numeric,
  net_delta           numeric,
  net_vega            numeric,
  raw                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  ingested_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ct_sector_tide_sector_capture_unique UNIQUE (sector, captured_at)
);

CREATE INDEX IF NOT EXISTS idx_ct_sector_tide_sector_time
  ON ct_sector_tide (sector, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_ct_sector_tide_recent
  ON ct_sector_tide (captured_at DESC);

ALTER TABLE ct_sector_tide ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ct_sector_tide' AND policyname = 'ct_sector_tide_authread') THEN
    EXECUTE 'CREATE POLICY ct_sector_tide_authread ON ct_sector_tide FOR SELECT TO authenticated USING (true)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ct_sector_tide' AND policyname = 'ct_sector_tide_svcall') THEN
    EXECUTE 'CREATE POLICY ct_sector_tide_svcall ON ct_sector_tide FOR ALL TO service_role USING (true) WITH CHECK (true)';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 6) ct_risk_reversal_skew — 25-delta call IV minus 25-delta put IV per expiry
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_risk_reversal_skew (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker             text NOT NULL,
  capture_date       date NOT NULL,
  expiry             date,
  delta_25_call_iv   numeric,
  delta_25_put_iv    numeric,
  skew_25d           numeric,                         -- call_iv - put_iv (positive = call premium; negative = put premium)
  raw                jsonb NOT NULL DEFAULT '{}'::jsonb,
  ingested_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ct_risk_reversal_skew_unique UNIQUE (ticker, capture_date, expiry)
);

CREATE INDEX IF NOT EXISTS idx_ct_risk_reversal_skew_ticker_date
  ON ct_risk_reversal_skew (ticker, capture_date DESC);
CREATE INDEX IF NOT EXISTS idx_ct_risk_reversal_skew_ingested
  ON ct_risk_reversal_skew (ingested_at DESC);

ALTER TABLE ct_risk_reversal_skew ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ct_risk_reversal_skew' AND policyname = 'ct_risk_reversal_skew_authread') THEN
    EXECUTE 'CREATE POLICY ct_risk_reversal_skew_authread ON ct_risk_reversal_skew FOR SELECT TO authenticated USING (true)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ct_risk_reversal_skew' AND policyname = 'ct_risk_reversal_skew_svcall') THEN
    EXECUTE 'CREATE POLICY ct_risk_reversal_skew_svcall ON ct_risk_reversal_skew FOR ALL TO service_role USING (true) WITH CHECK (true)';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 7) ct_technical_indicators — RSI / MACD / VWAP / ATR / BBANDS per ticker
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_technical_indicators (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker           text NOT NULL,
  indicator_name   text NOT NULL,                    -- 'rsi' | 'macd' | 'vwap' | 'atr' | 'bbands'
  period           int,                              -- 14, 20, etc (null for indicators without a period, e.g. vwap)
  captured_at      timestamptz NOT NULL,
  value            numeric,                          -- primary scalar (latest close or indicator value)
  raw              jsonb NOT NULL DEFAULT '{}'::jsonb,
  ingested_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ct_technical_indicators_unique UNIQUE (ticker, indicator_name, period, captured_at)
);

CREATE INDEX IF NOT EXISTS idx_ct_technical_indicators_ticker_name_time
  ON ct_technical_indicators (ticker, indicator_name, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_ct_technical_indicators_recent
  ON ct_technical_indicators (captured_at DESC);

ALTER TABLE ct_technical_indicators ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ct_technical_indicators' AND policyname = 'ct_technical_indicators_authread') THEN
    EXECUTE 'CREATE POLICY ct_technical_indicators_authread ON ct_technical_indicators FOR SELECT TO authenticated USING (true)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ct_technical_indicators' AND policyname = 'ct_technical_indicators_svcall') THEN
    EXECUTE 'CREATE POLICY ct_technical_indicators_svcall ON ct_technical_indicators FOR ALL TO service_role USING (true) WITH CHECK (true)';
  END IF;
END $$;

-- ============================================================================
-- Manual-trigger RPCs — wrap _ct_post so the /crons UI can fire each ad-hoc
-- under the Vault-powered Authorization (avoids CLI vs runtime key drift).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.trigger_ct_insider_ingester()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-insider-ingester'); $fn$;
GRANT EXECUTE ON FUNCTION public.trigger_ct_insider_ingester() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.trigger_ct_political_ingester()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-political-ingester'); $fn$;
GRANT EXECUTE ON FUNCTION public.trigger_ct_political_ingester() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.trigger_ct_analyst_ingester()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-analyst-ingester'); $fn$;
GRANT EXECUTE ON FUNCTION public.trigger_ct_analyst_ingester() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.trigger_ct_short_interest_ingester()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-short-interest-ingester'); $fn$;
GRANT EXECUTE ON FUNCTION public.trigger_ct_short_interest_ingester() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.trigger_ct_sector_tide_ingester()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-sector-tide-ingester'); $fn$;
GRANT EXECUTE ON FUNCTION public.trigger_ct_sector_tide_ingester() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.trigger_ct_skew_ingester()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-skew-ingester'); $fn$;
GRANT EXECUTE ON FUNCTION public.trigger_ct_skew_ingester() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.trigger_ct_technicals_ingester()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-technicals-ingester'); $fn$;
GRANT EXECUTE ON FUNCTION public.trigger_ct_technicals_ingester() TO authenticated, service_role;

-- ============================================================================
-- pg_cron schedules — unschedule any previous versions first (idempotent).
-- All use the Vault-decrypted-secrets pattern with $cron$/$body$ nesting.
-- ============================================================================
DO $$
DECLARE j record;
BEGIN
  FOR j IN SELECT jobname FROM cron.job
           WHERE jobname IN (
             'ct-insider-ingester',
             'ct-political-ingester',
             'ct-analyst-ingester',
             'ct-short-interest-ingester',
             'ct-sector-tide-ingester',
             'ct-skew-ingester',
             'ct-technicals-ingester'
           )
  LOOP
    PERFORM cron.unschedule(j.jobname);
  END LOOP;
END $$;

-- 1) Insider — daily 07:00 UTC (pre-open)
SELECT cron.schedule(
  'ct-insider-ingester',
  '0 7 * * *',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-insider-ingester',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);

-- 2) Political — daily 07:00 UTC
SELECT cron.schedule(
  'ct-political-ingester',
  '0 7 * * *',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-political-ingester',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);

-- 3) Analyst — every 2h, 12-22 UTC, weekdays
SELECT cron.schedule(
  'ct-analyst-ingester',
  '0 12-22/2 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-analyst-ingester',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);

-- 4) Short interest — daily 08:00 UTC
SELECT cron.schedule(
  'ct-short-interest-ingester',
  '0 8 * * *',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-short-interest-ingester',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);

-- 5) Sector tide — every 5min during RTH (13-20 UTC weekdays)
SELECT cron.schedule(
  'ct-sector-tide-ingester',
  '*/5 13-20 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-sector-tide-ingester',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);

-- 6) Risk-reversal skew — daily 09:30 UTC
SELECT cron.schedule(
  'ct-skew-ingester',
  '30 9 * * *',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-skew-ingester',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);

-- 7) Technicals — every 15min during RTH (13-20 UTC weekdays)
SELECT cron.schedule(
  'ct-technicals-ingester',
  '*/15 13-20 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-technicals-ingester',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);
