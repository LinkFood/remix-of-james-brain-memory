-- ============================================================================
-- ct_gex_timeseries — per-strike gamma over time, fuel for the GEX heatmap.
-- Each row: one strike, one snapshot timestamp, one ticker.
-- Retains the full gamma landscape so we can render time × strike heatmaps
-- like TRACE / SpotGamma / MenthorQ.
-- ============================================================================
SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS ct_gex_timeseries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker         text NOT NULL,
  snapshot_at    timestamptz NOT NULL,
  strike         numeric NOT NULL,
  call_gex       numeric,
  put_gex        numeric,
  net_gex        numeric,
  underlying_price numeric,
  is_atm_band    boolean,            -- true if strike within ATM ±10%
  UNIQUE (ticker, snapshot_at, strike)
);

CREATE INDEX IF NOT EXISTS ct_gex_ts_ticker_time ON ct_gex_timeseries (ticker, snapshot_at DESC);
CREATE INDEX IF NOT EXISTS ct_gex_ts_strike ON ct_gex_timeseries (ticker, strike, snapshot_at DESC);

ALTER TABLE ct_gex_timeseries ENABLE ROW LEVEL SECURITY;
CREATE POLICY ct_gex_ts_authread ON ct_gex_timeseries FOR SELECT TO authenticated USING (true);
CREATE POLICY ct_gex_ts_svcall ON ct_gex_timeseries FOR ALL TO service_role USING (true) WITH CHECK (true);
