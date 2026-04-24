-- Fix "column reference ticker is ambiguous" in ct_ticker_intraday_context.
--
-- Postgres collides the OUT parameter name `ticker` with the table column
-- `ct_price_bars.ticker` / `ct_ticker_snapshots.ticker` inside the function
-- body. Rename the OUT column to `out_ticker`... no, that breaks the frontend
-- contract. Instead, fully qualify every table-column reference and use a
-- distinct local variable for the returned ticker name. Signature unchanged.

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.ct_ticker_intraday_context(p_ticker TEXT)
RETURNS TABLE (
  ticker                TEXT,
  spot                  NUMERIC,
  prev_close            NUMERIC,
  today_open            NUMERIC,
  pct_from_prev_close   NUMERIC,
  pct_from_today_open   NUMERIC,
  as_of                 TIMESTAMPTZ
)
LANGUAGE plpgsql STABLE
SET search_path = public, extensions
AS $$
DECLARE
  v_now         TIMESTAMPTZ := now();
  v_today       DATE        := v_now::date;
  v_spot        NUMERIC;
  v_prev_close  NUMERIC;
  v_today_open  NUMERIC;
  v_pct_prev    NUMERIC;
  v_pct_open    NUMERIC;
BEGIN
  SELECT s.spot INTO v_spot
  FROM public.ct_ticker_snapshots s
  WHERE s.ticker = p_ticker;

  IF v_spot IS NULL THEN
    SELECT pb.close INTO v_spot
    FROM public.ct_price_bars pb
    WHERE pb.ticker = p_ticker AND pb.timeframe = '1m'
    ORDER BY pb.ts DESC
    LIMIT 1;
  END IF;

  SELECT pb.close INTO v_prev_close
  FROM public.ct_price_bars pb
  WHERE pb.ticker = p_ticker
    AND pb.timeframe = '1m'
    AND pb.ts::date < v_today
    AND pb.ts::date >= (v_today - INTERVAL '5 days')
  ORDER BY pb.ts DESC
  LIMIT 1;

  SELECT pb.close INTO v_today_open
  FROM public.ct_price_bars pb
  WHERE pb.ticker = p_ticker
    AND pb.timeframe = '1m'
    AND pb.ts::date = v_today
    AND pb.ts >= (v_today || ' 13:30:00+00')::timestamptz
    AND pb.ts <  (v_today || ' 14:00:00+00')::timestamptz
  ORDER BY pb.ts ASC
  LIMIT 1;

  IF v_spot IS NOT NULL AND v_prev_close IS NOT NULL AND v_prev_close <> 0 THEN
    v_pct_prev := ROUND(((v_spot - v_prev_close) / v_prev_close) * 100, 4);
  END IF;
  IF v_spot IS NOT NULL AND v_today_open IS NOT NULL AND v_today_open <> 0 THEN
    v_pct_open := ROUND(((v_spot - v_today_open) / v_today_open) * 100, 4);
  END IF;

  ticker              := p_ticker;
  spot                := v_spot;
  prev_close          := v_prev_close;
  today_open          := v_today_open;
  pct_from_prev_close := v_pct_prev;
  pct_from_today_open := v_pct_open;
  as_of               := v_now;
  RETURN NEXT;
END $$;

GRANT EXECUTE ON FUNCTION public.ct_ticker_intraday_context(TEXT) TO authenticated, service_role;
