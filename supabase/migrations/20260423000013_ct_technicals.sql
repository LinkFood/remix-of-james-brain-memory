-- ct_technicals: computed technical indicators per ticker.
-- Source: UW MCP get_ticker_indicator_series. We request a curated set
-- (RSI14, MACD, VWAP, Bollinger, ATR) instead of letting Claude compute
-- these himself from OHLC — those computations were known-hallucination
-- hotspots pre-v1.5. Pre-computed = less hallucination, lower token cost,
-- consistent bar alignment.
--
-- Stored as one row per (ticker, indicator, timestamp). A wrapper view
-- ct_technicals_latest exposes the most recent value per (ticker,indicator)
-- for the quant card decorator.

CREATE TABLE IF NOT EXISTS public.ct_technicals (
  id              BIGSERIAL PRIMARY KEY,
  ticker          TEXT NOT NULL,
  indicator       TEXT NOT NULL,             -- 'rsi' | 'macd' | 'vwap' | 'bb' | 'atr' | 'sma50' ...
  timeframe       TEXT NOT NULL DEFAULT '1d', -- '1m' | '5m' | '1h' | '1d' | '1w'
  ts              TIMESTAMPTZ NOT NULL,
  value           NUMERIC,                    -- primary scalar (RSI level, VWAP price, MACD signal line)
  extras          JSONB,                      -- secondary fields (MACD has signal+hist; BB has upper+lower; ATR has level)
  raw             JSONB,
  ingested_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ticker, indicator, timeframe, ts)
);

CREATE INDEX IF NOT EXISTS idx_ct_technicals_lookup
  ON public.ct_technicals (ticker, indicator, timeframe, ts DESC);

ALTER TABLE public.ct_technicals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_read_technicals" ON public.ct_technicals
  FOR SELECT TO authenticated USING (true);

-- Latest value per (ticker, indicator, timeframe)
CREATE OR REPLACE VIEW public.ct_technicals_latest AS
SELECT DISTINCT ON (ticker, indicator, timeframe)
  ticker, indicator, timeframe, ts, value, extras, raw, ingested_at
FROM public.ct_technicals
ORDER BY ticker, indicator, timeframe, ts DESC;

GRANT SELECT ON public.ct_technicals_latest TO authenticated, service_role;

-- Helper to build per-ticker technicals JSON for the quant card
CREATE OR REPLACE FUNCTION public.ct_compute_technicals(p_ticker TEXT)
RETURNS jsonb
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    jsonb_object_agg(
      indicator || '_' || timeframe,
      jsonb_build_object('value', value, 'ts', ts, 'extras', extras)
    ),
    '{}'::jsonb
  )
  FROM public.ct_technicals_latest
  WHERE ticker = upper(p_ticker);
$$;

GRANT EXECUTE ON FUNCTION public.ct_compute_technicals(TEXT) TO authenticated, service_role;
