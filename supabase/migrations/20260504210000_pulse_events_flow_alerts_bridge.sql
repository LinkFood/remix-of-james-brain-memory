-- Bridge ct_flow_alerts → ct_pulse_events.
--
-- Background. ct_pulse_events was originally fed by ct_sweeps (UW market-wide
-- sweep capture). The 2026-04-27 ingester split moved market-wide UW calls
-- from */3 to 0,30 — a deliberate 10× reduction for budget. Side effect:
-- ct_sweeps row counts collapsed from ~1,500/day pre-split to <50/day, then
-- to single digits today. Pulse v2's regime momentum is computed from
-- ct_pulse_events, so the per-ticker signals went silent.
--
-- ct_flow_alerts is now the canonical post-split flow stream — 1,283 rows
-- on 2026-05-04 RTH. It has everything pulse needs: ticker, executed_at,
-- side, premium, plus raw.total_ask_side_prem / total_bid_side_prem for
-- direction inference.
--
-- Direction mapping mirrors _shared/directionInference.ts canonical:
--   call + ask-aggressive  → bullish (+1)
--   call + bid-aggressive  → bearish (-1)
--   put  + ask-aggressive  → bearish (-1)
--   put  + bid-aggressive  → bullish (+1)
-- "Aggressive" = ask_prem > bid_prem (or vice versa). RepeatedHits inversion
-- (see feedback_direction_inference_repeatedhits_put_inverted.md) is handled
-- in the TS shared helper — we don't replicate that here. The handful of
-- mis-tagged RepeatedHits flows in pulse_events is acceptable noise relative
-- to having the per-ticker stream alive at all. If RepeatedHits skew ever
-- shows up in observed_patterns, revisit.
--
-- Idempotent: ON CONFLICT (source_table, source_id) DO NOTHING.
-- source_table='ct_flow_alerts', source_id=alert_id. Will not double-insert
-- with the existing ct_sweeps source rows since source_table differs.

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.ct_populate_pulse_events(
  p_since TIMESTAMPTZ DEFAULT (now() - INTERVAL '2 hours')
) RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  v_inserted INT := 0;
  v_wl TEXT[] := ARRAY['SPY','QQQ','IWM','AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA'];
