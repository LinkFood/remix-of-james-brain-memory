-- Fix classification logic in ct_score_flow_event.
--
-- Old logic called "closing" whenever volume < open_interest, which is
-- the normal state of 95% of contracts at any given moment. This mis-
-- classified genuine opening_buy prints (100% ask side, deep OTM put
-- etc.) as "closing" just because they weren't making today a V>OI day.
-- James caught a MSFT 350P @ 100% ask labeled "closing" — a closing
-- trade wouldn't hit the ask, it would hit the bid.
--
-- New logic treats ask/bid dominance as the PRIMARY signal:
--   ask_side_perc >= threshold        → opening_buy (someone paid up)
--   ask_side_perc <= (100 - threshold) → opening_sell OR closing
--     · if vol is tiny vs OI (V/OI < 0.1) → likely closing-a-long
--     · otherwise → opening_sell
--   multileg / floor → hedge
--   missing ask_side_perc or volume → ambiguous
--   ask_side in the middle zone → ambiguous
--
-- V/OI > 1 is still a useful signal but no longer required for opening_buy.

SET search_path = public, extensions;

-- Only redefine the classification block of ct_score_flow_event.
-- Everything else (direction inference, scoring factors, penalties,
-- JSONB shape) stays identical. Safe to re-run.

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
  p_is_floor        BOOLEAN DEFAULT FALSE
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

  -- ---- Classification (ask/bid dominance is primary) ----
  IF p_is_multileg OR p_is_floor THEN
    v_classification := 'hedge';
  ELSIF p_ask_side_perc IS NULL THEN
    v_classification := 'ambiguous';
  ELSIF p_ask_side_perc >= v_ask_thresh THEN
    -- Buyer paid up — opening buy regardless of V/OI.
    v_classification := 'opening_buy';
  ELSIF p_ask_side_perc <= (100 - v_ask_thresh) THEN
    -- Bid-side dominant. Distinguish opening_sell from closing a long:
    --   tiny volume vs OI (V/OI < 0.1) → someone trimming an existing
    --     position; label 'closing' (the signal is weak).
    --   otherwise → opening_sell (new short position being written).
    IF p_open_interest IS NOT NULL AND p_open_interest > 0
       AND p_volume IS NOT NULL
       AND (p_volume::numeric / p_open_interest::numeric) < 0.1 THEN
      v_classification := 'closing';
    ELSE
      v_classification := 'opening_sell';
    END IF;
  ELSE
    -- Ask/bid roughly balanced — can't tell intent.
    v_classification := 'ambiguous';
  END IF;

  -- ---- Direction ----
  v_direction := CASE
    WHEN v_normalized_side = 'C' AND v_classification = 'opening_buy'  THEN 'bullish'
    WHEN v_normalized_side = 'C' AND v_classification = 'opening_sell' THEN 'bearish'
    WHEN v_normalized_side = 'P' AND v_classification = 'opening_buy'  THEN 'bearish'
    WHEN v_normalized_side = 'P' AND v_classification = 'opening_sell' THEN 'bullish'
    ELSE 'neutral'
  END;

  -- ---- opening_buy (25) — partial credit per component ----
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

  -- ---- t1_oi_confirm (20): cannot compute at score time; stays 0,
  --      grader upgrades later when T+1 snapshot lands.
  -- f_t1_oi_confirm := 0;

  -- ---- single_direction (15): ask_side_perc extreme (either way) ----
  IF p_ask_side_perc IS NOT NULL THEN
    IF p_ask_side_perc >= 85 OR p_ask_side_perc <= 15 THEN
      f_single_direction := 15;
    ELSIF p_ask_side_perc >= 70 OR p_ask_side_perc <= 30 THEN
      f_single_direction := 10;
    ELSIF p_ask_side_perc >= 60 OR p_ask_side_perc <= 40 THEN
      f_single_direction := 5;
    END IF;
  END IF;

  -- ---- dte (15): sweet spot 15-45 days ----
  IF v_dte IS NOT NULL THEN
    IF v_dte BETWEEN 15 AND 45 THEN
      f_dte := 15;
    ELSIF v_dte BETWEEN 7 AND 90 THEN
      f_dte := 10;
    ELSIF v_dte BETWEEN 1 AND 180 THEN
      f_dte := 5;
    END IF;
  END IF;

  -- ---- delta (10): use spot/strike distance as a rough delta proxy.
  --      Actual delta not in input — approximate via moneyness band.
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
      IF ABS(v_delta_est) BETWEEN 0.20 AND 0.70 THEN
        f_delta := 10;
      ELSIF ABS(v_delta_est) BETWEEN 0.10 AND 0.80 THEN
        f_delta := 5;
      END IF;
    END IF;
  END IF;

  -- ---- iv_context (10): IV rank extremes ----
  IF v_iv_rank IS NOT NULL THEN
    IF v_iv_rank <= 30 OR v_iv_rank >= 70 THEN
      f_iv_context := 10;
    ELSIF v_iv_rank <= 40 OR v_iv_rank >= 60 THEN
      f_iv_context := 5;
    END IF;
  END IF;

  -- ---- size_vs_adv (10) — reads options_adv_30d from baselines ----
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
  IF v_dte IS NOT NULL AND v_dte <= 1 THEN p_expiration := 5; END IF;
  -- earnings + dealer_hedge stay 0 unless we add detection later.

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

GRANT EXECUTE ON FUNCTION public.ct_score_flow_event(TEXT, TEXT, NUMERIC, DATE, TEXT, NUMERIC, INTEGER, INTEGER, NUMERIC, TIMESTAMPTZ, BOOLEAN, BOOLEAN, BOOLEAN) TO authenticated, service_role;

COMMENT ON FUNCTION public.ct_score_flow_event IS
  'v2 flow scoring. Classification is ask/bid-dominance-primary (as of 2026-04-24): closing only fires when bid-side dominant AND V/OI < 0.1, not just V<OI.';
