-- ============================================================================
-- Co-Trader v2 Phase 1b fix — ask-side threshold unit reconciliation.
--
-- Phase 1a (migration 20260423000026) seeded
--   score.opening_buy_ask_threshold = 0.60   (fraction)
-- Phase 1b (migration 20260423000027) scored ct_sweeps.ask_side_perc
-- which is 0-100. The threshold comparison `10.52 >= 0.60` was true for
-- every print, so opening_buy classification misfired.
--
-- Smoke test exposed it: INFQ (ask 10.52%) got classified opening_buy.
--
-- Fix: detect fractional threshold (<=1) at runtime and scale to percent.
-- Keeps both storage forms (fraction or percent) valid without a data migration.
-- ============================================================================
SET search_path = public, extensions;

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
  p_is_sweep        BOOLEAN,
  p_is_multileg     BOOLEAN DEFAULT FALSE,
  p_is_floor        BOOLEAN DEFAULT FALSE
) RETURNS JSONB
LANGUAGE plpgsql STABLE
SET search_path = public, extensions
AS $$
DECLARE
  -- Thresholds (read from ct_config with defaults)
  v_ask_thresh        NUMERIC;
  v_dte_lo            NUMERIC := getConfigVal('score.dte_band_lo', 15);
  v_dte_hi            NUMERIC := getConfigVal('score.dte_band_hi', 45);
  v_dte_half_lo       NUMERIC := getConfigVal('score.dte_half_lo', 7);
  v_dte_half_hi       NUMERIC := getConfigVal('score.dte_half_hi', 60);
  v_iv_low            NUMERIC := getConfigVal('score.iv_low', 30);
  v_iv_high           NUMERIC := getConfigVal('score.iv_high', 70);
  v_earnings_window_d NUMERIC := getConfigVal('penalty.earnings_window_days', 5);
  v_earnings_max      NUMERIC := getConfigVal('penalty.earnings_max', 20);
  v_hedge_max         NUMERIC := getConfigVal('penalty.hedge_max', 30);
  v_expiration_max    NUMERIC := getConfigVal('penalty.expiration_max', 15);
  v_dealer_hedge_max  NUMERIC := getConfigVal('penalty.dealer_hedge_max', 15);

  v_dte               INTEGER;
  v_spot              NUMERIC;
  v_iv_rank           NUMERIC;
  v_moneyness_pct     NUMERIC;
  v_delta_est         NUMERIC;
  v_normalized_side   TEXT;

  v_classification    TEXT;
  v_direction         TEXT;

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

  v_is_etf            BOOLEAN;
  v_is_itm            BOOLEAN;
  v_has_earnings_near BOOLEAN;
  v_dow               INTEGER;
  v_third_friday      DATE;

  v_table_exists      BOOLEAN;
  v_premium_rank      NUMERIC;

  v_recent_move_pct   NUMERIC;

  v_raw_score         NUMERIC;
  v_total_penalty     NUMERIC;
  v_score             NUMERIC;
