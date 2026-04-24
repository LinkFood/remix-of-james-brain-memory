-- Co-Trader v2 — FlowPulse RPC
--
-- Aggregate directional imbalance per watchlist ticker over a rolling window,
-- with a 30d baseline computed inline from ct_scored_flow history. Specialists
-- read this to factor REGIME skew into flag decisions (not just isolated events).
-- James reads the frontend FlowPulse card to see "what's the floor doing right
-- now" at a glance.
--
-- Scope:
--   * ct_scored_flow rows within p_window_min (default 360 = 6h RTH session)
--   * classifications: opening_buy + opening_sell (drop closing/hedge/ambiguous)
--   * watchlist: SPY QQQ IWM AAPL MSFT GOOGL AMZN META NVDA TSLA
--   * p_ticker narrows to one if provided
--
-- Call/put side derivation:
--   * OCC option_symbol has side char at length-9 (e.g. AAPL240621C00180000 → 'C')
--   * substring(sym, length(sym)-8, 1)
--
-- OTM/ITM bucketing (uses ct_ticker_snapshots.spot as underlying reference;
-- ct_scored_flow has no underlying_price column — snapshot.spot is live-polled
-- and the 0.5% buffer absorbs intraday drift within the 6h window):
--   * Call OTM:  strike >= spot * 0.995  (ATM folds into OTM per spec)
--   * Call ITM:  strike <  spot * 0.995
--   * Put  OTM:  strike <= spot * 1.005
--   * Put  ITM:  strike >  spot * 1.005
--
-- Baseline: no call_put_ratio column exists in ct_ticker_baselines, so compute
-- inline over the last 30 calendar days of ct_scored_flow per ticker. Matches
-- how ct_rollup_ticker_baselines treats its own windows — no new table needed.
--
-- is_unusual: cp_ratio_deviation <= 0.5 OR >= 2.0 AND both current + baseline
-- windows have >= 20 total opening events (suppress noise on thin windows).

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.ct_flow_pulse(
  p_window_min INT DEFAULT 360,
  p_ticker     TEXT DEFAULT NULL
)
RETURNS TABLE(
  ticker                TEXT,
  calls_count           INTEGER,
  puts_count            INTEGER,
  calls_otm_count       INTEGER,
  calls_itm_count       INTEGER,
  puts_otm_count        INTEGER,
  puts_itm_count        INTEGER,
  calls_premium         NUMERIC,
  puts_premium          NUMERIC,
  call_put_ratio        NUMERIC,
  premium_net           NUMERIC,
  cp_ratio_baseline_30d NUMERIC,
  cp_ratio_deviation    NUMERIC,
  is_unusual            BOOLEAN
)
LANGUAGE sql STABLE
SET search_path = public, extensions
AS $$
  WITH wl AS (
    SELECT UNNEST(ARRAY['SPY','QQQ','IWM','AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA']) AS t
  ),
  targets AS (
    SELECT t FROM wl
    WHERE p_ticker IS NULL OR t = UPPER(p_ticker)
  ),
  spots AS (
    SELECT s.ticker, s.spot
    FROM public.ct_ticker_snapshots s
    WHERE s.ticker IN (SELECT t FROM targets)
      AND s.spot IS NOT NULL
  ),
  -- Current window: p_window_min back from now
  cur AS (
    SELECT
      sf.ticker,
      substring(sf.option_symbol, length(sf.option_symbol) - 8, 1) AS side_char,
      sf.strike,
      sf.premium,
      sp.spot
    FROM public.ct_scored_flow sf
    JOIN spots sp ON sp.ticker = sf.ticker
    WHERE sf.event_ts >= now() - (p_window_min || ' min')::interval
      AND sf.classification IN ('opening_buy','opening_sell')
      AND sf.ticker IN (SELECT t FROM targets)
      AND sf.option_symbol IS NOT NULL
      AND length(sf.option_symbol) >= 9
      AND sf.strike IS NOT NULL
  ),
  cur_agg AS (
    SELECT
      c.ticker,
      COUNT(*) FILTER (WHERE c.side_char = 'C')::INTEGER AS calls_count,
      COUNT(*) FILTER (WHERE c.side_char = 'P')::INTEGER AS puts_count,
      COUNT(*) FILTER (WHERE c.side_char = 'C' AND c.strike >= c.spot * 0.995)::INTEGER AS calls_otm_count,
      COUNT(*) FILTER (WHERE c.side_char = 'C' AND c.strike <  c.spot * 0.995)::INTEGER AS calls_itm_count,
      COUNT(*) FILTER (WHERE c.side_char = 'P' AND c.strike <= c.spot * 1.005)::INTEGER AS puts_otm_count,
      COUNT(*) FILTER (WHERE c.side_char = 'P' AND c.strike >  c.spot * 1.005)::INTEGER AS puts_itm_count,
      COALESCE(SUM(c.premium) FILTER (WHERE c.side_char = 'C'), 0)::NUMERIC AS calls_premium,
      COALESCE(SUM(c.premium) FILTER (WHERE c.side_char = 'P'), 0)::NUMERIC AS puts_premium
    FROM cur c
    GROUP BY c.ticker
  ),
  -- 30d baseline: daily call:put ratios averaged. One ratio per ticker per day,
  -- then AVG across days. Skip days with <5 puts or <5 calls (noise floor).
  hist AS (
    SELECT
      sf.ticker,
      date_trunc('day', sf.event_ts) AS day_bucket,
      substring(sf.option_symbol, length(sf.option_symbol) - 8, 1) AS side_char
    FROM public.ct_scored_flow sf
    WHERE sf.event_ts >= now() - INTERVAL '30 days'
      AND sf.event_ts <  now() - (p_window_min || ' min')::interval
      AND sf.classification IN ('opening_buy','opening_sell')
      AND sf.ticker IN (SELECT t FROM targets)
      AND sf.option_symbol IS NOT NULL
      AND length(sf.option_symbol) >= 9
  ),
  hist_daily AS (
    SELECT
      h.ticker,
      h.day_bucket,
      COUNT(*) FILTER (WHERE h.side_char = 'C')::NUMERIC AS day_calls,
      COUNT(*) FILTER (WHERE h.side_char = 'P')::NUMERIC AS day_puts
    FROM hist h
    GROUP BY h.ticker, h.day_bucket
  ),
  hist_base AS (
    SELECT
      hd.ticker,
      AVG(hd.day_calls / GREATEST(hd.day_puts, 1))::NUMERIC AS baseline_ratio,
      SUM(hd.day_calls + hd.day_puts)::INTEGER AS baseline_events
    FROM hist_daily hd
    WHERE hd.day_calls >= 5 AND hd.day_puts >= 5
    GROUP BY hd.ticker
  )
  SELECT
    tg.t AS ticker,
    COALESCE(ca.calls_count, 0) AS calls_count,
    COALESCE(ca.puts_count, 0)  AS puts_count,
    COALESCE(ca.calls_otm_count, 0) AS calls_otm_count,
    COALESCE(ca.calls_itm_count, 0) AS calls_itm_count,
    COALESCE(ca.puts_otm_count, 0)  AS puts_otm_count,
    COALESCE(ca.puts_itm_count, 0)  AS puts_itm_count,
    COALESCE(ca.calls_premium, 0)   AS calls_premium,
    COALESCE(ca.puts_premium, 0)    AS puts_premium,
    (COALESCE(ca.calls_count, 0)::NUMERIC
      / GREATEST(COALESCE(ca.puts_count, 0), 1)) AS call_put_ratio,
    (COALESCE(ca.calls_premium, 0) - COALESCE(ca.puts_premium, 0)) AS premium_net,
    hb.baseline_ratio AS cp_ratio_baseline_30d,
    CASE
      WHEN hb.baseline_ratio IS NULL OR hb.baseline_ratio = 0 THEN NULL
      ELSE (COALESCE(ca.calls_count, 0)::NUMERIC
            / GREATEST(COALESCE(ca.puts_count, 0), 1))
           / hb.baseline_ratio
    END AS cp_ratio_deviation,
    (
      hb.baseline_ratio IS NOT NULL
      AND hb.baseline_ratio > 0
      AND (COALESCE(ca.calls_count, 0) + COALESCE(ca.puts_count, 0)) >= 20
      AND COALESCE(hb.baseline_events, 0) >= 20
      AND (
        ((COALESCE(ca.calls_count, 0)::NUMERIC
            / GREATEST(COALESCE(ca.puts_count, 0), 1)) / hb.baseline_ratio) >= 2.0
        OR
        ((COALESCE(ca.calls_count, 0)::NUMERIC
            / GREATEST(COALESCE(ca.puts_count, 0), 1)) / hb.baseline_ratio) <= 0.5
      )
    ) AS is_unusual
  FROM targets tg
  LEFT JOIN cur_agg ca  ON ca.ticker = tg.t
  LEFT JOIN hist_base hb ON hb.ticker = tg.t
  ORDER BY tg.t;
$$;

GRANT EXECUTE ON FUNCTION public.ct_flow_pulse(INT, TEXT) TO authenticated, service_role;

COMMENT ON FUNCTION public.ct_flow_pulse(INT, TEXT) IS
  'v2 FlowPulse: aggregate directional imbalance per watchlist ticker over p_window_min (default 360min=6h RTH). Counts, premium, call:put ratio, 30d baseline + deviation, is_unusual flag. Feeds specialists + /flow-pulse UI.';
