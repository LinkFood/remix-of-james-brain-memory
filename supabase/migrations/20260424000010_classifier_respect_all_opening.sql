-- Classifier fix v3: respect UW's `all_opening_trades` signal.
--
-- UW exposes a boolean `all_opening_trades` on each flow-alert row that
-- tells us whether the prints making up this alert are all opening
-- (new positioning) or include closings. We were ignoring it and
-- inferring intent from ask/bid alone — which mis-called closings
-- as "opening_sell".
--
-- James caught a META 260515 700C: 100% bid-side, $929K, 1302 vol on
-- 8590 OI, `raw.all_opening_trades = false`. Our classifier said
-- "opening_sell" (someone short-writing calls). UW's flag says it's
-- NOT opening, so it's actually a long being closed — "closing".
--
-- New hierarchy:
--   multileg/floor       → hedge
--   all_opening = TRUE:
--     ask-dominant       → opening_buy
--     bid-dominant       → opening_sell
--     balanced           → ambiguous
--   all_opening = FALSE:
--     bid-dominant       → closing (selling-to-close a long)
--     ask-dominant       → closing (buying-to-close a short — rare)
--     balanced           → closing
--   all_opening IS NULL (no signal — legacy data):
--     ask >= threshold                 → opening_buy
--     ask <= (100 - threshold) AND V/OI < 0.1 → closing
--     ask <= (100 - threshold)         → opening_sell
--     balanced                          → ambiguous

SET search_path = public, extensions;

-- Signature changes: add p_all_opening BOOLEAN param at the end.
-- Drop old function so PL doesn't create both signatures.
DROP FUNCTION IF EXISTS public.ct_score_flow_event(
  TEXT, TEXT, NUMERIC, DATE, TEXT, NUMERIC, INTEGER, INTEGER, NUMERIC,
  TIMESTAMPTZ, BOOLEAN, BOOLEAN, BOOLEAN);

