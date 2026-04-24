-- Lean score v1.1 — fix the flow component's unit bug.
--
-- Old: flow_contribution = (weighted_net_premium_$ / options_adv_30d_contracts) * 30
--   That's DOLLARS divided by CONTRACTS — meaningless. Smaller-ADV tickers
--   (QQQ adv=1.2M) slam the cap on normal flow while larger-ADV tickers
--   (SPY adv=3.7M) look muted. James saw SPY lean 38 bearish and QQQ lean 82
--   bullish on the same data-day; the divergence was amplified by this bug.
--
-- New: normalize by dollar magnitude. $10M net flow in the decayed 24h
-- window = full credit. Sign follows call buying - put buying (so a
-- positive `net_put_premium` — ask-side put buying — gets inverted
-- because it's bearish).
--
-- Convention check: UW's net_put_premium is the ask-side minus bid-side
-- put premium (positive = buyers aggressive = bearish). So the bullish
-- metric is (net_call_premium - net_put_premium). Previous version had
-- (call + put) which blended the convention incorrectly for some tickers.
SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.ct_compute_lean_score(p_ticker TEXT, p_as_of TIMESTAMPTZ DEFAULT now())
RETURNS JSONB
LANGUAGE plpgsql STABLE
SET search_path = public, extensions
AS $$
DECLARE
  v_components JSONB := '{}'::jsonb;
  v_snapshot   RECORD;

  v_flow_cmp   NUMERIC := 0;
  v_flow_w     NUMERIC := 0;
  v_flow_n     INT := 0;
  v_flow_norm  NUMERIC := 10_000_000;  -- $10M net = ±30 full credit

  v_wall_cmp   NUMERIC := 0;
  v_iv_cmp     NUMERIC := 0;

  v_news_cmp   NUMERIC := 0;
  v_news_bull  NUMERIC := 0;
  v_news_bear  NUMERIC := 0;
  v_news_n     INT := 0;

  v_spec_cmp   NUMERIC := 0;
  v_spec_n     INT := 0;

  v_oi_cmp     NUMERIC := 0;
  v_oi_n       INT := 0;

  v_raw        NUMERIC;
  v_score      NUMERIC;
  v_lean       TEXT;
  v_n_nonzero  INT := 0;
  v_confidence TEXT;
  v_n_inputs   INT;
BEGIN
  SELECT spot, call_wall, put_wall, iv_rank, regime
  INTO v_snapshot
  FROM ct_ticker_snapshots WHERE ticker = p_ticker;

  -- 1. FLOW ±30. Bullish metric = (call_prem - put_prem), time-decayed.
  -- Put premium ask-side up is BEARISH, so subtract it from the call side.
  -- Normalize by dollar magnitude: $10M net = full credit.
  SELECT
    COALESCE(SUM(
      (COALESCE(net_call_premium,0) - COALESCE(net_put_premium,0))
      / (1 + EXTRACT(EPOCH FROM (p_as_of - tick_timestamp)) / 3600.0)
    ), 0),
    COUNT(*)
  INTO v_flow_w, v_flow_n
  FROM ct_net_premium_ticks
  WHERE ticker = p_ticker
    AND tick_timestamp >= p_as_of - INTERVAL '24 hours';

  v_flow_cmp := GREATEST(-30, LEAST(30, (v_flow_w / v_flow_norm) * 30));
  IF v_flow_n > 0 THEN v_n_nonzero := v_n_nonzero + 1; END IF;
  v_components := v_components || jsonb_build_object(
    'flow', jsonb_build_object(
      'contribution', ROUND(v_flow_cmp, 2),
      'weighted_net_24h', ROUND(v_flow_w, 0),
      'norm_dollar', v_flow_norm,
      'n_ticks', v_flow_n
    )
  );

  -- 2. WALLS — honest skip when UW gex data is unreliable.
  DECLARE
    v_walls_reliable boolean := false;
    v_walls_skip_reason text := null;
  BEGIN
    IF v_snapshot.spot IS NULL OR v_snapshot.call_wall IS NULL OR v_snapshot.put_wall IS NULL THEN
      v_walls_skip_reason := 'no_data';
    ELSIF v_snapshot.call_wall = v_snapshot.put_wall THEN
      v_walls_skip_reason := 'call_wall_equals_put_wall';
    ELSIF ABS(v_snapshot.call_wall - v_snapshot.put_wall) / NULLIF(v_snapshot.spot, 0) < 0.003 THEN
      v_walls_skip_reason := 'walls_too_close';
    ELSE
      v_walls_reliable := true;
    END IF;

    IF v_walls_reliable THEN
      IF v_snapshot.spot > v_snapshot.call_wall THEN
        v_wall_cmp := 10;
      ELSIF v_snapshot.spot < v_snapshot.put_wall THEN
        v_wall_cmp := -10;
      ELSE
        v_wall_cmp := ((v_snapshot.spot - v_snapshot.put_wall)
          / (v_snapshot.call_wall - v_snapshot.put_wall) - 0.5) * 20;
      END IF;
      IF v_snapshot.regime = 'negative_gamma' THEN
        v_wall_cmp := v_wall_cmp * 1.5;
      END IF;
      v_wall_cmp := GREATEST(-15, LEAST(15, v_wall_cmp));
      v_n_nonzero := v_n_nonzero + 1;
    END IF;
    v_components := v_components || jsonb_build_object(
      'walls', jsonb_build_object(
        'contribution', ROUND(v_wall_cmp, 2),
        'spot', v_snapshot.spot, 'call_wall', v_snapshot.call_wall,
        'put_wall', v_snapshot.put_wall, 'regime', v_snapshot.regime,
        'reliable', v_walls_reliable,
        'skip_reason', v_walls_skip_reason
      )
    );
  END;

  -- 3. IV ±10.
  IF v_snapshot.iv_rank IS NOT NULL THEN
    IF v_snapshot.iv_rank >= 70 THEN v_iv_cmp := -5;
    ELSIF v_snapshot.iv_rank <= 30 THEN v_iv_cmp := 5;
    END IF;
    v_n_nonzero := v_n_nonzero + 1;
  END IF;
  v_components := v_components || jsonb_build_object(
    'iv', jsonb_build_object('contribution', v_iv_cmp, 'iv_rank', v_snapshot.iv_rank)
  );

  -- 4. NEWS ±15 with 7d decay.
  SELECT
    COALESCE(SUM(CASE WHEN sentiment = 'bullish'
      THEN COALESCE(severity, 1)::numeric
           / (1 + EXTRACT(EPOCH FROM (p_as_of - ingested_at)) / 21600.0)
      ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN sentiment = 'bearish'
      THEN COALESCE(severity, 1)::numeric
           / (1 + EXTRACT(EPOCH FROM (p_as_of - ingested_at)) / 21600.0)
      ELSE 0 END), 0),
    COUNT(*)
  INTO v_news_bull, v_news_bear, v_news_n
  FROM ct_breaking_news
  WHERE ingested_at >= p_as_of - INTERVAL '7 days'
    AND (tickers_affected @> ARRAY[p_ticker] OR macro_wide = true);

  IF (v_news_bull + v_news_bear) > 0 THEN
    v_news_cmp := ((v_news_bull - v_news_bear) / (v_news_bull + v_news_bear)) * 15;
  END IF;
  IF v_news_n > 0 THEN v_n_nonzero := v_n_nonzero + 1; END IF;
  v_components := v_components || jsonb_build_object(
    'news', jsonb_build_object(
      'contribution', ROUND(v_news_cmp, 2),
      'bull_weight', ROUND(v_news_bull, 2),
      'bear_weight', ROUND(v_news_bear, 2),
      'n_articles', v_news_n
    )
  );

  -- 5. SPECIALIST ±20.
  SELECT
    COALESCE(SUM(
      CASE
        WHEN direction = 'bullish' THEN (score::numeric - 50) * 0.4
        WHEN direction = 'bearish' THEN -(score::numeric - 50) * 0.4
        ELSE 0
      END
    ), 0),
    COUNT(*)
  INTO v_spec_cmp, v_spec_n
  FROM ct_flags
  WHERE specialist_ticker = p_ticker
    AND status IN ('active', 'conviction')
    AND created_at >= p_as_of - INTERVAL '48 hours';
  v_spec_cmp := GREATEST(-20, LEAST(20, v_spec_cmp));
  IF v_spec_n > 0 THEN v_n_nonzero := v_n_nonzero + 1; END IF;
  v_components := v_components || jsonb_build_object(
    'specialist', jsonb_build_object(
      'contribution', ROUND(v_spec_cmp, 2),
      'n_flags', v_spec_n
    )
  );

  -- 6. OI MOMENTUM ±10.
  SELECT
    COALESCE(SUM(
      CASE
        WHEN direction = 'bullish' THEN 1
        WHEN direction = 'bearish' THEN -1
        ELSE 0
      END * LEAST(score::numeric / 20, 5)
    ), 0),
    COUNT(*)
  INTO v_oi_cmp, v_oi_n
  FROM ct_scored_flow
  WHERE ticker = p_ticker
    AND classification = 'opening_buy'
    AND event_ts >= p_as_of - INTERVAL '24 hours'
    AND score >= 60;
  v_oi_cmp := GREATEST(-10, LEAST(10, v_oi_cmp));
  IF v_oi_n > 0 THEN v_n_nonzero := v_n_nonzero + 1; END IF;
  v_components := v_components || jsonb_build_object(
    'oi_momentum', jsonb_build_object(
      'contribution', ROUND(v_oi_cmp, 2),
      'n_events', v_oi_n
    )
  );

  v_raw := 50 + v_flow_cmp + v_wall_cmp + v_iv_cmp + v_news_cmp + v_spec_cmp + v_oi_cmp;
  v_score := GREATEST(0, LEAST(100, v_raw));
  v_lean := CASE
    WHEN v_score >= 60 THEN 'bullish'
    WHEN v_score <= 40 THEN 'bearish'
    ELSE 'neutral'
  END;
  v_confidence := CASE
    WHEN v_n_nonzero >= 5 THEN 'high'
    WHEN v_n_nonzero >= 3 THEN 'med'
    ELSE 'low'
  END;
  v_n_inputs := v_flow_n + v_news_n + v_spec_n + v_oi_n;

  RETURN jsonb_build_object(
    'ticker', p_ticker,
    'score', ROUND(v_score, 1),
    'raw_score', ROUND(v_raw, 2),
    'lean', v_lean,
    'confidence', v_confidence,
    'n_components_nonzero', v_n_nonzero,
    'n_inputs', v_n_inputs,
    'components', v_components,
    'as_of', p_as_of
  );
END
$$;

GRANT EXECUTE ON FUNCTION public.ct_compute_lean_score(TEXT, TIMESTAMPTZ) TO authenticated, service_role;
