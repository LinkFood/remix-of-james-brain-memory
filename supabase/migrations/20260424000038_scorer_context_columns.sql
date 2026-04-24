-- Scorer reads stacking + FlowPulse regime context.
--
-- Context: morning's KEY FINDING (MFE calibration) showed the scorer detects
-- VOLATILITY not DIRECTION — MFE ≈ MAE across every band over 4300+ events.
-- The afternoon close-the-loops sprint wired tape-reader + specialists +
-- digest + SQL interpretation, but the scorer itself still ignores the
-- pre-computed aggregate signal. Every flow event got scored as if it's the
-- first print on the contract today.
--
-- This migration plumbs the two largest signals into the scorer:
--
--   1. Contract stacking (mirrors ct_contract_stacking_get logic inline so
--      we don't pay RPC overhead per row): how many opening prints have
--      already landed on this exact option_symbol in the current 6h window,
--      and what does the buy/sell mix imply (call_accum / put_writing /
--      etc.)?
--   2. Ticker regime (mirrors ct_flow_pulse): is the underlying running an
--      unusual call:put skew vs its 30d baseline, and does this flow agree
--      with that regime?
--
-- We store the lookups as denormalized columns on ct_scored_flow (Path A
-- from the spec). Live RPC lookups per row would re-aggregate ct_scored_flow
-- thousands of times per scoring pass — denorm pays once, reads are O(1).
--
-- Boost/penalty rules (capped at ±15 total context adjustment):
--   stacking_prints >= 5 AND premium_total >= $500k AND signal agrees → +10
--   stacking_prints >= 5 AND signal contradicts                        → -5
--   ticker_is_unusual AND ticker_regime_agrees                         → +5
--   ticker_is_unusual AND NOT ticker_regime_agrees                     → -3
--
-- Adjustment is applied to v_score AFTER the existing GREATEST(0, LEAST(100,
-- raw - penalties)) clamp, then re-clamped — so context can push a 0 to 5
-- or a 100 down to 92 if the regime says we're trading against the tape.
--
-- Score breakdown JSON gains a "context" sub-block alongside the existing
-- "regime" sub-block under breakdown — readers stay backward-compat.
--
-- All other scoring math preserved verbatim from 20260424000024.

SET search_path = public, extensions;

-- ============================================================================
-- 1. Add denormalized context columns to ct_scored_flow
-- ============================================================================

ALTER TABLE public.ct_scored_flow
  ADD COLUMN IF NOT EXISTS stacking_prints      INTEGER,
  ADD COLUMN IF NOT EXISTS stacking_signal      TEXT,
  ADD COLUMN IF NOT EXISTS stacking_agrees      BOOLEAN,
  ADD COLUMN IF NOT EXISTS ticker_cp_ratio      NUMERIC,
  ADD COLUMN IF NOT EXISTS ticker_cp_baseline   NUMERIC,
  ADD COLUMN IF NOT EXISTS ticker_is_unusual    BOOLEAN,
  ADD COLUMN IF NOT EXISTS ticker_regime_agrees BOOLEAN;

COMMENT ON COLUMN public.ct_scored_flow.stacking_prints IS
  'Count of opening prints on this option_symbol within 6h of event_ts. NULL until rescored.';
COMMENT ON COLUMN public.ct_scored_flow.stacking_signal IS
  'Interpreted stack signal: call_accum | put_accum | put_writing | call_writing | call_distribution | put_distribution | two_sided. Mirrors signal_label from ct_contract_stacking but normalized to underscore form.';
COMMENT ON COLUMN public.ct_scored_flow.stacking_agrees IS
  'TRUE when the interpreted stack direction (bullish/bearish) agrees with this row''s direction. NULL if signal is ''mixed''/''two_sided'' or stacking_prints < 5.';
COMMENT ON COLUMN public.ct_scored_flow.ticker_cp_ratio IS
  'Current 6h call:put ratio for ticker at event_ts.';
COMMENT ON COLUMN public.ct_scored_flow.ticker_cp_baseline IS
  '30d daily-averaged call:put baseline for ticker (from ct_flow_pulse logic).';
COMMENT ON COLUMN public.ct_scored_flow.ticker_is_unusual IS
  'TRUE when |cp_ratio - baseline| / baseline >= 0.30 AND >= 20 events in current + baseline windows.';
COMMENT ON COLUMN public.ct_scored_flow.ticker_regime_agrees IS
  'TRUE when this row''s direction agrees with the deviation sign (bullish flow + bullish deviation, or bearish + bearish). NULL when not unusual or direction is neutral.';

CREATE INDEX IF NOT EXISTS idx_ct_scored_flow_ticker_unusual
  ON public.ct_scored_flow (ticker, event_ts DESC)
  WHERE ticker_is_unusual = TRUE;

-- ============================================================================
-- 2. ct_score_flow_event — context-aware scorer
-- ============================================================================
-- Adds context lookups + boost/penalty rules + extends returned JSONB.
-- Signature unchanged. Existing callers (ct_score_existing_flow,
-- ct_rescore_flow_since) keep working without changes to their CALL sites,
-- but we update them below to pass through the new returned fields.

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

  -- Regime context state (price-derived)
  v_spot_at_event     NUMERIC;
  v_prev_close        NUMERIC;
  v_today_open        NUMERIC;
  v_pct_from_prev     NUMERIC;
  v_pct_from_open     NUMERIC;

  -- Stacking context state
  v_stack_prints      INTEGER := 0;
  v_stack_premium     NUMERIC := 0;
  v_stack_buy_count   INTEGER := 0;
  v_stack_sell_count  INTEGER := 0;
  v_stack_avg_ask     NUMERIC;
  v_stack_buy_ratio   NUMERIC;
  v_stack_sell_ratio  NUMERIC;
  v_stack_side_char   TEXT;
  v_stack_signal      TEXT;
  v_stack_color       TEXT;
  v_stack_agrees      BOOLEAN;

  -- FlowPulse regime state
  v_calls_count       INTEGER := 0;
  v_puts_count        INTEGER := 0;
  v_cp_ratio          NUMERIC;
  v_cp_baseline       NUMERIC;
  v_cp_baseline_evts  INTEGER := 0;
  v_cp_deviation      NUMERIC;
  v_is_unusual        BOOLEAN := FALSE;
  v_regime_agrees     BOOLEAN;

  -- Context-derived adjustment (capped ±15)
  v_ctx_adj           NUMERIC := 0;
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

  -- ---- Regime context (price-derived, data only) ----
  SELECT close INTO v_spot_at_event
  FROM public.ct_price_bars
  WHERE ticker = p_ticker
    AND timeframe = '1m'
    AND ts BETWEEN p_event_ts - INTERVAL '30 minutes'
               AND p_event_ts + INTERVAL '30 minutes'
  ORDER BY ABS(EXTRACT(EPOCH FROM (ts - p_event_ts))) ASC
  LIMIT 1;

  SELECT close INTO v_prev_close
  FROM public.ct_price_bars
  WHERE ticker = p_ticker
    AND timeframe = '1m'
    AND ts::date < p_event_ts::date
    AND ts::date >= (p_event_ts::date - INTERVAL '5 days')
  ORDER BY ts DESC
  LIMIT 1;

  SELECT close INTO v_today_open
  FROM public.ct_price_bars
  WHERE ticker = p_ticker
    AND timeframe = '1m'
    AND ts::date = p_event_ts::date
    AND ts >= (p_event_ts::date || ' 13:30:00+00')::timestamptz
    AND ts <  (p_event_ts::date || ' 14:00:00+00')::timestamptz
  ORDER BY ts ASC
  LIMIT 1;

  IF v_spot_at_event IS NOT NULL AND v_prev_close IS NOT NULL AND v_prev_close <> 0 THEN
    v_pct_from_prev := ROUND(((v_spot_at_event - v_prev_close) / v_prev_close) * 100, 4);
  END IF;
  IF v_spot_at_event IS NOT NULL AND v_today_open IS NOT NULL AND v_today_open <> 0 THEN
    v_pct_from_open := ROUND(((v_spot_at_event - v_today_open) / v_today_open) * 100, 4);
  END IF;

  -- ============================================================================
  -- Stacking context — same-contract repeat flow within ±6h of event_ts
  -- ============================================================================
  -- Mirrors ct_contract_stacking() interpretation rules but scoped to a single
  -- option_symbol and centered on event_ts (rolling backward 6h). We center
  -- BACKWARD only — at score time we only know what came before, not after.
  -- This intentionally differs from the dashboard RPC which looks at "now"
  -- and is fine because the dashboard is real-time. Backward-only at score
  -- time means historical rescores see the same context the live scorer
  -- would have seen.
  IF p_option_symbol IS NOT NULL AND length(p_option_symbol) >= 9 THEN
    SELECT
      COUNT(*) FILTER (WHERE classification IN ('opening_buy','opening_sell'))::int,
      COALESCE(SUM(premium) FILTER (WHERE classification IN ('opening_buy','opening_sell')), 0)::numeric,
      COUNT(*) FILTER (WHERE classification = 'opening_buy')::int,
      COUNT(*) FILTER (WHERE classification = 'opening_sell')::int,
      ROUND(AVG(ask_side_perc) FILTER (WHERE ask_side_perc IS NOT NULL)::numeric, 1)
    INTO v_stack_prints, v_stack_premium, v_stack_buy_count, v_stack_sell_count, v_stack_avg_ask
    FROM public.ct_scored_flow
    WHERE option_symbol = p_option_symbol
      AND event_ts >= p_event_ts - INTERVAL '6 hours'
      AND event_ts <  p_event_ts;  -- strictly before — don't see the future

    v_stack_side_char := substring(p_option_symbol, length(p_option_symbol) - 8, 1);

    IF v_stack_buy_count + v_stack_sell_count > 0 THEN
      v_stack_buy_ratio  := v_stack_buy_count::numeric  / (v_stack_buy_count + v_stack_sell_count);
      v_stack_sell_ratio := v_stack_sell_count::numeric / (v_stack_buy_count + v_stack_sell_count);

      IF v_stack_buy_ratio >= 0.8 THEN
        IF v_stack_side_char = 'C' THEN
          v_stack_signal := 'call_accum';
          v_stack_color  := 'bullish';
        ELSE
          v_stack_signal := 'put_accum';
          v_stack_color  := 'bearish';
        END IF;
      ELSIF v_stack_sell_ratio >= 0.8
            AND v_stack_avg_ask IS NOT NULL
            AND v_stack_avg_ask < 30 THEN
        IF v_stack_side_char = 'P' THEN
          v_stack_signal := 'put_writing';
          v_stack_color  := 'bullish';
        ELSE
          v_stack_signal := 'call_writing';
          v_stack_color  := 'bearish';
        END IF;
      ELSIF v_stack_sell_ratio >= 0.8 THEN
        IF v_stack_side_char = 'C' THEN
          v_stack_signal := 'call_distribution';
        ELSE
          v_stack_signal := 'put_distribution';
        END IF;
        v_stack_color := 'mixed';
      ELSE
        v_stack_signal := 'two_sided';
        v_stack_color  := 'mixed';
      END IF;
    END IF;

    -- stacking_agrees: only meaningful when stack has a directional color
    -- AND this row has a direction. NULL otherwise.
    IF v_stack_color IN ('bullish','bearish') AND v_direction IN ('bullish','bearish') THEN
      v_stack_agrees := (v_stack_color = v_direction);
    END IF;
  END IF;

  -- ============================================================================
  -- FlowPulse regime context — ticker-level call:put skew vs 30d baseline
  -- ============================================================================
  -- Mirrors ct_flow_pulse() inline. 6h backward window from event_ts.
  -- 30d baseline computed from daily call:put ratios over [event_ts-30d, event_ts-6h].
  --
  -- Note: spec says "ticker_is_unusual = ABS(cp_ratio - baseline) >= baseline * 0.30".
  -- That's symmetric ±30% deviation, which is looser than ct_flow_pulse's
  -- 2x/0.5x threshold + 20-event noise floor. Using spec rule here so
  -- direction-discriminator coverage is broader; we still gate on
  -- baseline existing + at least 5 events in current window to suppress
  -- pre-market / pre-open noise.
  SELECT
    COUNT(*) FILTER (WHERE substring(option_symbol, length(option_symbol) - 8, 1) = 'C')::int,
    COUNT(*) FILTER (WHERE substring(option_symbol, length(option_symbol) - 8, 1) = 'P')::int
  INTO v_calls_count, v_puts_count
  FROM public.ct_scored_flow
  WHERE ticker = p_ticker
    AND classification IN ('opening_buy','opening_sell')
    AND option_symbol IS NOT NULL
    AND length(option_symbol) >= 9
    AND event_ts >= p_event_ts - INTERVAL '6 hours'
    AND event_ts <  p_event_ts;

  IF v_calls_count + v_puts_count >= 5 THEN
    v_cp_ratio := v_calls_count::numeric / GREATEST(v_puts_count, 1);
  END IF;

  -- 30d baseline: daily call:put ratios for [event-30d, event-6h], filtered
  -- to days with >= 5 calls AND >= 5 puts (noise floor).
  WITH hist AS (
    SELECT
      date_trunc('day', event_ts) AS day_bucket,
      substring(option_symbol, length(option_symbol) - 8, 1) AS side_char
    FROM public.ct_scored_flow
    WHERE ticker = p_ticker
      AND classification IN ('opening_buy','opening_sell')
      AND option_symbol IS NOT NULL
      AND length(option_symbol) >= 9
      AND event_ts >= p_event_ts - INTERVAL '30 days'
      AND event_ts <  p_event_ts - INTERVAL '6 hours'
  ),
  hist_daily AS (
    SELECT
      day_bucket,
      COUNT(*) FILTER (WHERE side_char = 'C')::numeric AS day_calls,
      COUNT(*) FILTER (WHERE side_char = 'P')::numeric AS day_puts
    FROM hist
    GROUP BY day_bucket
  )
  SELECT
    AVG(day_calls / GREATEST(day_puts, 1))::numeric,
    SUM(day_calls + day_puts)::int
  INTO v_cp_baseline, v_cp_baseline_evts
  FROM hist_daily
  WHERE day_calls >= 5 AND day_puts >= 5;

  IF v_cp_ratio IS NOT NULL
     AND v_cp_baseline IS NOT NULL
     AND v_cp_baseline > 0 THEN
    v_cp_deviation := v_cp_ratio / v_cp_baseline;
    -- ±30% deviation per spec, plus baseline-events floor for stability
    v_is_unusual := (v_cp_baseline_evts >= 20)
      AND (ABS(v_cp_ratio - v_cp_baseline) >= v_cp_baseline * 0.30);

    -- regime_agrees: deviation > 1 means more calls than usual (bullish skew),
    -- < 1 means more puts (bearish skew). bullish flow agrees with bullish skew.
    IF v_is_unusual AND v_direction IN ('bullish','bearish') THEN
      v_regime_agrees := (
        (v_direction = 'bullish' AND v_cp_deviation > 1)
        OR (v_direction = 'bearish' AND v_cp_deviation < 1)
      );
    END IF;
  END IF;

  -- ============================================================================
  -- Context-derived score adjustment (capped ±15)
  -- ============================================================================
  -- Stacking: ≥5 prints AND $500k+ premium
  IF v_stack_prints >= 5 AND v_stack_premium >= 500000 THEN
    IF v_stack_agrees IS TRUE THEN
      v_ctx_adj := v_ctx_adj + 10;
    ELSIF v_stack_agrees IS FALSE THEN
      v_ctx_adj := v_ctx_adj - 5;
    END IF;
  END IF;

  -- FlowPulse regime
  IF v_is_unusual AND v_regime_agrees IS TRUE THEN
    v_ctx_adj := v_ctx_adj + 5;
  ELSIF v_is_unusual AND v_regime_agrees IS FALSE THEN
    v_ctx_adj := v_ctx_adj - 3;
  END IF;

  -- Cap context-derived adjustment at ±15
  v_ctx_adj := GREATEST(-15, LEAST(15, v_ctx_adj));

  -- Apply context adjustment to score, re-clamp to [0,100]
  v_score := GREATEST(0, LEAST(100, v_score + v_ctx_adj));

  RETURN jsonb_build_object(
    'classification', v_classification,
    'direction',      v_direction,
    'score',          v_score,
    'raw_score',      v_raw_score,
    'delta_est',      v_delta_est,
    'iv_rank',        v_iv_rank,
    'spot_pct_from_prev_close', v_pct_from_prev,
    'spot_pct_from_today_open', v_pct_from_open,
    -- Denormalized context columns the writers will pluck out
    'stacking_prints',      v_stack_prints,
    'stacking_signal',      v_stack_signal,
    'stacking_agrees',      v_stack_agrees,
    'ticker_cp_ratio',      v_cp_ratio,
    'ticker_cp_baseline',   v_cp_baseline,
    'ticker_is_unusual',    v_is_unusual,
    'ticker_regime_agrees', v_regime_agrees,
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
      ),
      'context', jsonb_build_object(
        'stacking_prints',  v_stack_prints,
        'stacking_premium', v_stack_premium,
        'stacking_signal',  v_stack_signal,
        'stacking_color',   v_stack_color,
        'stacking_agrees',  v_stack_agrees,
        'cp_ratio',         v_cp_ratio,
        'cp_baseline',      v_cp_baseline,
        'cp_deviation',     v_cp_deviation,
        'is_unusual',       v_is_unusual,
        'regime_agrees',    v_regime_agrees,
        'adjustment',       v_ctx_adj
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
-- 3. ct_score_existing_flow — fresh-insert writer, populates context columns
-- ============================================================================

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
    ORDER BY snapshot_at ASC  -- chronological so stacking lookups see prior inserts
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
      spot_pct_from_prev_close, spot_pct_from_today_open,
      stacking_prints, stacking_signal, stacking_agrees,
      ticker_cp_ratio, ticker_cp_baseline, ticker_is_unusual, ticker_regime_agrees
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
      NULLIF(j->>'spot_pct_from_today_open','')::numeric,
      NULLIF(j->>'stacking_prints','')::integer,
      NULLIF(j->>'stacking_signal',''),
      NULLIF(j->>'stacking_agrees','')::boolean,
      NULLIF(j->>'ticker_cp_ratio','')::numeric,
      NULLIF(j->>'ticker_cp_baseline','')::numeric,
      NULLIF(j->>'ticker_is_unusual','')::boolean,
      NULLIF(j->>'ticker_regime_agrees','')::boolean
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
    ORDER BY COALESCE(executed_at::timestamptz, ingested_at) ASC  -- chronological for stacking
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
      spot_pct_from_prev_close, spot_pct_from_today_open,
      stacking_prints, stacking_signal, stacking_agrees,
      ticker_cp_ratio, ticker_cp_baseline, ticker_is_unusual, ticker_regime_agrees
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
      NULLIF(j->>'spot_pct_from_today_open','')::numeric,
      NULLIF(j->>'stacking_prints','')::integer,
      NULLIF(j->>'stacking_signal',''),
      NULLIF(j->>'stacking_agrees','')::boolean,
      NULLIF(j->>'ticker_cp_ratio','')::numeric,
      NULLIF(j->>'ticker_cp_baseline','')::numeric,
      NULLIF(j->>'ticker_is_unusual','')::boolean,
      NULLIF(j->>'ticker_regime_agrees','')::boolean
    )
    ON CONFLICT (source_table, source_id) DO NOTHING;
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END $$;

GRANT EXECUTE ON FUNCTION public.ct_score_existing_flow(TIMESTAMPTZ) TO authenticated, service_role;

-- ============================================================================
-- 4. ct_rescore_flow_since — backfill updater, populates context columns
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
    ORDER BY sf.event_ts ASC
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
      stacking_prints          = NULLIF(j->>'stacking_prints','')::integer,
      stacking_signal          = NULLIF(j->>'stacking_signal',''),
      stacking_agrees          = NULLIF(j->>'stacking_agrees','')::boolean,
      ticker_cp_ratio          = NULLIF(j->>'ticker_cp_ratio','')::numeric,
      ticker_cp_baseline       = NULLIF(j->>'ticker_cp_baseline','')::numeric,
      ticker_is_unusual        = NULLIF(j->>'ticker_is_unusual','')::boolean,
      ticker_regime_agrees     = NULLIF(j->>'ticker_regime_agrees','')::boolean,
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
    ORDER BY sf.event_ts ASC
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
      stacking_prints          = NULLIF(j->>'stacking_prints','')::integer,
      stacking_signal          = NULLIF(j->>'stacking_signal',''),
      stacking_agrees          = NULLIF(j->>'stacking_agrees','')::boolean,
      ticker_cp_ratio          = NULLIF(j->>'ticker_cp_ratio','')::numeric,
      ticker_cp_baseline       = NULLIF(j->>'ticker_cp_baseline','')::numeric,
      ticker_is_unusual        = NULLIF(j->>'ticker_is_unusual','')::boolean,
      ticker_regime_agrees     = NULLIF(j->>'ticker_regime_agrees','')::boolean,
      scored_at                = now()
    WHERE id = r.scored_id;
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END $$;

GRANT EXECUTE ON FUNCTION public.ct_rescore_flow_since(INT) TO authenticated, service_role;

COMMENT ON FUNCTION public.ct_rescore_flow_since(INT) IS
  'Reruns ct_score_flow_event against all ct_scored_flow rows in the last N hours. Rebuilds breakdown JSON (now including context block) and populates spot_pct_from_*, stacking_*, ticker_cp_*, ticker_is_unusual, ticker_regime_agrees columns. Returns count updated.';
