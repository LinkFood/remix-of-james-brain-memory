-- ct_price_bars: historical OHLC for attribution. ct_ticker_snapshots is a cache;
-- this is the time-series that forward-return attribution reads from.

CREATE TABLE IF NOT EXISTS public.ct_price_bars (
  id BIGSERIAL PRIMARY KEY,
  ticker TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  timeframe TEXT NOT NULL CHECK (timeframe IN ('1m','5m','15m','30m','1h','1d')),
  open NUMERIC(14,4) NOT NULL,
  high NUMERIC(14,4) NOT NULL,
  low NUMERIC(14,4) NOT NULL,
  close NUMERIC(14,4) NOT NULL,
  volume BIGINT,
  source TEXT NOT NULL DEFAULT 'yfinance',
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ticker, ts, timeframe)
);

CREATE INDEX IF NOT EXISTS idx_ct_price_bars_lookup
  ON public.ct_price_bars (ticker, timeframe, ts);

ALTER TABLE public.ct_price_bars ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_read_price_bars" ON public.ct_price_bars
  FOR SELECT TO authenticated USING (true);

-- Forward-return RPC. Given a signal event (ticker, event_ts, horizon_mins),
-- returns the signed return, SPY baseline return, and alpha (signal return - SPY return).
-- Uses 1m bars; snaps entry to nearest bar within 10 min of event_ts, exit to nearest
-- bar within 10 min of event_ts + horizon. Returns valid=false if either snap fails
-- (which correctly excludes after-hours, weekends, and halted sessions).

CREATE OR REPLACE FUNCTION public.ct_forward_return(
  p_ticker       TEXT,
  p_event_ts     TIMESTAMPTZ,
  p_horizon_mins INT
) RETURNS TABLE (
  entry_price     NUMERIC,
  exit_price      NUMERIC,
  return_pct      NUMERIC,
  spy_entry       NUMERIC,
  spy_exit        NUMERIC,
  spy_return_pct  NUMERIC,
  alpha_pct       NUMERIC,
  entry_ts        TIMESTAMPTZ,
  exit_ts         TIMESTAMPTZ,
  valid           BOOLEAN
)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_target_ts TIMESTAMPTZ := p_event_ts + make_interval(mins => p_horizon_mins);
  v_slop      INTERVAL    := INTERVAL '10 minutes';
BEGIN
  RETURN QUERY
  WITH
    t_entry AS (
      SELECT close AS px, ts
      FROM public.ct_price_bars
      WHERE ticker = p_ticker AND timeframe = '1m'
        AND ts >= p_event_ts AND ts < p_event_ts + v_slop
      ORDER BY ts ASC LIMIT 1
    ),
    t_exit AS (
      SELECT close AS px, ts
      FROM public.ct_price_bars
      WHERE ticker = p_ticker AND timeframe = '1m'
        AND ts >= v_target_ts AND ts < v_target_ts + v_slop
      ORDER BY ts ASC LIMIT 1
    ),
    s_entry AS (
      SELECT close AS px
      FROM public.ct_price_bars
      WHERE ticker = 'SPY' AND timeframe = '1m'
        AND ts >= p_event_ts AND ts < p_event_ts + v_slop
      ORDER BY ts ASC LIMIT 1
    ),
    s_exit AS (
      SELECT close AS px
      FROM public.ct_price_bars
      WHERE ticker = 'SPY' AND timeframe = '1m'
        AND ts >= v_target_ts AND ts < v_target_ts + v_slop
      ORDER BY ts ASC LIMIT 1
    )
  SELECT
    te.px,
    tx.px,
    ROUND(((tx.px - te.px) / te.px) * 100, 4) AS return_pct,
    se.px,
    sx.px,
    CASE WHEN se.px IS NOT NULL AND sx.px IS NOT NULL
         THEN ROUND(((sx.px - se.px) / se.px) * 100, 4) END AS spy_return_pct,
    CASE WHEN se.px IS NOT NULL AND sx.px IS NOT NULL
         THEN ROUND((((tx.px - te.px) / te.px) - ((sx.px - se.px) / se.px)) * 100, 4) END AS alpha_pct,
    te.ts,
    tx.ts,
    (te.px IS NOT NULL AND tx.px IS NOT NULL) AS valid
  FROM t_entry te
  FULL OUTER JOIN t_exit tx ON TRUE
  LEFT JOIN s_entry se ON TRUE
  LEFT JOIN s_exit  sx ON TRUE;

  -- If both entry and exit are NULL, return a single invalid row
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::NUMERIC, NULL::NUMERIC, NULL::NUMERIC, NULL::NUMERIC,
                        NULL::NUMERIC, NULL::NUMERIC, NULL::NUMERIC,
                        NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, FALSE;
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION public.ct_forward_return(TEXT, TIMESTAMPTZ, INT) TO authenticated, service_role;

COMMENT ON TABLE public.ct_price_bars IS
  'OHLC bars for attribution. Populated by ct-price-backfill (yfinance) now; UW historical later.';
COMMENT ON FUNCTION public.ct_forward_return IS
  'Forward-return with SPY baseline. Returns NULL alpha if event_ts is outside RTH (exit bar not found). Edge = positive alpha.';
