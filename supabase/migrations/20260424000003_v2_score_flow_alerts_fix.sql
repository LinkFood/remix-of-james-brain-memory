-- Extend ct_score_existing_flow to also iterate ct_flow_alerts rows
-- (not just ct_sweeps). The watchlist-focused per-ticker ingest added in
-- ct-flow-ingester writes to ct_flow_alerts. Without this change, those
-- rows never reached ct_scored_flow, and specialists had no wakeup events.
--
-- Columns extracted from ct_flow_alerts.raw (UW shape verified 2026-04-24):
--   total_ask_side_prem / total_bid_side_prem → ask_side_perc
--   has_sweep, has_floor, has_multileg → scoring flags
--   option_chain → OCC symbol (ct_flow_alerts.option_symbol is often null)
--   all_opening_trades → boosts opening_buy detection when true
--   type → 'call' | 'put' (normalize to 'C' | 'P')

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.ct_score_existing_flow(
  p_since TIMESTAMPTZ DEFAULT (now() - INTERVAL '2 hours')
) RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public, extensions
AS $$
DECLARE
  v_count   INTEGER := 0;
  v_wl      TEXT[] := ARRAY['SPY','QQQ','IWM','AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA'];
  r         RECORD;
  j         JSONB;
BEGIN
  -- ---- ct_sweeps ----
  FOR r IN
    SELECT
      id::TEXT AS source_id,
      ticker,
      option_symbol,
      strike,
      expiry,
      type AS side,
      premium,
      volume::integer AS volume,
      open_interest::integer AS open_interest,
      ask_side_perc,
      snapshot_at AS event_ts
    FROM public.ct_sweeps
    WHERE snapshot_at >= p_since
      AND ticker = ANY(v_wl)
      AND type IN ('C','P')
  LOOP
    j := public.ct_score_flow_event(
      r.ticker, r.option_symbol, r.strike, r.expiry,
      r.side, r.premium, r.volume, r.open_interest, r.ask_side_perc,
      r.event_ts,
      TRUE,   -- is_sweep
      FALSE,  -- is_multileg
      FALSE   -- is_floor
    );

    INSERT INTO public.ct_scored_flow (
      source_table, source_id, ticker, option_symbol, event_ts,
      classification, direction, score, raw_score,
      score_breakdown, penalty_breakdown,
      strike, expiry, dte, delta_est, premium, volume, open_interest, ask_side_perc,
      ticker_adv_30d, iv_rank_at_event
    )
    VALUES (
      'ct_sweeps', r.source_id, r.ticker, r.option_symbol, r.event_ts,
      (j->>'classification'), (j->>'direction'),
      (j->>'score')::numeric, (j->>'raw_score')::numeric,
      j->'breakdown', j->'penalty',
      r.strike, r.expiry,
      CASE WHEN r.expiry IS NOT NULL THEN (r.expiry - r.event_ts::date) END,
      (j->>'delta_est')::numeric,
      r.premium, r.volume, r.open_interest, r.ask_side_perc,
      NULL, (j->>'iv_rank')::numeric
    )
    ON CONFLICT (source_table, source_id) DO NOTHING;
    v_count := v_count + 1;
  END LOOP;

  -- ---- ct_flow_alerts ----
  -- Derive all scoring inputs from raw UW payload:
  --   ask_side_perc = 100 * ask_prem / (ask_prem + bid_prem)
  --   side = 'C'/'P' from type
  --   option_symbol falls back to raw.option_chain when column is null
  --   is_sweep / is_multileg / is_floor pulled straight from raw booleans
  FOR r IN
    SELECT
      alert_id AS source_id,
      ticker,
      COALESCE(option_symbol, raw->>'option_chain') AS option_symbol,
      strike,
      expiry,
      CASE
        WHEN lower(COALESCE(side, raw->>'type', '')) LIKE 'c%' THEN 'C'
        WHEN lower(COALESCE(side, raw->>'type', '')) LIKE 'p%' THEN 'P'
        ELSE NULL
      END AS side,
      premium,
      volume::integer AS volume,
      open_interest::integer AS open_interest,
      CASE
        WHEN (raw->>'total_ask_side_prem')::numeric IS NOT NULL
         AND (raw->>'total_bid_side_prem')::numeric IS NOT NULL
         AND ((raw->>'total_ask_side_prem')::numeric + (raw->>'total_bid_side_prem')::numeric) > 0
        THEN 100.0 * (raw->>'total_ask_side_prem')::numeric
             / ((raw->>'total_ask_side_prem')::numeric + (raw->>'total_bid_side_prem')::numeric)
        ELSE NULL
      END AS ask_side_perc,
      COALESCE(
        executed_at::timestamptz,
        (raw->>'created_at')::timestamptz,
        ingested_at
      ) AS event_ts,
      COALESCE((raw->>'has_sweep')::boolean, FALSE)    AS is_sweep,
      COALESCE((raw->>'has_multileg')::boolean, FALSE) AS is_multileg,
      COALESCE((raw->>'has_floor')::boolean, FALSE)    AS is_floor
    FROM public.ct_flow_alerts
    WHERE COALESCE(executed_at::timestamptz, ingested_at) >= p_since
      AND ticker = ANY(v_wl)
  LOOP
    -- Skip rows we couldn't classify (no side or no ask_side_perc signal)
    IF r.side IS NULL OR r.ask_side_perc IS NULL THEN
      CONTINUE;
    END IF;

    j := public.ct_score_flow_event(
      r.ticker, r.option_symbol, r.strike, r.expiry,
      r.side, r.premium, r.volume, r.open_interest, r.ask_side_perc,
      r.event_ts,
      r.is_sweep,
      r.is_multileg,
      r.is_floor
    );

    INSERT INTO public.ct_scored_flow (
      source_table, source_id, ticker, option_symbol, event_ts,
      classification, direction, score, raw_score,
      score_breakdown, penalty_breakdown,
      strike, expiry, dte, delta_est, premium, volume, open_interest, ask_side_perc,
      ticker_adv_30d, iv_rank_at_event
    )
    VALUES (
      'ct_flow_alerts', r.source_id, r.ticker, r.option_symbol, r.event_ts,
      (j->>'classification'), (j->>'direction'),
      (j->>'score')::numeric, (j->>'raw_score')::numeric,
      j->'breakdown', j->'penalty',
      r.strike, r.expiry,
      CASE WHEN r.expiry IS NOT NULL THEN (r.expiry - r.event_ts::date) END,
      (j->>'delta_est')::numeric,
      r.premium, r.volume, r.open_interest, r.ask_side_perc,
      NULL, (j->>'iv_rank')::numeric
    )
    ON CONFLICT (source_table, source_id) DO NOTHING;
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END $$;

GRANT EXECUTE ON FUNCTION public.ct_score_existing_flow(TIMESTAMPTZ) TO authenticated, service_role;
