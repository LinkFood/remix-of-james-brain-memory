-- ============================================================================
-- Wave 2 — NOPE, top-net-impact, sweep screener, max-pain, IV rank
-- ============================================================================
SET search_path = public, extensions;

-- Per-minute NOPE (dealer gamma hedging pressure classifier)
CREATE TABLE IF NOT EXISTS ct_nope_minute (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker          text NOT NULL,
  tick_timestamp  timestamptz NOT NULL,
  nope            numeric,
  underlying_price numeric,
  raw             jsonb,
  ingested_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ticker, tick_timestamp)
);
CREATE INDEX IF NOT EXISTS ct_nope_ticker_time ON ct_nope_minute (ticker, tick_timestamp DESC);

-- Market-wide top net-impact tickers (watchlist generator)
CREATE TABLE IF NOT EXISTS ct_top_movers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_at     timestamptz NOT NULL DEFAULT now(),
  ticker          text NOT NULL,
  side            text NOT NULL CHECK (side IN ('bullish','bearish')),
  rank            int NOT NULL,
  net_premium     numeric,
  raw             jsonb
);
CREATE INDEX IF NOT EXISTS ct_top_movers_snapshot ON ct_top_movers (snapshot_at DESC);
CREATE INDEX IF NOT EXISTS ct_top_movers_ticker ON ct_top_movers (ticker, snapshot_at DESC);

-- Canonical unusual sweeps
CREATE TABLE IF NOT EXISTS ct_sweeps (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker          text NOT NULL,
  option_symbol   text,
  strike          numeric,
  expiry          date,
  type            text,                 -- Calls | Puts
  premium         numeric,
  volume          numeric,
  open_interest   numeric,
  sweep_ratio     numeric,
  ask_side_perc   numeric,
  snapshot_at     timestamptz NOT NULL DEFAULT now(),
  raw             jsonb,
  UNIQUE (option_symbol, snapshot_at)
);
CREATE INDEX IF NOT EXISTS ct_sweeps_ticker_time ON ct_sweeps (ticker, snapshot_at DESC);
CREATE INDEX IF NOT EXISTS ct_sweeps_premium ON ct_sweeps (premium DESC);

-- Max pain + IV rank — daily cadence
CREATE TABLE IF NOT EXISTS ct_max_pain_daily (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker          text NOT NULL,
  date            date NOT NULL,
  expiry          date,
  max_pain_strike numeric,
  raw             jsonb,
  ingested_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ticker, date, expiry)
);
CREATE INDEX IF NOT EXISTS ct_max_pain_ticker_date ON ct_max_pain_daily (ticker, date DESC);

CREATE TABLE IF NOT EXISTS ct_iv_rank_daily (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker          text NOT NULL,
  date            date NOT NULL,
  iv_rank         numeric,
  iv_30d          numeric,
  iv_percentile   numeric,
  raw             jsonb,
  ingested_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ticker, date)
);
CREATE INDEX IF NOT EXISTS ct_iv_rank_ticker_date ON ct_iv_rank_daily (ticker, date DESC);

-- RLS
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['ct_nope_minute','ct_top_movers','ct_sweeps','ct_max_pain_daily','ct_iv_rank_daily'])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (true)', t || '_authread', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)', t || '_svcall', t);
  END LOOP;
END $$;
