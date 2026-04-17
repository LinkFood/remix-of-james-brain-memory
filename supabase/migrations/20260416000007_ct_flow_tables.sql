-- ============================================================================
-- Flow + Dark Pool tables — the product-defining data we missed in Day 1-6
-- ============================================================================
SET search_path = public, extensions;

-- Unusual options flow alerts (market-wide, 1-2 min freshness)
CREATE TABLE IF NOT EXISTS ct_flow_alerts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id         text UNIQUE,                                 -- UW's own id for dedup
  ticker           text NOT NULL,
  option_symbol    text,
  strike           numeric,
  expiry           date,
  side             text,                                        -- call|put
  is_ask           boolean,                                     -- traded at ask = aggressive buy
  is_bid           boolean,
  is_otm           boolean,
  size             numeric,
  volume           numeric,
  open_interest    numeric,
  size_gt_oi       boolean,                                     -- opening trade where size > OI
  premium          numeric,
  price            numeric,                                     -- option price
  underlying_price numeric,
  executed_at      timestamptz,
  alert_type       text,                                        -- unusual_activity, sweep, block, whale, etc.
  raw              jsonb,                                       -- full UW row for later reparsing
  ingested_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ct_flow_alerts_ticker_time ON ct_flow_alerts (ticker, executed_at DESC);
CREATE INDEX IF NOT EXISTS ct_flow_alerts_time ON ct_flow_alerts (executed_at DESC);
CREATE INDEX IF NOT EXISTS ct_flow_alerts_premium ON ct_flow_alerts (premium DESC);

-- Dark pool prints (market-wide + per-ticker)
CREATE TABLE IF NOT EXISTS ct_dark_pool_prints (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  print_id         text UNIQUE,                                 -- UW dedup
  ticker           text NOT NULL,
  size             numeric NOT NULL,
  price            numeric NOT NULL,
  volume           numeric,
  sale_code        text,
  exchange         text,
  market_center    text,
  executed_at      timestamptz,
  notional_value   numeric GENERATED ALWAYS AS (size * price) STORED,
  raw              jsonb,
  ingested_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ct_dp_ticker_time ON ct_dark_pool_prints (ticker, executed_at DESC);
CREATE INDEX IF NOT EXISTS ct_dp_time ON ct_dark_pool_prints (executed_at DESC);
CREATE INDEX IF NOT EXISTS ct_dp_notional ON ct_dark_pool_prints (notional_value DESC);

-- Net premium ticks (per-ticker intraday directional sentiment)
CREATE TABLE IF NOT EXISTS ct_net_premium_ticks (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker             text NOT NULL,
  tick_timestamp     timestamptz NOT NULL,
  net_call_premium   numeric,
  net_put_premium    numeric,
  net_call_volume    numeric,
  net_put_volume     numeric,
  underlying_price   numeric,
  raw                jsonb,
  ingested_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ticker, tick_timestamp)
);

CREATE INDEX IF NOT EXISTS ct_npt_ticker_time ON ct_net_premium_ticks (ticker, tick_timestamp DESC);

-- RLS
ALTER TABLE ct_flow_alerts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE ct_dark_pool_prints   ENABLE ROW LEVEL SECURITY;
ALTER TABLE ct_net_premium_ticks  ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['ct_flow_alerts','ct_dark_pool_prints','ct_net_premium_ticks'])
  LOOP
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (true)', t || '_authread', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)', t || '_svcall', t);
  END LOOP;
END $$;
