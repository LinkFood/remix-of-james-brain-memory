-- =============================================================================
-- 20260422000018_ct_ingester_tables_n2.sql
--
-- Wave N.2 — 7 new UW MCP signal streams. Each gets one table + indexes +
-- RLS policies (authenticated read, service_role full), a pg_cron schedule
-- using the Vault-powered `_ct_post` helper, and a manual-trigger RPC.
--
--   1. ct_prediction_markets        — daily 09:00 UTC
--   2. ct_yield_curve               — daily 09:00 UTC
--   3. ct_correlations              — daily 09:00 UTC
--   4. ct_seasonality               — weekly Sun 22:00 UTC
--   5. ct_central_bank_rates        — daily 09:00 UTC
--   6. ct_institutional_holdings    — weekly Sun 22:00 UTC
--   7. ct_indicator_events          — every 30min RTH (13-20 UTC weekdays)
--
-- All ingesters hit UW via the MCP transport (`_shared/uwMcpClient.ts`,
-- `mcpCallToolAsData()`). Per CO-TRADER THESIS tenet 12 — duplicate nothing
-- UW maintains.
-- =============================================================================

SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 1) ct_prediction_markets — aggregated smart-money / whales / insiders
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_prediction_markets (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id             text NOT NULL,
  ticker                text,
  question              text,
  smart_money_position  numeric,
  whale_position        numeric,
  insider_position      numeric,
  unusual_flag          boolean NOT NULL DEFAULT false,
  liquidity             numeric,
  captured_at           timestamptz NOT NULL DEFAULT now(),
  raw                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT ct_prediction_markets_unique UNIQUE (market_id, captured_at)
);

CREATE INDEX IF NOT EXISTS idx_ct_prediction_markets_ticker_time
  ON ct_prediction_markets (ticker, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_ct_prediction_markets_unusual
  ON ct_prediction_markets (captured_at DESC) WHERE unusual_flag = true;

ALTER TABLE ct_prediction_markets ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ct_prediction_markets' AND policyname = 'ct_prediction_markets_authread') THEN
    EXECUTE 'CREATE POLICY ct_prediction_markets_authread ON ct_prediction_markets FOR SELECT TO authenticated USING (true)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ct_prediction_markets' AND policyname = 'ct_prediction_markets_svcall') THEN
    EXECUTE 'CREATE POLICY ct_prediction_markets_svcall ON ct_prediction_markets FOR ALL TO service_role USING (true) WITH CHECK (true)';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 2) ct_yield_curve — one row per capture date
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_yield_curve (
  capture_date      date PRIMARY KEY,
  tenors            jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_inverted       boolean,
  spread_10y_2y     numeric,
  ingested_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ct_yield_curve_inverted
  ON ct_yield_curve (capture_date DESC) WHERE is_inverted = true;

ALTER TABLE ct_yield_curve ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ct_yield_curve' AND policyname = 'ct_yield_curve_authread') THEN
    EXECUTE 'CREATE POLICY ct_yield_curve_authread ON ct_yield_curve FOR SELECT TO authenticated USING (true)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ct_yield_curve' AND policyname = 'ct_yield_curve_svcall') THEN
    EXECUTE 'CREATE POLICY ct_yield_curve_svcall ON ct_yield_curve FOR ALL TO service_role USING (true) WITH CHECK (true)';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 3) ct_correlations — pair correlations canonical (a < b) per window
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_correlations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  as_of_date      date NOT NULL,
  ticker_a        text NOT NULL,
  ticker_b        text NOT NULL,
  window_days     int NOT NULL,
  correlation     numeric,
  ingested_at     timestamptz NOT NULL DEFAULT now(),
  raw             jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT ct_correlations_unique UNIQUE (as_of_date, ticker_a, ticker_b, window_days)
);

CREATE INDEX IF NOT EXISTS idx_ct_correlations_date_window
  ON ct_correlations (as_of_date DESC, window_days);
CREATE INDEX IF NOT EXISTS idx_ct_correlations_a
  ON ct_correlations (ticker_a, as_of_date DESC);
CREATE INDEX IF NOT EXISTS idx_ct_correlations_b
  ON ct_correlations (ticker_b, as_of_date DESC);

