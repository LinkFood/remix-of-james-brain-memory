-- ct_options_screener_hits: unusual contracts flagged by UW's screener.
-- Source: UW MCP get_options_screener. Active discovery (pre-ranked by UW)
-- vs passive tape capture (ct_sweeps). Each run stores the top-N hits
-- for the current session.
--
-- We slice the screener by ticker AND market-wide runs (hide_index_etf=false
-- vs true) to catch both watchlist-specific activity and broader unusual
-- setups that might mention our underlyings.

CREATE TABLE IF NOT EXISTS public.ct_options_screener_hits (
  id              BIGSERIAL PRIMARY KEY,
  run_id          UUID NOT NULL DEFAULT gen_random_uuid(),
  run_ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  session_date    DATE NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
  ticker          TEXT,
  option_symbol   TEXT,
  type            TEXT,                    -- 'Calls' | 'Puts'
  strike          NUMERIC,
  expiry          DATE,
  dte             INT,
  volume          BIGINT,
  open_interest   BIGINT,
  vol_oi_ratio    NUMERIC,
  premium         NUMERIC,
  iv              NUMERIC,
  delta           NUMERIC,
  gamma           NUMERIC,
  theta           NUMERIC,
  vega            NUMERIC,
  ask_side_perc   NUMERIC,
  bid_side_perc   NUMERIC,
  sweep_vol_ratio NUMERIC,
  preset          TEXT,                    -- which screener preset found it
  filter_slice    TEXT,                    -- 'watchlist_all' | 'market_wide' | per-ticker
  raw             JSONB,
  ingested_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, option_symbol)
);

CREATE INDEX IF NOT EXISTS idx_ct_options_screener_ticker
  ON public.ct_options_screener_hits (ticker, run_ts DESC);
CREATE INDEX IF NOT EXISTS idx_ct_options_screener_session
  ON public.ct_options_screener_hits (session_date DESC, vol_oi_ratio DESC);

ALTER TABLE public.ct_options_screener_hits ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_read_screener_hits" ON public.ct_options_screener_hits
  FOR SELECT TO authenticated USING (true);