BEGIN
  -- Ask-threshold: ct_sweeps.ask_side_perc is 0-100. Phase 1a seeded the
  -- threshold as 0.60 (fraction). Scale if fractional.
  v_ask_thresh := getConfigVal('score.opening_buy_ask_threshold', 60);
  IF v_ask_thresh <= 1 THEN
    v_ask_thresh := v_ask_thresh * 100;
  END IF;

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

  -- Classification
  IF p_is_multileg OR p_is_floor THEN
    v_classification := 'hedge';
  ELSIF p_volume IS NULL OR p_open_interest IS NULL THEN
    v_classification := 'ambiguous';
  ELSIF p_volume > p_open_interest
        AND p_ask_side_perc IS NOT NULL
        AND p_ask_side_perc >= v_ask_thresh THEN
    v_classification := 'opening_buy';
  ELSIF p_volume > p_open_interest
        AND p_ask_side_perc IS NOT NULL
        AND p_ask_side_perc <= (100 - v_ask_thresh) THEN
    v_classification := 'opening_sell';
  ELSIF p_volume < p_open_interest THEN
    v_classification := 'closing';
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

  -- POSITIVE FACTORS
  IF p_ask_side_perc IS NOT NULL AND p_ask_side_perc >= v_ask_thresh THEN
    f_opening_buy := f_opening_buy + 10;
  END IF;
  IF p_volume IS NOT NULL AND p_open_interest IS NOT NULL AND p_volume > p_open_interest THEN
    f_opening_buy := f_opening_buy + 10;
  END IF;
  IF NOT p_is_multileg THEN
    f_opening_buy := f_opening_buy + 2.5;
  END IF;
  IF NOT p_is_floor THEN
    f_opening_buy := f_opening_buy + 2.5;
  END IF;

  f_t1_oi_confirm := 0;

  IF p_is_sweep AND NOT p_is_multileg THEN
    f_single_direction := 15;
  END IF;

  IF v_dte IS NOT NULL THEN
    IF v_dte >= v_dte_lo AND v_dte <= v_dte_hi THEN
      f_dte := 10;
    ELSIF (v_dte >= v_dte_half_lo AND v_dte < v_dte_lo)
          OR (v_dte > v_dte_hi AND v_dte <= v_dte_half_hi) THEN
      f_dte := 5;
    ELSE
      f_dte := 0;
    END IF;
  END IF;

  IF v_spot IS NOT NULL AND v_spot > 0 AND p_strike IS NOT NULL AND v_normalized_side IS NOT NULL THEN
    IF v_normalized_side = 'C' THEN
      v_moneyness_pct := (p_strike - v_spot) / v_spot * 100;
    ELSE
      v_moneyness_pct := (v_spot - p_strike) / v_spot * 100;
    END IF;

    IF v_moneyness_pct BETWEEN -10 AND 15 THEN
      f_delta := 10;
    ELSIF v_moneyness_pct BETWEEN -20 AND 25 THEN
      f_delta := 5;
    ELSE
      f_delta := 0;
    END IF;

    v_delta_est := CASE
      WHEN v_moneyness_pct <= -20 THEN 0.9
      WHEN v_moneyness_pct <= -10 THEN 0.7
      WHEN v_moneyness_pct <=   0 THEN 0.55
      WHEN v_moneyness_pct <=  10 THEN 0.4
      WHEN v_moneyness_pct <=  20 THEN 0.25
      ELSE 0.1
    END;
  END IF;

  IF v_iv_rank IS NOT NULL THEN
    IF v_iv_rank < v_iv_low THEN
      f_iv_context := 10;
    ELSIF v_iv_rank <= v_iv_high THEN
      f_iv_context := 5;
    ELSE
      f_iv_context := 0;
    END IF;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'ct_ticker_baselines'
  ) INTO v_table_exists;

  IF v_table_exists AND p_premium IS NOT NULL THEN
    BEGIN
      EXECUTE format(
        'SELECT CASE
           WHEN %L >= (options_adv_30d * 3) THEN 1.0
           WHEN %L >= (options_adv_30d * 1.5) THEN 0.75
           WHEN %L >= options_adv_30d THEN 0.5
           ELSE 0.25
         END
         FROM public.ct_ticker_baselines
         WHERE ticker = %L
         ORDER BY date DESC LIMIT 1',
        p_premium, p_premium, p_premium, p_ticker
      ) INTO v_premium_rank;

      f_size_vs_adv := CASE
        WHEN v_premium_rank >= 0.9  THEN 10
        WHEN v_premium_rank >= 0.75 THEN 5
        ELSE 0
      END;
    EXCEPTION WHEN others THEN
      f_size_vs_adv := 0;
    END;
  END IF;

  -- PENALTIES
  v_is_etf := p_ticker IN ('SPY','QQQ','IWM','DIA','XLK','XLF','XLE','XLV','XLC','XLY','XLI','XLP','XLU','XLB','XLRE');
  IF v_spot IS NOT NULL AND p_strike IS NOT NULL AND v_normalized_side IS NOT NULL THEN
    v_is_itm := (v_normalized_side = 'C' AND p_strike < v_spot)
                OR (v_normalized_side = 'P' AND p_strike > v_spot);
  ELSE
    v_is_itm := FALSE;
  END IF;

  IF v_is_etf AND v_is_itm AND v_dte IS NOT NULL AND v_dte > 60 THEN
    p_hedge := v_hedge_max;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.ct_events
    WHERE event_type = 'earnings'
      AND ticker = p_ticker
      AND event_date BETWEEN p_event_ts::date AND (p_event_ts::date + (v_earnings_window_d || ' days')::interval)::date
  ) INTO v_has_earnings_near;

  IF v_has_earnings_near THEN
    p_earnings := v_earnings_max;
  END IF;

  IF p_expiry IS NOT NULL THEN
    v_third_friday := date_trunc('month', p_expiry)::date;
    v_dow := EXTRACT(DOW FROM v_third_friday)::int;
    v_third_friday := v_third_friday + ((5 - v_dow + 7) % 7);
    v_third_friday := v_third_friday + 14;
    IF p_expiry = v_third_friday OR p_expiry BETWEEN (v_third_friday - 4) AND v_third_friday THEN
      p_expiration := v_expiration_max;
    END IF;
  END IF;

  BEGIN
    SELECT ABS(
      (MAX(underlying_price) - MIN(underlying_price)) / NULLIF(MIN(underlying_price), 0) * 100
    )
    INTO v_recent_move_pct
    FROM public.ct_net_premium_ticks
    WHERE ticker = p_ticker
      AND tick_timestamp BETWEEN (p_event_ts - INTERVAL '30 minutes') AND p_event_ts;
  EXCEPTION WHEN others THEN
    v_recent_move_pct := NULL;
  END;

  IF v_recent_move_pct IS NOT NULL AND v_recent_move_pct > 1 THEN
    IF p_is_sweep THEN
      p_dealer_hedge := v_dealer_hedge_max / 2;
    END IF;
  END IF;

  v_raw_score := f_opening_buy + f_t1_oi_confirm + f_single_direction
               + f_dte + f_delta + f_iv_context + f_size_vs_adv;
  v_total_penalty := p_hedge + p_earnings + p_expiration + p_dealer_hedge;
  v_score := GREATEST(0, v_raw_score - v_total_penalty);

  RETURN jsonb_build_object(
    'score', round(v_score::numeric, 2),
    'raw_score', round(v_raw_score::numeric, 2),
    'classification', v_classification,
    'direction', v_direction,
    'dte', v_dte,
    'delta_est', v_delta_est,
    'iv_rank', v_iv_rank,
    'spot', v_spot,
    'breakdown', jsonb_build_object(
      'opening_buy', f_opening_buy,
      't1_oi_confirm', f_t1_oi_confirm,
      'single_direction', f_single_direction,
      'dte', f_dte,
      'delta', f_delta,
      'iv_context', f_iv_context,
      'size_vs_adv', f_size_vs_adv
    ),
    'penalty', jsonb_build_object(
      'hedge', p_hedge,
      'earnings', p_earnings,
      'expiration', p_expiration,
      'dealer_hedge', p_dealer_hedge
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.ct_score_flow_event(
  TEXT, TEXT, NUMERIC, DATE, TEXT, NUMERIC, INTEGER, INTEGER, NUMERIC, TIMESTAMPTZ, BOOLEAN, BOOLEAN, BOOLEAN
) TO authenticated, service_role;