ALTER TABLE ct_correlations ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ct_correlations' AND policyname = 'ct_correlations_authread') THEN
    EXECUTE 'CREATE POLICY ct_correlations_authread ON ct_correlations FOR SELECT TO authenticated USING (true)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ct_correlations' AND policyname = 'ct_correlations_svcall') THEN
    EXECUTE 'CREATE POLICY ct_correlations_svcall ON ct_correlations FOR ALL TO service_role USING (true) WITH CHECK (true)';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 4) ct_seasonality — per (ticker, calendar month) stats
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_seasonality (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker          text NOT NULL,
  month_int       int NOT NULL CHECK (month_int BETWEEN 1 AND 12),
  avg_return_pct  numeric,
  win_rate        numeric,
  sample_size     int,
  last_updated    timestamptz NOT NULL DEFAULT now(),
  raw             jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT ct_seasonality_unique UNIQUE (ticker, month_int)
);

CREATE INDEX IF NOT EXISTS idx_ct_seasonality_ticker
  ON ct_seasonality (ticker);

ALTER TABLE ct_seasonality ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ct_seasonality' AND policyname = 'ct_seasonality_authread') THEN
    EXECUTE 'CREATE POLICY ct_seasonality_authread ON ct_seasonality FOR SELECT TO authenticated USING (true)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ct_seasonality' AND policyname = 'ct_seasonality_svcall') THEN
    EXECUTE 'CREATE POLICY ct_seasonality_svcall ON ct_seasonality FOR ALL TO service_role USING (true) WITH CHECK (true)';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 5) ct_central_bank_rates — one row per (capture_date, country_code)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_central_bank_rates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  capture_date        date NOT NULL,
  country_code        text NOT NULL,
  rate                numeric,
  direction_trend     text,
  next_meeting_date   date,
  expected_move_bps   numeric,
  ingested_at         timestamptz NOT NULL DEFAULT now(),
  raw                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT ct_central_bank_rates_unique UNIQUE (capture_date, country_code)
);

CREATE INDEX IF NOT EXISTS idx_ct_central_bank_rates_date
  ON ct_central_bank_rates (capture_date DESC);
CREATE INDEX IF NOT EXISTS idx_ct_central_bank_rates_country
  ON ct_central_bank_rates (country_code, capture_date DESC);

ALTER TABLE ct_central_bank_rates ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ct_central_bank_rates' AND policyname = 'ct_central_bank_rates_authread') THEN
    EXECUTE 'CREATE POLICY ct_central_bank_rates_authread ON ct_central_bank_rates FOR SELECT TO authenticated USING (true)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ct_central_bank_rates' AND policyname = 'ct_central_bank_rates_svcall') THEN
    EXECUTE 'CREATE POLICY ct_central_bank_rates_svcall ON ct_central_bank_rates FOR ALL TO service_role USING (true) WITH CHECK (true)';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 6) ct_institutional_holdings — 13F institution/ticker rows
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_institutional_holdings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker              text NOT NULL,
  institution_name    text,
  institution_id      text NOT NULL,
  shares_held         numeric,
  value_usd           numeric,
  pct_of_holdings     numeric,
  change_qoq          numeric,
  filing_date         date NOT NULL,
  ingested_at         timestamptz NOT NULL DEFAULT now(),
  raw                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT ct_institutional_holdings_unique UNIQUE (ticker, institution_id, filing_date)
);

CREATE INDEX IF NOT EXISTS idx_ct_institutional_holdings_ticker
  ON ct_institutional_holdings (ticker, filing_date DESC);
CREATE INDEX IF NOT EXISTS idx_ct_institutional_holdings_institution
  ON ct_institutional_holdings (institution_id, filing_date DESC);

ALTER TABLE ct_institutional_holdings ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ct_institutional_holdings' AND policyname = 'ct_institutional_holdings_authread') THEN
    EXECUTE 'CREATE POLICY ct_institutional_holdings_authread ON ct_institutional_holdings FOR SELECT TO authenticated USING (true)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ct_institutional_holdings' AND policyname = 'ct_institutional_holdings_svcall') THEN
    EXECUTE 'CREATE POLICY ct_institutional_holdings_svcall ON ct_institutional_holdings FOR ALL TO service_role USING (true) WITH CHECK (true)';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 7) ct_indicator_events — technical-event occurrences per ticker
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_indicator_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker          text NOT NULL,
  event_type      text NOT NULL,
  event_date      timestamptz NOT NULL,
  indicator_name  text,
  value           numeric,
  ingested_at     timestamptz NOT NULL DEFAULT now(),
  raw             jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- indicator_name in the unique key can be NULL; PostgREST on_conflict
  -- with ignore-duplicates handles NULLs by treating them as distinct,
  -- which matches the behavior we want (same event_type without an
  -- indicator context should not collide with one that has one).
  CONSTRAINT ct_indicator_events_unique UNIQUE (ticker, event_type, event_date, indicator_name)
);

