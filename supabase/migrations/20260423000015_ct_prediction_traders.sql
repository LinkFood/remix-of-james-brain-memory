-- ct_prediction_traders: leaderboard of profitable / large prediction-market
-- traders. Source: UW MCP get_prediction_whales + get_prediction_smart_money.
-- Useful for macro/political event positioning context.
--
-- Two row categories flagged via `category` column: 'whale' (size-based)
-- and 'smart_money' (profit-based).

CREATE TABLE IF NOT EXISTS public.ct_prediction_traders (
  id              BIGSERIAL PRIMARY KEY,
  snapshot_ts     TIMESTAMPTZ NOT NULL DEFAULT now(),
  category        TEXT NOT NULL CHECK (category IN ('whale','smart_money')),
  user_id_external TEXT,                 -- UW's user/wallet ID
  display_name    TEXT,
  profit_usd      NUMERIC,
  volume_usd      NUMERIC,
  win_rate        NUMERIC,
  trade_count     INT,
  rank_position   INT,
  categories      TEXT[],                -- filter used (if any)
  raw             JSONB,
  UNIQUE (snapshot_ts, category, user_id_external)
);

CREATE INDEX IF NOT EXISTS idx_ct_prediction_traders_category
  ON public.ct_prediction_traders (category, snapshot_ts DESC);

ALTER TABLE public.ct_prediction_traders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_read_prediction_traders" ON public.ct_prediction_traders
  FOR SELECT TO authenticated USING (true);