BEGIN
  -- ---------- SWEEPS (legacy ct_sweeps source — kept in case capture restores) ----------
  INSERT INTO public.ct_pulse_events (
    ticker, event_ts, signal_type, signal_subtype, direction,
    base_weight, magnitude_mult, usd_weight, source_table, source_id
  )
  SELECT
    CASE WHEN ticker = 'SPX' THEN 'SPY' ELSE ticker END,
    snapshot_at,
    'sweep',
    CASE
      WHEN premium >= 500000 THEN 'whale'
      WHEN premium >= 100000 THEN 'large'
      ELSE 'small'
    END,
    CASE
      WHEN type = 'C' AND ask_side_perc >= 55 THEN  1
      WHEN type = 'C' AND ask_side_perc <= 45 THEN -1
      WHEN type = 'P' AND ask_side_perc <= 45 THEN  1
      WHEN type = 'P' AND ask_side_perc >= 55 THEN -1
      ELSE 0
    END,
    CASE
      WHEN premium >= 500000 THEN 0.7
      WHEN premium >= 100000 THEN 0.5
      ELSE 0.1
    END,
    CASE
      WHEN premium >= 25000000 THEN 4.0
      WHEN premium >=  5000000 THEN 3.0
      WHEN premium >=  1000000 THEN 2.0
      WHEN premium >=   100000 THEN 1.0
      ELSE 0.5
    END,
    premium,
    'ct_sweeps',
    id::TEXT
  FROM public.ct_sweeps
  WHERE snapshot_at >= p_since
    AND (ticker = ANY(v_wl) OR ticker = 'SPX')
    AND type IN ('C','P')
    AND ask_side_perc IS NOT NULL
    AND (ask_side_perc >= 55 OR ask_side_perc <= 45)
    AND premium IS NOT NULL
  ON CONFLICT (source_table, source_id) DO NOTHING;

  -- ---------- FLOW ALERTS (post-2026-04-27 canonical flow source) ----------
  INSERT INTO public.ct_pulse_events (
    ticker, event_ts, signal_type, signal_subtype, direction,
    base_weight, magnitude_mult, usd_weight, source_table, source_id
  )
  SELECT
    CASE WHEN ticker = 'SPX' THEN 'SPY' ELSE ticker END,
    COALESCE(executed_at, ingested_at),
    'sweep',  -- semantic: a directional flow alert IS a sweep signal for pulse
    CASE
      WHEN premium >= 500000 THEN 'whale'
      WHEN premium >= 100000 THEN 'large'
      ELSE 'small'
    END,
    -- direction from total_ask_side_prem vs total_bid_side_prem + side
    CASE
      WHEN side = 'call'
        AND COALESCE((raw->>'total_ask_side_prem')::NUMERIC, 0)
          > COALESCE((raw->>'total_bid_side_prem')::NUMERIC, 0)
        THEN  1
      WHEN side = 'call'
        AND COALESCE((raw->>'total_bid_side_prem')::NUMERIC, 0)
          > COALESCE((raw->>'total_ask_side_prem')::NUMERIC, 0)
        THEN -1
      WHEN side = 'put'
        AND COALESCE((raw->>'total_ask_side_prem')::NUMERIC, 0)
          > COALESCE((raw->>'total_bid_side_prem')::NUMERIC, 0)
        THEN -1
      WHEN side = 'put'
        AND COALESCE((raw->>'total_bid_side_prem')::NUMERIC, 0)
          > COALESCE((raw->>'total_ask_side_prem')::NUMERIC, 0)
        THEN  1
      ELSE 0
    END,
    CASE
      WHEN premium >= 500000 THEN 0.7
      WHEN premium >= 100000 THEN 0.5
      ELSE 0.1
    END,
    CASE
      WHEN premium >= 25000000 THEN 4.0
      WHEN premium >=  5000000 THEN 3.0
      WHEN premium >=  1000000 THEN 2.0
      WHEN premium >=   100000 THEN 1.0
      ELSE 0.5
    END,
    premium,
    'ct_flow_alerts',
    alert_id
  FROM public.ct_flow_alerts
  WHERE COALESCE(executed_at, ingested_at) >= p_since
    AND ticker = ANY(v_wl)
    AND side IN ('call','put')
    AND premium IS NOT NULL
    AND premium > 0
  ON CONFLICT (source_table, source_id) DO NOTHING;

  -- ---------- NEWS ----------
  INSERT INTO public.ct_pulse_events (
    ticker, event_ts, signal_type, signal_subtype, direction,
    base_weight, magnitude_mult, usd_weight, source_table, source_id
  )
  SELECT
    CASE WHEN instrument = 'SPX' THEN 'SPY' ELSE instrument END,
    created_at,
    'news',
    COALESCE(news_source, 'unknown'),
    CASE impact WHEN 'bullish' THEN 1 WHEN 'bearish' THEN -1 ELSE 0 END,
    CASE
      WHEN significance >= 4 THEN 0.7
      WHEN significance = 3  THEN 0.4
      WHEN significance = 2  THEN 0.3
      ELSE 0.05
    END,
    CASE
      WHEN significance >= 4 THEN 2.0
      WHEN significance = 3  THEN 1.5
      WHEN significance = 2  THEN 1.0
      ELSE 0.5
    END,
    NULL,
    'ct_news_analyses',
    id::TEXT
  FROM public.ct_news_analyses
  WHERE created_at >= p_since
    AND (instrument = ANY(v_wl) OR instrument = 'SPX')
    AND impact IN ('bullish','bearish','neutral','mixed')
  ON CONFLICT (source_table, source_id) DO NOTHING;

  -- ---------- INSIDER TRADES ----------
  INSERT INTO public.ct_pulse_events (
    ticker, event_ts, signal_type, signal_subtype, direction,
    base_weight, magnitude_mult, usd_weight, source_table, source_id
  )
  SELECT
    ticker,
    COALESCE(trade_date::timestamptz, filing_date::timestamptz),
    'insider',
    COALESCE(transaction_type, 'unknown'),
    CASE
      WHEN upper(transaction_type) LIKE 'P%' OR upper(transaction_type) LIKE 'BUY%' OR upper(transaction_type) LIKE 'A%' THEN 1
      WHEN upper(transaction_type) LIKE 'S%' OR upper(transaction_type) LIKE 'SELL%' OR upper(transaction_type) LIKE 'D%' THEN -1
      ELSE 0
    END,
    CASE
      WHEN upper(transaction_type) LIKE 'P%' OR upper(transaction_type) LIKE 'BUY%' OR upper(transaction_type) LIKE 'A%' THEN 1.0
      ELSE 0.3
    END,
    CASE
      WHEN value_usd >= 10000000 THEN 4.0
      WHEN value_usd >=  1000000 THEN 3.0
      WHEN value_usd >=   100000 THEN 2.0
      WHEN value_usd >=    10000 THEN 1.0
      ELSE 0.5
    END,
    value_usd,
    'ct_insider_trades',
    id::TEXT
  FROM public.ct_insider_trades
  WHERE COALESCE(trade_date::timestamptz, filing_date::timestamptz) >= p_since
    AND ticker = ANY(v_wl)
    AND transaction_type IS NOT NULL
  ON CONFLICT (source_table, source_id) DO NOTHING;

  -- ---------- CONGRESS TRADES ----------
  INSERT INTO public.ct_pulse_events (
    ticker, event_ts, signal_type, signal_subtype, direction,
    base_weight, magnitude_mult, usd_weight, source_table, source_id
  )
  SELECT
    ticker,
    (traded_at::timestamp AT TIME ZONE 'UTC') + INTERVAL '14 hours',
    'congress',
    COALESCE(chamber, 'unknown'),
    CASE
      WHEN lower(side) LIKE 'buy%' THEN 1
      WHEN lower(side) LIKE 'sale%' OR lower(side) LIKE 'sell%' THEN -1
      ELSE 0
    END,
    0.4,
    CASE
      WHEN amount_band_usd ILIKE '%1,000,001%'     THEN 4.0
      WHEN amount_band_usd ILIKE '%500,001 - %'    THEN 3.0
      WHEN amount_band_usd ILIKE '%100,001 - %'    THEN 2.0
      WHEN amount_band_usd ILIKE '%50,001 - %'     THEN 1.5
      WHEN amount_band_usd ILIKE '%15,001 - %'     THEN 1.0
      ELSE 0.5
    END,
    NULL,
    'ct_political_trades',
    id::TEXT
  FROM public.ct_political_trades
  WHERE traded_at >= (p_since AT TIME ZONE 'UTC')::date - 1
    AND ticker = ANY(v_wl)
    AND side IS NOT NULL
  ON CONFLICT (source_table, source_id) DO NOTHING;

  -- ---------- CLAUDE ALERTS ----------
  INSERT INTO public.ct_pulse_events (
    ticker, event_ts, signal_type, signal_subtype, direction,
    base_weight, magnitude_mult, usd_weight, source_table, source_id
  )
  SELECT
    CASE WHEN inst = 'SPX' THEN 'SPY' ELSE inst END,
    created_at,
    'claude_alert',
    'conv' || conviction::text,
    CASE direction WHEN 'bullish' THEN 1 WHEN 'bearish' THEN -1 ELSE 0 END,
    CASE
      WHEN conviction = 5 THEN 0.6
      WHEN conviction = 4 THEN 0.4
      WHEN conviction = 3 THEN 0.25
      ELSE 0.1
    END,
    1.0,
    NULL,
    'ct_alerts',
    id::text || ':' || inst
  FROM public.ct_alerts, unnest(instruments) AS inst
  WHERE created_at >= p_since
    AND (inst = ANY(v_wl) OR inst = 'SPX')
    AND direction IN ('bullish','bearish','neutral')
    AND conviction IS NOT NULL
  ON CONFLICT (source_table, source_id) DO NOTHING;

  SELECT count(*) INTO v_inserted
  FROM public.ct_pulse_events
  WHERE ingested_at >= now() - INTERVAL '1 minute';

  RETURN v_inserted;
END $$;

-- One-time backfill of today's RTH so the per-ticker pulse signals come alive
-- the moment this migration lands. After this, the existing ct-pulse-tick cron
-- (every 5 min RTH) keeps the bridge fed.
SELECT public.ct_pulse_tick();