CREATE INDEX IF NOT EXISTS idx_ct_indicator_events_ticker_time
  ON ct_indicator_events (ticker, event_date DESC);
CREATE INDEX IF NOT EXISTS idx_ct_indicator_events_type
  ON ct_indicator_events (event_type, event_date DESC);

ALTER TABLE ct_indicator_events ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ct_indicator_events' AND policyname = 'ct_indicator_events_authread') THEN
    EXECUTE 'CREATE POLICY ct_indicator_events_authread ON ct_indicator_events FOR SELECT TO authenticated USING (true)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ct_indicator_events' AND policyname = 'ct_indicator_events_svcall') THEN
    EXECUTE 'CREATE POLICY ct_indicator_events_svcall ON ct_indicator_events FOR ALL TO service_role USING (true) WITH CHECK (true)';
  END IF;
END $$;

-- ============================================================================
-- Manual-trigger RPCs — each wraps the existing _ct_post helper.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.trigger_ct_prediction_markets_ingester()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-prediction-markets-ingester'); $fn$;
GRANT EXECUTE ON FUNCTION public.trigger_ct_prediction_markets_ingester() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.trigger_ct_yield_curve_ingester()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-yield-curve-ingester'); $fn$;
GRANT EXECUTE ON FUNCTION public.trigger_ct_yield_curve_ingester() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.trigger_ct_correlations_ingester()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-correlations-ingester'); $fn$;
GRANT EXECUTE ON FUNCTION public.trigger_ct_correlations_ingester() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.trigger_ct_seasonality_ingester()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-seasonality-ingester'); $fn$;
GRANT EXECUTE ON FUNCTION public.trigger_ct_seasonality_ingester() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.trigger_ct_central_bank_ingester()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-central-bank-ingester'); $fn$;
GRANT EXECUTE ON FUNCTION public.trigger_ct_central_bank_ingester() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.trigger_ct_institutional_ingester()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-institutional-ingester'); $fn$;
GRANT EXECUTE ON FUNCTION public.trigger_ct_institutional_ingester() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.trigger_ct_indicator_events_ingester()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-indicator-events-ingester'); $fn$;
GRANT EXECUTE ON FUNCTION public.trigger_ct_indicator_events_ingester() TO authenticated, service_role;

-- ============================================================================
-- pg_cron schedules — unschedule any previous versions first (idempotent).
-- All use the Vault-decrypted-secrets pattern with $cron$/$body$ nesting.
-- ============================================================================
DO $$
DECLARE j record;
BEGIN
  FOR j IN SELECT jobname FROM cron.job
           WHERE jobname IN (
             'ct-prediction-markets-ingester',
             'ct-yield-curve-ingester',
             'ct-correlations-ingester',
             'ct-seasonality-ingester',
             'ct-central-bank-ingester',
             'ct-institutional-ingester',
             'ct-indicator-events-ingester'
           )
  LOOP
    PERFORM cron.unschedule(j.jobname);
  END LOOP;
END $$;

-- 1) Prediction markets — daily 09:00 UTC
SELECT cron.schedule(
  'ct-prediction-markets-ingester',
  '0 9 * * *',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-prediction-markets-ingester',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);

-- 2) Yield curve — daily 09:00 UTC
SELECT cron.schedule(
  'ct-yield-curve-ingester',
  '0 9 * * *',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-yield-curve-ingester',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);

-- 3) Correlations — daily 09:00 UTC
SELECT cron.schedule(
  'ct-correlations-ingester',
  '0 9 * * *',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-correlations-ingester',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);

-- 4) Seasonality — weekly Sunday 22:00 UTC
SELECT cron.schedule(
  'ct-seasonality-ingester',
  '0 22 * * 0',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-seasonality-ingester',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);

-- 5) Central bank rates — daily 09:00 UTC
SELECT cron.schedule(
  'ct-central-bank-ingester',
  '0 9 * * *',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-central-bank-ingester',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);

-- 6) Institutional holdings — weekly Sunday 22:00 UTC
SELECT cron.schedule(
  'ct-institutional-ingester',
  '0 22 * * 0',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-institutional-ingester',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);

-- 7) Indicator events — every 30min during RTH (13-20 UTC weekdays)
SELECT cron.schedule(
  'ct-indicator-events-ingester',
  '*/30 13-20 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-indicator-events-ingester',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);
