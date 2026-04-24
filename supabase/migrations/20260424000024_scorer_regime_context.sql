-- Wire regime context into ct_score_flow_event + downstream writers.
--
-- TAGGING ONLY in this pass. We compute:
--   v_spot_at_event       — 1m bar closest to event_ts within ±30 min
--   v_prev_close          — last bar before event_ts::date (up to 5 trading days back)
--   v_today_open          — first bar on event_ts::date (or 13:30-14:00 UTC window fallback)
--   spot_pct_from_prev_close = (spot - prev_close) / prev_close * 100
--   spot_pct_from_today_open = (spot - today_open) / today_open * 100
--
-- Returned JSONB gains:
--   top-level: "spot_pct_from_prev_close", "spot_pct_from_today_open" (nullable)
--   breakdown.regime: { spot, prev_close, today_open, pct_from_prev_close, pct_from_today_open }
--
-- Preserved verbatim from 20260424000021_scorer_t1_oi_wire:
--   • T+1 OI confirmation (18h age gate, ±100 noise floor, status tag)
--   • classifier rules (20260424000011_classifier_trust_only_true)
--   • all 7 factor slots + 4 penalty slots
--   • score arithmetic: GREATEST(0, LEAST(100, raw - penalties))
--
-- NO SCORING MATH CHANGES. Regime is data-only; Tier 3 weighting lands after
-- tonight's MFE calibration run proves it as the direction discriminator.
--
-- Also updates:
--   • ct_score_existing_flow (inserter) — writes new columns on fresh rows
--   • ct_rescore_flow_since (updater)   — backfills existing rows
-- Without these the scorer would emit regime JSON but the columns would stay
-- NULL — defeats the whole point of the tagging pass.

SET search_path = public, extensions;