CREATE OR REPLACE FUNCTION public.ct_score_flow_event(
  p_ticker          TEXT,
  p_option_symbol   TEXT,
  p_strike          NUMERIC,
  p_expiry          DATE,
  p_side            TEXT,
  p_premium         NUMERIC,
  p_volume          INTEGER,
  p_open_interest   INTEGER,
  p_ask_side_perc   NUMERIC,
  p_event_ts        TIMESTAMPTZ,
  p_is_sweep        BOOLEAN DEFAULT FALSE,
  p_is_multileg     BOOLEAN DEFAULT FALSE,
  p_is_floor        BOOLEAN DEFAULT FALSE,
  p_all_opening     BOOLEAN DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql STABLE
SET search_path = public, extensions
AS $$
DECLARE
  v_normalized_side   TEXT;
  v_classification    TEXT;
  v_direction         TEXT;
  v_dte               INTEGER;
  v_spot              NUMERIC;
  v_iv_rank           NUMERIC;
  v_ask_thresh        NUMERIC;

  f_opening_buy       NUMERIC := 0;
  f_t1_oi_confirm     NUMERIC := 0;
  f_single_direction  NUMERIC := 0;
  f_dte               NUMERIC := 0;
  f_delta             NUMERIC := 0;
  f_iv_context        NUMERIC := 0;
  f_size_vs_adv       NUMERIC := 0;

  p_hedge             NUMERIC := 0;
  p_earnings          NUMERIC := 0;
  p_expiration        NUMERIC := 0;
  p_dealer_hedge      NUMERIC := 0;

  v_delta_est         NUMERIC;

  v_raw_score         NUMERIC;
  v_total_penalty     NUMERIC;
  v_score             NUMERIC;
BEGIN
  v_ask_thresh := getConfigVal('score.opening_buy_ask_threshold', 60);
  IF v_ask_thresh <= 1 THEN v_ask_thresh := v_ask_thresh * 100; END IF;

  v_normalized_side := CASE
    WHEN upper(COALESCE(p_side, '')) IN ('C','CALL') THEN 'C'
    WHEN upper(COALESCE(p_side, '')) IN ('P','PUT')  THEN 'P'
    ELSE NULL
  END;

  IF p_expiry IS NOT NULL THEN
    v_dte := GREATEST(0, (p_expiry - p_event_ts::date));
  END IF;

  SELECT spot, iv_rank INTO v_spot, v_iv_rank
  FROM public.ct_ticker_snapshots
  WHERE ticker = p_ticker;

  -- ---- Classification ----
  IF p_is_multileg OR p_is_floor THEN
    v_classification := 'hedge';
  ELSIF p_all_opening IS FALSE THEN
    -- UW told us this is NOT an opening trade. It's a close regardless
    -- of which side of the book got hit.
    v_classification := 'closing';
  ELSIF p_all_opening IS TRUE THEN
    -- UW confirms opening. Ask/bid determines buy vs sell.
    IF p_ask_side_perc IS NOT NULL AND p_ask_side_perc >= v_ask_thresh THEN
      v_classification := 'opening_buy';
    ELSIF p_ask_side_perc IS NOT NULL AND p_ask_side_perc <= (100 - v_ask_thresh) THEN
      v_classification := 'opening_sell';
    ELSE
      v_classification := 'ambiguous';
    END IF;
  ELSE
    -- No signal from UW on opening/closing. Fall back to ask/bid +
    -- V/OI heuristic. (This path serves legacy rows / missing raw.)
    IF p_ask_side_perc IS NULL THEN
      v_classification := 'ambiguous';
    ELSIF p_ask_side_perc >= v_ask_thresh THEN
      v_classification := 'opening_buy';
    ELSIF p_ask_side_perc <= (100 - v_ask_thresh) THEN
      IF p_open_interest IS NOT NULL AND p_open_interest > 0
         AND p_volume IS NOT NULL
         AND (p_volume::numeric / p_open_interest::numeric) < 0.1 THEN
        v_classification := 'closing';
      ELSE
        v_classification := 'opening_sell';
      END IF;
    ELSE
      v_classification := 'ambiguous';
    END IF;
  END IF;

  -- ---- Direction ----
  v_direction := CASE
    WHEN v_normalized_side = 'C' AND v_classification = 'opening_buy'  THEN 'bullish'
    WHEN v_normalized_side = 'C' AND v_classification = 'opening_sell' THEN 'bearish'
    WHEN v_normalized_side = 'P' AND v_classification = 'opening_buy'  THEN 'bearish'
    WHEN v_normalized_side = 'P' AND v_classification = 'opening_sell' THEN 'bullish'
    ELSE 'neutral'
  END;

  -- ---- opening_buy factor (25) ----
  IF p_ask_side_perc IS NOT NULL AND p_ask_side_perc >= v_ask_thresh THEN
    f_opening_buy := f_opening_buy + 10;
  END IF;
  IF p_volume IS NOT NULL AND p_open_interest IS NOT NULL AND p_volume > p_open_interest THEN
    f_opening_buy := f_opening_buy + 10;
  END IF;
  IF NOT p_is_multileg THEN f_opening_buy := f_opening_buy + 2.5; END IF;
  IF NOT p_is_floor THEN f_opening_buy := f_opening_buy + 2.5; END IF;

  -- ---- single_direction (15) ----
  IF p_ask_side_perc IS NOT NULL THEN
    IF p_ask_side_perc >= 85 OR p_ask_side_perc <= 15 THEN
      f_single_direction := 15;
    ELSIF p_ask_side_perc >= 70 OR p_ask_side_perc <= 30 THEN
      f_single_direction := 10;
    ELSIF p_ask_side_perc >= 60 OR p_ask_side_perc <= 40 THEN
      f_single_direction := 5;
    END IF;
  END IF;

  -- ---- dte (15) ----
  IF v_dte IS NOT NULL THEN
    IF v_dte BETWEEN 15 AND 45 THEN f_dte := 15;
    ELSIF v_dte BETWEEN 7 AND 90 THEN f_dte := 10;
    ELSIF v_dte BETWEEN 1 AND 180 THEN f_dte := 5; END IF;
  END IF;

  -- ---- delta (10) via moneyness proxy ----
  IF v_spot IS NOT NULL AND p_strike IS NOT NULL AND v_spot > 0 THEN
    v_delta_est := CASE
      WHEN v_normalized_side = 'C' THEN
        CASE
          WHEN p_strike <= v_spot * 0.95 THEN 0.70
          WHEN p_strike <= v_spot * 1.00 THEN 0.55
          WHEN p_strike <= v_spot * 1.05 THEN 0.40
          WHEN p_strike <= v_spot * 1.15 THEN 0.25
          ELSE 0.10
        END
      WHEN v_normalized_side = 'P' THEN
        CASE
          WHEN p_strike >= v_spot * 1.05 THEN -0.70
          WHEN p_strike >= v_spot * 1.00 THEN -0.55
          WHEN p_strike >= v_spot * 0.95 THEN -0.40
          WHEN p_strike >= v_spot * 0.85 THEN -0.25
          ELSE -0.10
        END
      ELSE NULL
    END;
    IF v_delta_est IS NOT NULL THEN
      IF ABS(v_delta_est) BETWEEN 0.20 AND 0.70 THEN f_delta := 10;
      ELSIF ABS(v_delta_est) BETWEEN 0.10 AND 0.80 THEN f_delta := 5; END IF;
    END IF;
  END IF;

  -- ---- iv_context (10) ----
  IF v_iv_rank IS NOT NULL THEN
    IF v_iv_rank <= 30 OR v_iv_rank >= 70 THEN f_iv_context := 10;
    ELSIF v_iv_rank <= 40 OR v_iv_rank >= 60 THEN f_iv_context := 5; END IF;
  END IF;

  -- ---- size_vs_adv (10) ----
  IF p_premium IS NOT NULL THEN
    WITH b AS (
      SELECT options_adv_30d FROM public.ct_ticker_baselines
      WHERE ticker = p_ticker ORDER BY baseline_date DESC LIMIT 1
    )
    SELECT
      CASE
        WHEN options_adv_30d IS NULL OR options_adv_30d = 0 THEN 0
        WHEN p_premium >= options_adv_30d * 3 THEN 10
        WHEN p_premium >= options_adv_30d * 1.5 THEN 7.5
        WHEN p_premium >= options_adv_30d THEN 5
        WHEN p_premium >= options_adv_30d * 0.5 THEN 2.5
        ELSE 0
      END
    INTO f_size_vs_adv FROM b;
    f_size_vs_adv := COALESCE(f_size_vs_adv, 0);
  END IF;

  -- ---- Penalties ----
  IF v_classification = 'hedge' THEN p_hedge := 10; END IF;
  IF v_classification = 'closing' THEN p_hedge := 15; END IF;  -- closing trades aren't a signal
  IF v_dte IS NOT NULL AND v_dte <= 1 THEN p_expiration := 5; END IF;

  v_raw_score := f_opening_buy + f_t1_oi_confirm + f_single_direction
                 + f_dte + f_delta + f_iv_context + f_size_vs_adv;
  v_total_penalty := p_hedge + p_earnings + p_expiration + p_dealer_hedge;
  v_score := GREATEST(0, LEAST(100, v_raw_score - v_total_penalty));

  RETURN jsonb_build_object(
    'classification', v_classification,
    'direction',      v_direction,
    'score',          v_score,
    'raw_score',      v_raw_score,
    'delta_est',      v_delta_est,
    'iv_rank',        v_iv_rank,
    'breakdown', jsonb_build_object(
      'opening_buy',      f_opening_buy,
      't1_oi_confirm',    f_t1_oi_confirm,
      'single_direction', f_single_direction,
      'dte',              f_dte,
      'delta',            f_delta,
      'iv_context',       f_iv_context,
      'size_vs_adv',      f_size_vs_adv
    ),
    'penalty', jsonb_build_object(
      'hedge',        p_hedge,
      'earnings',     p_earnings,
      'expiration',   p_expiration,
      'dealer_hedge', p_dealer_hedge
    )
  );
END
$$;

GRANT EXECUTE ON FUNCTION public.ct_score_flow_event(
  TEXT, TEXT, NUMERIC, DATE, TEXT, NUMERIC, INTEGER, INTEGER, NUMERIC,
  TIMESTAMPTZ, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN) TO authenticated, service_role;

-- Update ct_score_existing_flow to pass raw.all_opening_trades through.
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
  -- ct_sweeps (always opening by definition — sweeps are aggressive new flow)
  FOR r IN
    SELECT id::TEXT AS source_id, ticker, option_symbol, strike, expiry,
           type AS side, premium, volume::integer AS volume,
           open_interest::integer AS open_interest, ask_side_perc,
           snapshot_at AS event_ts
    FROM public.ct_sweeps
    WHERE snapshot_at >= p_since AND ticker = ANY(v_wl) AND type IN ('C','P')
  LOOP
    j := public.ct_score_flow_event(
      r.ticker, r.option_symbol, r.strike, r.expiry,
      r.side, r.premium, r.volume, r.open_interest, r.ask_side_perc,
      r.event_ts, TRUE, FALSE, FALSE, TRUE
    );
    INSERT INTO public.ct_scored_flow (
      source_table, source_id, ticker, option_symbol, event_ts,
      classification, direction, score, raw_score,
      score_breakdown, penalty_breakdown,
      strike, expiry, dte, delta_est, premium, volume, open_interest, ask_side_perc,
      ticker_adv_30d, iv_rank_at_event
    ) VALUES (
      'ct_sweeps', r.source_id, r.ticker, r.option_symbol, r.event_ts,
      (j->>'classification'), (j->>'direction'),
      (j->>'score')::numeric, (j->>'raw_score')::numeric,
      j->'breakdown', j->'penalty',
      r.strike, r.expiry,
      CASE WHEN r.expiry IS NOT NULL THEN (r.expiry - r.event_ts::date) END,
      (j->>'delta_est')::numeric,
      r.premium, r.volume, r.open_interest, r.ask_side_perc,
      NULL, (j->>'iv_rank')::numeric
    ) ON CONFLICT (source_table, source_id) DO NOTHING;
    v_count := v_count + 1;
  END LOOP;

  -- ct_flow_alerts
  FOR r IN
    SELECT
      alert_id AS source_id, ticker,
      COALESCE(option_symbol, raw->>'option_chain') AS option_symbol,
      strike, expiry,
      CASE
        WHEN lower(COALESCE(side, raw->>'type', '')) LIKE 'c%' THEN 'C'
        WHEN lower(COALESCE(side, raw->>'type', '')) LIKE 'p%' THEN 'P'
        ELSE NULL
      END AS side,
      premium, volume::integer AS volume,
      open_interest::integer AS open_interest,
      CASE
        WHEN (raw->>'total_ask_side_prem')::numeric IS NOT NULL
         AND (raw->>'total_bid_side_prem')::numeric IS NOT NULL
         AND ((raw->>'total_ask_side_prem')::numeric + (raw->>'total_bid_side_prem')::numeric) > 0
        THEN 100.0 * (raw->>'total_ask_side_prem')::numeric
             / ((raw->>'total_ask_side_prem')::numeric + (raw->>'total_bid_side_prem')::numeric)
        ELSE NULL
      END AS ask_side_perc,
      COALESCE(executed_at::timestamptz, (raw->>'created_at')::timestamptz, ingested_at) AS event_ts,
      COALESCE((raw->>'has_sweep')::boolean, FALSE)    AS is_sweep,
      COALESCE((raw->>'has_multileg')::boolean, FALSE) AS is_multileg,
      COALESCE((raw->>'has_floor')::boolean, FALSE)    AS is_floor,
      (raw->>'all_opening_trades')::boolean            AS all_opening
    FROM public.ct_flow_alerts
    WHERE COALESCE(executed_at::timestamptz, ingested_at) >= p_since
      AND ticker = ANY(v_wl)
  LOOP
    IF r.side IS NULL THEN CONTINUE; END IF;

    j := public.ct_score_flow_event(
      r.ticker, r.option_symbol, r.strike, r.expiry,
      r.side, r.premium, r.volume, r.open_interest, r.ask_side_perc,
      r.event_ts, r.is_sweep, r.is_multileg, r.is_floor, r.all_opening
    );

    INSERT INTO public.ct_scored_flow (
      source_table, source_id, ticker, option_symbol, event_ts,
      classification, direction, score, raw_score,
      score_breakdown, penalty_breakdown,
      strike, expiry, dte, delta_est, premium, volume, open_interest, ask_side_perc,
      ticker_adv_30d, iv_rank_at_event
    ) VALUES (
      'ct_flow_alerts', r.source_id, r.ticker, r.option_symbol, r.event_ts,
      (j->>'classification'), (j->>'direction'),
      (j->>'score')::numeric, (j->>'raw_score')::numeric,
      j->'breakdown', j->'penalty',
      r.strike, r.expiry,
      CASE WHEN r.expiry IS NOT NULL THEN (r.expiry - r.event_ts::date) END,
      (j->>'delta_est')::numeric,
      r.premium, r.volume, r.open_interest, r.ask_side_perc,
      NULL, (j->>'iv_rank')::numeric
    ) ON CONFLICT (source_table, source_id) DO NOTHING;
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END $$;

GRANT EXECUTE ON FUNCTION public.ct_score_existing_flow(TIMESTAMPTZ) TO authenticated, service_role;
