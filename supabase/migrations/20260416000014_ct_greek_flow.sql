-- ============================================================================
-- Greek Flow — per-minute dealer delta/vega hedging flow (HIRO input stream)
-- ============================================================================
SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS ct_greek_flow_minute (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker             text NOT NULL,
  tick_timestamp     timestamptz NOT NULL,
  net_call_delta     numeric,
  net_put_delta      numeric,
  net_call_vega      numeric,
  net_put_vega       numeric,
  total_delta_flow   numeric,
  total_vega_flow    numeric,
  underlying_price   numeric,
  raw                jsonb,
  ingested_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ticker, tick_timestamp)
);

CREATE INDEX IF NOT EXISTS ct_greek_flow_ticker_time
  ON ct_greek_flow_minute (ticker, tick_timestamp DESC);

ALTER TABLE ct_greek_flow_minute ENABLE ROW LEVEL SECURITY;

CREATE POLICY ct_greek_flow_minute_authread
  ON ct_greek_flow_minute FOR SELECT TO authenticated USING (true);

CREATE POLICY ct_greek_flow_minute_svcall
  ON ct_greek_flow_minute FOR ALL TO service_role USING (true) WITH CHECK (true);