-- ============================================================================
-- 1. ct_score_flow_event — regime-aware scorer
-- ============================================================================

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
  v_vol_oi_ratio      NUMERIC;

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

  -- T+1 OI lookup state
  v_t1_oi_delta       INTEGER;
  v_t1_oi_snap_id     BIGINT;
  v_t1_oi_status      TEXT := 'unavailable';
  v_t1_age_hours      NUMERIC;

  -- Regime context state
  v_spot_at_event     NUMERIC;
  v_prev_close        NUMERIC;
  v_today_open        NUMERIC;
  v_pct_from_prev     NUMERIC;
  v_pct_from_open     NUMERIC;
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

  IF p_volume IS NOT NULL AND p_open_interest IS NOT NULL AND p_open_interest > 0 THEN
    v_vol_oi_ratio := p_volume::numeric / p_open_interest::numeric;
  END IF;

  SELECT spot, iv_rank INTO v_spot, v_iv_rank
  FROM public.ct_ticker_snapshots WHERE ticker = p_ticker;

  -- ---- Classification ----
  IF p_is_multileg OR p_is_floor THEN
    v_classification := 'hedge';
  ELSIF p_all_opening IS TRUE THEN
    IF p_ask_side_perc IS NOT NULL AND p_ask_side_perc >= v_ask_thresh THEN
      v_classification := 'opening_buy';
    ELSIF p_ask_side_perc IS NOT NULL AND p_ask_side_perc <= (100 - v_ask_thresh) THEN
      v_classification := 'opening_sell';
    ELSE
      v_classification := 'ambiguous';
    END IF;
  ELSIF p_ask_side_perc IS NULL THEN
    v_classification := 'ambiguous';
  ELSIF p_ask_side_perc >= v_ask_thresh THEN
    v_classification := 'opening_buy';
  ELSIF p_ask_side_perc <= (100 - v_ask_thresh) THEN
    IF v_vol_oi_ratio IS NOT NULL AND v_vol_oi_ratio < 0.1 THEN
      v_classification := 'closing';
    ELSIF v_vol_oi_ratio IS NOT NULL AND v_vol_oi_ratio <= 0.5 THEN
      v_classification := 'ambiguous';
    ELSE
      v_classification := 'opening_sell';
    END IF;
  ELSE
    v_classification := 'ambiguous';
  END IF;

  v_direction := CASE
    WHEN v_normalized_side = 'C' AND v_classification = 'opening_buy'  THEN 'bullish'
    WHEN v_normalized_side = 'C' AND v_classification = 'opening_sell' THEN 'bearish'
    WHEN v_normalized_side = 'P' AND v_classification = 'opening_buy'  THEN 'bearish'
    WHEN v_normalized_side = 'P' AND v_classification = 'opening_sell' THEN 'bullish'
    ELSE 'neutral'
  END;

  -- ---- opening_buy factor (25) ----
  IF p_ask_side_perc IS NOT NULL AND p_ask_side_perc >= v_ask_thresh THEN f_opening_buy := f_opening_buy + 10; END IF;
  IF p_volume IS NOT NULL AND p_open_interest IS NOT NULL AND p_volume > p_open_interest THEN f_opening_buy := f_opening_buy + 10; END IF;
  IF NOT p_is_multileg THEN f_opening_buy := f_opening_buy + 2.5; END IF;
  IF NOT p_is_floor THEN f_opening_buy := f_opening_buy + 2.5; END IF;

  -- ---- T+1 OI confirmation (20) — live-wired from ct_oi_snapshots ----
  v_t1_age_hours := EXTRACT(EPOCH FROM (now() - p_event_ts)) / 3600.0;

  IF p_option_symbol IS NOT NULL
     AND v_t1_age_hours >= 18
     AND v_classification IN ('opening_buy','opening_sell') THEN
    SELECT s.id, s.oi_delta_1d
      INTO v_t1_oi_snap_id, v_t1_oi_delta
    FROM public.ct_oi_snapshots s
    WHERE s.option_symbol = p_option_symbol
      AND s.oi_delta_1d IS NOT NULL
      AND s.snap_date >= p_event_ts::date
    ORDER BY s.snap_date ASC,
      CASE s.snap_slot WHEN 'open' THEN 1 WHEN 'mid' THEN 2 WHEN 'close' THEN 3 ELSE 0 END ASC
    LIMIT 1;

    IF v_t1_oi_delta IS NOT NULL AND ABS(v_t1_oi_delta) >= 100 THEN
      IF v_classification = 'opening_buy' AND v_t1_oi_delta > 0 THEN
        f_t1_oi_confirm := 20;
        v_t1_oi_status  := 'confirmed';
      ELSIF v_classification = 'opening_sell' AND v_t1_oi_delta < 0 THEN
        f_t1_oi_confirm := 20;
        v_t1_oi_status  := 'confirmed';
      ELSIF v_classification = 'opening_buy' AND v_t1_oi_delta < 0 THEN
        f_t1_oi_confirm := -10;
        v_t1_oi_status  := 'contradicted';
      ELSIF v_classification = 'opening_sell' AND v_t1_oi_delta > 0 THEN
        f_t1_oi_confirm := -10;
        v_t1_oi_status  := 'contradicted';
      END IF;
    END IF;
  END IF;

  -- ---- single_direction (15) ----
  IF p_ask_side_perc IS NOT NULL THEN
    IF p_ask_side_perc >= 85 OR p_ask_side_perc <= 15 THEN f_single_direction := 15;
    ELSIF p_ask_side_perc >= 70 OR p_ask_side_perc <= 30 THEN f_single_direction := 10;
    ELSIF p_ask_side_perc >= 60 OR p_ask_side_perc <= 40 THEN f_single_direction := 5; END IF;
  END IF;

  -- ---- dte (15) ----
  IF v_dte IS NOT NULL THEN
    IF v_dte BETWEEN 15 AND 45 THEN f_dte := 15;
    ELSIF v_dte BETWEEN 7 AND 90 THEN f_dte := 10;
    ELSIF v_dte BETWEEN 1 AND 180 THEN f_dte := 5; END IF;
  END IF;

  -- ---- delta (10) ----
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
      END INTO f_size_vs_adv FROM b;
    f_size_vs_adv := COALESCE(f_size_vs_adv, 0);
  END IF;

  -- ---- Penalties ----
  IF v_classification = 'hedge' THEN p_hedge := 10; END IF;
  IF v_classification = 'closing' THEN p_hedge := 15; END IF;
  IF v_classification = 'ambiguous' THEN p_hedge := 10; END IF;
  IF v_dte IS NOT NULL AND v_dte <= 1 THEN p_expiration := 5; END IF;

  v_raw_score := f_opening_buy + f_t1_oi_confirm + f_single_direction
                 + f_dte + f_delta + f_iv_context + f_size_vs_adv;
  v_total_penalty := p_hedge + p_earnings + p_expiration + p_dealer_hedge;
  v_score := GREATEST(0, LEAST(100, v_raw_score - v_total_penalty));

  -- ---- Regime context (data only, no scoring impact in this pass) ----
  -- Spot at event: closest 1m bar within ±30min of event_ts. Prefer the
  -- nearest match rather than a forward-only snap (like ct_forward_return
  -- does for entry fills) because events fired mid-minute should map to
  -- whichever bar is closer, not strictly the next one.
  SELECT close INTO v_spot_at_event
  FROM public.ct_price_bars
  WHERE ticker = p_ticker
    AND timeframe = '1m'
    AND ts BETWEEN p_event_ts - INTERVAL '30 minutes'
               AND p_event_ts + INTERVAL '30 minutes'
  ORDER BY ABS(EXTRACT(EPOCH FROM (ts - p_event_ts))) ASC
  LIMIT 1;

  -- Previous trading day close: most recent bar strictly before event_ts::date.
  -- Look back 5 calendar days to tolerate weekends + single-session holidays.
  SELECT close INTO v_prev_close
  FROM public.ct_price_bars
  WHERE ticker = p_ticker
    AND timeframe = '1m'
    AND ts::date < p_event_ts::date
    AND ts::date >= (p_event_ts::date - INTERVAL '5 days')
  ORDER BY ts DESC
  LIMIT 1;

  -- Today's open: first bar on event_ts::date. No fallback to prior day —
  -- if no bars exist yet (pre-open), return NULL honestly. Constrain to
  -- the RTH open window 13:30-14:00 UTC (09:30-10:00 ET) so we don't pick
  -- up rogue pre-market bars if the source ever delivers any.
  SELECT close INTO v_today_open
  FROM public.ct_price_bars
  WHERE ticker = p_ticker
    AND timeframe = '1m'
    AND ts::date = p_event_ts::date
    AND ts >= (p_event_ts::date || ' 13:30:00+00')::timestamptz
    AND ts <  (p_event_ts::date || ' 14:00:00+00')::timestamptz
  ORDER BY ts ASC
  LIMIT 1;

  -- Divisor guards — NULL and zero are both skipped.
  IF v_spot_at_event IS NOT NULL AND v_prev_close IS NOT NULL AND v_prev_close <> 0 THEN
    v_pct_from_prev := ROUND(((v_spot_at_event - v_prev_close) / v_prev_close) * 100, 4);
  END IF;
  IF v_spot_at_event IS NOT NULL AND v_today_open IS NOT NULL AND v_today_open <> 0 THEN
    v_pct_from_open := ROUND(((v_spot_at_event - v_today_open) / v_today_open) * 100, 4);
  END IF;

  RETURN jsonb_build_object(
    'classification', v_classification,
    'direction',      v_direction,
    'score',          v_score,
    'raw_score',      v_raw_score,
    'delta_est',      v_delta_est,
    'iv_rank',        v_iv_rank,
    'spot_pct_from_prev_close', v_pct_from_prev,
    'spot_pct_from_today_open', v_pct_from_open,
    'breakdown', jsonb_build_object(
      'opening_buy',      f_opening_buy,
      't1_oi_confirm',    f_t1_oi_confirm,
      'single_direction', f_single_direction,
      'dte',              f_dte,
      'delta',            f_delta,
      'iv_context',       f_iv_context,
      'size_vs_adv',      f_size_vs_adv,
      't1_oi', jsonb_build_object(
        'contribution',         f_t1_oi_confirm,
        'oi_delta_1d',          v_t1_oi_delta,
        'matched_snapshot_id',  v_t1_oi_snap_id,
        'status',               v_t1_oi_status
      ),
      'regime', jsonb_build_object(
        'spot',                  v_spot_at_event,
        'prev_close',            v_prev_close,
        'today_open',            v_today_open,
        'pct_from_prev_close',   v_pct_from_prev,
        'pct_from_today_open',   v_pct_from_open
      )
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

-- ============================================================================
-- 2. ct_score_existing_flow — fresh-insert writer, regime-aware
-- ============================================================================
-- Preserved verbatim except the two new column writes.

CREATE OR REPLACE FUNCTION public.ct_score_existing_flow(
  p_since TIMESTAMPTZ DEFAULT (now() - INTERVAL '4 hours')
) RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public, extensions
AS $$
DECLARE
  v_count INTEGER := 0;
  v_wl    TEXT[] := ARRAY['SPY','QQQ','IWM','AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA'];
  r       RECORD;
  j       JSONB;
BEGIN
  -- ---- ct_sweeps ----
  FOR r IN
    SELECT
      id::text       AS source_id,
      ticker,
      option_symbol,
      strike,
      expiry,
      type           AS side,
      premium,
      volume::integer        AS volume,
      open_interest::integer AS open_interest,
      ask_side_perc,
      snapshot_at    AS event_ts
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
      ticker_adv_30d, iv_rank_at_event,
      spot_pct_from_prev_close, spot_pct_from_today_open
    )
    VALUES (
      'ct_sweeps', r.source_id, r.ticker, r.option_symbol, r.event_ts,
      (j->>'classification'), (j->>'direction'),
      (j->>'score')::numeric, (j->>'raw_score')::numeric,
      j->'breakdown', j->'penalty',
      r.strike, r.expiry,
      CASE WHEN r.expiry IS NOT NULL THEN (r.expiry - r.event_ts::date) END,
      NULLIF(j->>'delta_est','')::numeric,
      r.premium, r.volume, r.open_interest, r.ask_side_perc,
      NULL, NULLIF(j->>'iv_rank','')::numeric,
      NULLIF(j->>'spot_pct_from_prev_close','')::numeric,
      NULLIF(j->>'spot_pct_from_today_open','')::numeric
    )
    ON CONFLICT (source_table, source_id) DO NOTHING;
    v_count := v_count + 1;
  END LOOP;

  -- ---- ct_flow_alerts ----
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
      COALESCE((raw->>'has_floor')::boolean, FALSE)    AS is_floor,
      CASE
        WHEN raw ? 'all_opening_trades' THEN (raw->>'all_opening_trades')::boolean
        ELSE NULL
      END AS all_opening
    FROM public.ct_flow_alerts
    WHERE COALESCE(executed_at::timestamptz, ingested_at) >= p_since
      AND ticker = ANY(v_wl)
  LOOP
    IF r.side IS NULL OR r.ask_side_perc IS NULL THEN CONTINUE; END IF;

    j := public.ct_score_flow_event(
      r.ticker, r.option_symbol, r.strike, r.expiry,
      r.side, r.premium, r.volume, r.open_interest, r.ask_side_perc,
      r.event_ts,
      r.is_sweep,
      r.is_multileg,
      r.is_floor,
      r.all_opening
    );

    INSERT INTO public.ct_scored_flow (
      source_table, source_id, ticker, option_symbol, event_ts,
      classification, direction, score, raw_score,
      score_breakdown, penalty_breakdown,
      strike, expiry, dte, delta_est, premium, volume, open_interest, ask_side_perc,
      ticker_adv_30d, iv_rank_at_event,
      spot_pct_from_prev_close, spot_pct_from_today_open
    )
    VALUES (
      'ct_flow_alerts', r.source_id, r.ticker, r.option_symbol, r.event_ts,
      (j->>'classification'), (j->>'direction'),
      (j->>'score')::numeric, (j->>'raw_score')::numeric,
      j->'breakdown', j->'penalty',
      r.strike, r.expiry,
      CASE WHEN r.expiry IS NOT NULL THEN (r.expiry - r.event_ts::date) END,
      NULLIF(j->>'delta_est','')::numeric,
      r.premium, r.volume, r.open_interest, r.ask_side_perc,
      NULL, NULLIF(j->>'iv_rank','')::numeric,
      NULLIF(j->>'spot_pct_from_prev_close','')::numeric,
      NULLIF(j->>'spot_pct_from_today_open','')::numeric
    )
    ON CONFLICT (source_table, source_id) DO NOTHING;
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END $$;

GRANT EXECUTE ON FUNCTION public.ct_score_existing_flow(TIMESTAMPTZ) TO authenticated, service_role;

-- ============================================================================
-- 3. ct_rescore_flow_since — backfill updater, regime-aware
-- ============================================================================

CREATE OR REPLACE FUNCTION public.ct_rescore_flow_since(
  p_since_hours INT DEFAULT 48
) RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public, extensions
AS $$
DECLARE
  v_count   INTEGER := 0;
  v_cutoff  TIMESTAMPTZ := now() - make_interval(hours => p_since_hours);
  r         RECORD;
  j         JSONB;
BEGIN
  -- ---- ct_sweeps-sourced rows ----
  FOR r IN
    SELECT
      sf.id                     AS scored_id,
      sf.ticker                 AS ticker,
      sf.option_symbol          AS option_symbol,
      sf.event_ts               AS event_ts,
      sw.strike                 AS strike,
      sw.expiry                 AS expiry,
      sw.type                   AS side,
      sw.premium                AS premium,
      sw.volume::integer        AS volume,
      sw.open_interest::integer AS open_interest,
      sw.ask_side_perc          AS ask_side_perc
    FROM public.ct_scored_flow sf
    JOIN public.ct_sweeps sw ON sw.id::text = sf.source_id
    WHERE sf.source_table = 'ct_sweeps'
      AND sf.event_ts >= v_cutoff
  LOOP
    IF r.side IS NULL THEN CONTINUE; END IF;

    j := public.ct_score_flow_event(
      r.ticker, r.option_symbol, r.strike, r.expiry,
      r.side, r.premium, r.volume, r.open_interest, r.ask_side_perc,
      r.event_ts,
      TRUE,   -- is_sweep
      FALSE,  -- is_multileg
      FALSE   -- is_floor
    );

    UPDATE public.ct_scored_flow SET
      classification           = j->>'classification',
      direction                = j->>'direction',
      score                    = (j->>'score')::numeric,
      raw_score                = (j->>'raw_score')::numeric,
      score_breakdown          = j->'breakdown',
      penalty_breakdown        = j->'penalty',
      delta_est                = NULLIF(j->>'delta_est','')::numeric,
      iv_rank_at_event         = NULLIF(j->>'iv_rank','')::numeric,
      spot_pct_from_prev_close = NULLIF(j->>'spot_pct_from_prev_close','')::numeric,
      spot_pct_from_today_open = NULLIF(j->>'spot_pct_from_today_open','')::numeric,
      scored_at                = now()
    WHERE id = r.scored_id;
    v_count := v_count + 1;
  END LOOP;

  -- ---- ct_flow_alerts-sourced rows ----
  FOR r IN
    SELECT
      sf.id                                            AS scored_id,
      sf.ticker                                        AS ticker,
      sf.option_symbol                                 AS option_symbol,
      sf.event_ts                                      AS event_ts,
      fa.strike                                        AS strike,
      fa.expiry                                        AS expiry,
      CASE
        WHEN lower(COALESCE(fa.side, fa.raw->>'type', '')) LIKE 'c%' THEN 'C'
        WHEN lower(COALESCE(fa.side, fa.raw->>'type', '')) LIKE 'p%' THEN 'P'
        ELSE NULL
      END                                              AS side,
      fa.premium                                       AS premium,
      fa.volume::integer                               AS volume,
      fa.open_interest::integer                        AS open_interest,
      CASE
        WHEN (fa.raw->>'total_ask_side_prem')::numeric IS NOT NULL
         AND (fa.raw->>'total_bid_side_prem')::numeric IS NOT NULL
         AND ((fa.raw->>'total_ask_side_prem')::numeric + (fa.raw->>'total_bid_side_prem')::numeric) > 0
        THEN 100.0 * (fa.raw->>'total_ask_side_prem')::numeric
             / ((fa.raw->>'total_ask_side_prem')::numeric + (fa.raw->>'total_bid_side_prem')::numeric)
        ELSE NULL
      END                                              AS ask_side_perc,
      COALESCE((fa.raw->>'has_sweep')::boolean, FALSE)    AS is_sweep,
      COALESCE((fa.raw->>'has_multileg')::boolean, FALSE) AS is_multileg,
      COALESCE((fa.raw->>'has_floor')::boolean, FALSE)    AS is_floor,
      CASE
        WHEN fa.raw ? 'all_opening_trades'
          THEN (fa.raw->>'all_opening_trades')::boolean
        ELSE NULL
      END                                              AS all_opening
    FROM public.ct_scored_flow sf
    JOIN public.ct_flow_alerts fa ON fa.alert_id = sf.source_id
    WHERE sf.source_table = 'ct_flow_alerts'
      AND sf.event_ts >= v_cutoff
  LOOP
    IF r.side IS NULL OR r.ask_side_perc IS NULL THEN CONTINUE; END IF;

    j := public.ct_score_flow_event(
      r.ticker, r.option_symbol, r.strike, r.expiry,
      r.side, r.premium, r.volume, r.open_interest, r.ask_side_perc,
      r.event_ts,
      r.is_sweep,
      r.is_multileg,
      r.is_floor,
      r.all_opening
    );

    UPDATE public.ct_scored_flow SET
      classification           = j->>'classification',
      direction                = j->>'direction',
      score                    = (j->>'score')::numeric,
      raw_score                = (j->>'raw_score')::numeric,
      score_breakdown          = j->'breakdown',
      penalty_breakdown        = j->'penalty',
      delta_est                = NULLIF(j->>'delta_est','')::numeric,
      iv_rank_at_event         = NULLIF(j->>'iv_rank','')::numeric,
      spot_pct_from_prev_close = NULLIF(j->>'spot_pct_from_prev_close','')::numeric,
      spot_pct_from_today_open = NULLIF(j->>'spot_pct_from_today_open','')::numeric,
      scored_at                = now()
    WHERE id = r.scored_id;
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END $$;

GRANT EXECUTE ON FUNCTION public.ct_rescore_flow_since(INT) TO authenticated, service_role;

COMMENT ON FUNCTION public.ct_rescore_flow_since(INT) IS
  'Reruns ct_score_flow_event against all ct_scored_flow rows in the last N hours, rebuilding breakdown (including t1_oi + regime blocks) and populating spot_pct_from_prev_close + spot_pct_from_today_open. Returns count updated.';
