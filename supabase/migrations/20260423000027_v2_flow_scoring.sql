-- ============================================================================
-- Co-Trader v2 — Phase 1b: Flow Scoring Engine
--
-- Builds the 0-100 composite score + classification layer that every Co-Trader
-- v2 flag must pass through. Research-driven: opening-buy intent (Pan-Poteshman),
-- T+1 OI confirmation (Lakonishok), sharp-vs-hedge classification (Augustin/Hu).
--
-- Components:
--   1. ct_scored_flow     — scored + classified flow events (idempotent by source)
--   2. getConfigVal()     — tiny ct_config reader with fallback
--   3. ct_score_flow_event()   — pure scoring function (returns JSONB)
--   4. ct_score_existing_flow()— backfill over ct_sweeps + ct_flow_alerts
--
-- All thresholds live in ct_config — James tunes from the UI, no redeploy.
-- Config seeds at the bottom of this migration.
--
-- NOTE: T+1 OI confirmation cannot be computed at score time (needs tomorrow's
-- OI snapshot). Grader will upgrade scores later. For now that factor defaults
-- to 0 here.
-- ============================================================================
SET search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. ct_scored_flow
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ct_scored_flow (
  id                BIGSERIAL PRIMARY KEY,
  source_table      TEXT NOT NULL,
  source_id         TEXT NOT NULL,
  ticker            TEXT NOT NULL,
  option_symbol     TEXT,
  event_ts          TIMESTAMPTZ NOT NULL,

  -- Classification
  classification    TEXT NOT NULL CHECK (classification IN ('opening_buy','opening_sell','closing','hedge','ambiguous')),
  direction         TEXT NOT NULL CHECK (direction IN ('bullish','bearish','neutral')),

  -- Score
  score             NUMERIC NOT NULL,
  raw_score         NUMERIC NOT NULL,
  score_breakdown   JSONB NOT NULL,
  penalty_breakdown JSONB NOT NULL,

  -- Contract metadata
  strike            NUMERIC,
  expiry            DATE,
  dte               INTEGER,
  delta_est         NUMERIC,
  premium           NUMERIC,
  volume            INTEGER,
  open_interest     INTEGER,
  ask_side_perc     NUMERIC,

  -- Context
  ticker_adv_30d    NUMERIC,
  iv_rank_at_event  NUMERIC,

  scored_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_table, source_id)
);

CREATE INDEX IF NOT EXISTS idx_ct_scored_flow_ticker_score
  ON public.ct_scored_flow (ticker, score DESC, event_ts DESC);
CREATE INDEX IF NOT EXISTS idx_ct_scored_flow_event_ts
  ON public.ct_scored_flow (event_ts DESC);
CREATE INDEX IF NOT EXISTS idx_ct_scored_flow_high_score
  ON public.ct_scored_flow (ticker, event_ts DESC) WHERE score >= 60;

ALTER TABLE public.ct_scored_flow ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ct_scored_flow' AND policyname = 'ct_scored_flow_authread'
  ) THEN
    EXECUTE 'CREATE POLICY ct_scored_flow_authread ON public.ct_scored_flow FOR SELECT TO authenticated USING (true)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ct_scored_flow' AND policyname = 'ct_scored_flow_svcall'
  ) THEN
    EXECUTE 'CREATE POLICY ct_scored_flow_svcall ON public.ct_scored_flow FOR ALL TO service_role USING (true) WITH CHECK (true)';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. getConfigVal — tunable threshold reader with fallback default
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.getConfigVal(p_key TEXT, p_default NUMERIC)
RETURNS NUMERIC
LANGUAGE sql STABLE
SET search_path = public, extensions
AS $$
  SELECT COALESCE(
    (SELECT (value::text)::numeric FROM public.ct_config WHERE key = p_key),
    p_default
  );
$$;

GRANT EXECUTE ON FUNCTION public.getConfigVal(TEXT, NUMERIC) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. ct_score_flow_event — pure scoring (returns JSONB)
--
-- p_side: 'C' or 'P' (normalize 'call'/'put' at call site)
-- p_ask_side_perc: 0-100
-- ---------------------------------------------------------------------------
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

  -- Contract features
  v_dte               INTEGER;
  v_spot              NUMERIC;
  v_iv_rank           NUMERIC;
  v_moneyness_pct     NUMERIC;
  v_delta_est         NUMERIC;
  v_normalized_side   TEXT;

  -- Classification
  v_classification    TEXT;
  v_direction         TEXT;

  -- Positive factor contributions
  f_opening_buy       NUMERIC := 0;
  f_t1_oi_confirm     NUMERIC := 0;  -- Always 0 at score time
  f_single_direction  NUMERIC := 0;
  f_dte               NUMERIC := 0;
  f_delta             NUMERIC := 0;
  f_iv_context        NUMERIC := 0;
  f_size_vs_adv       NUMERIC := 0;

  -- Penalty contributions
  p_hedge             NUMERIC := 0;
  p_earnings          NUMERIC := 0;
  p_expiration        NUMERIC := 0;
  p_dealer_hedge      NUMERIC := 0;

  v_is_etf            BOOLEAN;
  v_is_itm            BOOLEAN;
  v_has_earnings_near BOOLEAN;
  v_is_expiration_wk  BOOLEAN;
  v_dow               INTEGER;
  v_third_friday      DATE;

  -- Size vs ADV
  v_table_exists      BOOLEAN;
  v_premium_rank      NUMERIC;  -- 0-1 percentile within 30d

  -- Recent move (for dealer-hedge penalty)
  v_recent_move_pct   NUMERIC;

  v_raw_score         NUMERIC;
  v_total_penalty     NUMERIC;
  v_score             NUMERIC;
BEGIN
  -- ask_side_perc arrives as 0-100. Phase 1a seeded the threshold as a
  -- fraction (0.60); treat any value <= 1 as a fraction and scale to percent.
  v_ask_thresh := getConfigVal('score.opening_buy_ask_threshold', 60);
  IF v_ask_thresh <= 1 THEN
    v_ask_thresh := v_ask_thresh * 100;
  END IF;

  -- Normalize side
  v_normalized_side := CASE
    WHEN upper(COALESCE(p_side, '')) IN ('C','CALL') THEN 'C'
    WHEN upper(COALESCE(p_side, '')) IN ('P','PUT')  THEN 'P'
    ELSE NULL
  END;

  -- ---- DTE ----
  IF p_expiry IS NOT NULL THEN
    v_dte := GREATEST(0, (p_expiry - p_event_ts::date));
  END IF;

  -- ---- Pull ticker snapshot (spot + iv_rank) once ----
  SELECT spot, iv_rank INTO v_spot, v_iv_rank
  FROM public.ct_ticker_snapshots
  WHERE ticker = p_ticker;

  -- ---- Classification ----
  -- opening_buy: ask_side_perc >= threshold AND vol > OI AND NOT multileg AND NOT floor
  -- opening_sell: ask_side_perc < (100 - threshold) AND vol > OI
  -- closing: vol < OI
  -- hedge: multileg OR floor
  -- else: ambiguous
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

  -- ---- Direction ----
  v_direction := CASE
    WHEN v_normalized_side = 'C' AND v_classification = 'opening_buy'  THEN 'bullish'
    WHEN v_normalized_side = 'C' AND v_classification = 'opening_sell' THEN 'bearish'
    WHEN v_normalized_side = 'P' AND v_classification = 'opening_buy'  THEN 'bearish'
    WHEN v_normalized_side = 'P' AND v_classification = 'opening_sell' THEN 'bullish'
    ELSE 'neutral'
  END;

  -- ======================================================================
  -- POSITIVE FACTORS
  -- ======================================================================

  -- ---- opening_buy (25) — partial credit per component ----
  -- Components: ask >= thresh (10), vol > OI (10), not multileg (2.5), not floor (2.5)
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

  -- ---- t1_oi_confirm (20) — always 0 at score time; grader upgrades later ----
  f_t1_oi_confirm := 0;

  -- ---- single_direction (15) — v1 heuristic: sweep AND NOT multileg ----
  IF p_is_sweep AND NOT p_is_multileg THEN
    f_single_direction := 15;
  END IF;

  -- ---- dte_band (10) — full [15,45], half [7,14] or [46,60], zero outside ----
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

  -- ---- delta_band (10) — moneyness heuristic against spot ----
  -- No spot or strike: 0 credit (conservative).
  -- Moneyness pct = (strike - spot) / spot for calls, (spot - strike) / spot for puts.
  -- Sharp zone: OTM 0-15% → ~40-55 delta for 30 DTE call. Full credit.
  -- Near ITM or mild OTM (−10% to 0%) → still in band. Full credit.
  -- Deep OTM (>25%) → lottery; zero.
  -- Deep ITM (<-20%) → delta-1; zero.
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

    -- Rough delta estimate for storage
    v_delta_est := CASE
      WHEN v_moneyness_pct <= -20 THEN 0.9
      WHEN v_moneyness_pct <= -10 THEN 0.7
      WHEN v_moneyness_pct <=   0 THEN 0.55
      WHEN v_moneyness_pct <=  10 THEN 0.4
      WHEN v_moneyness_pct <=  20 THEN 0.25
      ELSE 0.1
    END;
  END IF;

  -- ---- iv_context (10) — IV rank at event time ----
  IF v_iv_rank IS NOT NULL THEN
    IF v_iv_rank < v_iv_low THEN
      f_iv_context := 10;
    ELSIF v_iv_rank <= v_iv_high THEN
      f_iv_context := 5;
    ELSE
      f_iv_context := 0;
    END IF;
  END IF;

  -- ---- size_vs_adv (10) — premium percentile vs ticker's 30d options flow ----
  -- ct_ticker_baselines may not exist yet (Phase 1a pending). Degrade gracefully.
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'ct_ticker_baselines'
  ) INTO v_table_exists;

  IF v_table_exists AND p_premium IS NOT NULL THEN
    -- Try to pull options_adv_30d from baselines (structure TBD — fall through if column missing).
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

  -- ======================================================================
  -- PENALTIES
  -- ======================================================================

  -- ---- hedge_max (30) — ETF + ITM + DTE>60 ----
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

  -- ---- earnings_max (20) — next_earnings within window_days ----
  SELECT EXISTS (
    SELECT 1 FROM public.ct_events
    WHERE event_type = 'earnings'
      AND ticker = p_ticker
      AND event_date BETWEEN p_event_ts::date AND (p_event_ts::date + (v_earnings_window_d || ' days')::interval)::date
  ) INTO v_has_earnings_near;

  IF v_has_earnings_near THEN
    p_earnings := v_earnings_max;
  END IF;

  -- ---- expiration_max (15) — expiry within monthly expiration week (3rd Friday) ----
  IF p_expiry IS NOT NULL THEN
    -- Compute 3rd Friday of expiry's month.
    v_third_friday := date_trunc('month', p_expiry)::date;
    v_dow := EXTRACT(DOW FROM v_third_friday)::int;  -- 0=Sun .. 6=Sat
    -- First Friday of month:
    v_third_friday := v_third_friday + ((5 - v_dow + 7) % 7);
    -- Third Friday:
    v_third_friday := v_third_friday + 14;
    IF p_expiry = v_third_friday OR p_expiry BETWEEN (v_third_friday - 4) AND v_third_friday THEN
      p_expiration := v_expiration_max;
    END IF;
  END IF;

  -- ---- dealer_hedge_max (15) ----
  -- Check if underlying moved >1% in last 30 min from ct_interval_flow or similar.
  -- Degrade gracefully if data unavailable.
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
    -- Dealer-hedge pattern: flow direction matches the move direction.
    -- v1: conservative — apply half penalty just for large recent move + sweep.
    IF p_is_sweep THEN
      p_dealer_hedge := v_dealer_hedge_max / 2;
    END IF;
  END IF;

  -- ======================================================================
  -- COMPOSITE
  -- ======================================================================
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

-- ---------------------------------------------------------------------------
-- 4. ct_score_existing_flow — backfill over ct_sweeps + ct_flow_alerts
--
-- Idempotent via UNIQUE (source_table, source_id). Returns rows written.
-- ---------------------------------------------------------------------------
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
      type AS side,                 -- 'C' | 'P' in ct_sweeps
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
      FALSE,  -- is_multileg (ct_sweeps doesn't track; default false)
      FALSE   -- is_floor
    );

    INSERT INTO public.ct_scored_flow (
      source_table, source_id, ticker, option_symbol, event_ts,
      classification, direction, score, raw_score, score_breakdown, penalty_breakdown,
      strike, expiry, dte, delta_est, premium, volume, open_interest, ask_side_perc,
      iv_rank_at_event
    ) VALUES (
      'ct_sweeps', r.source_id, r.ticker, r.option_symbol, r.event_ts,
      j->>'classification', j->>'direction',
      (j->>'score')::numeric, (j->>'raw_score')::numeric,
      j->'breakdown', j->'penalty',
      r.strike, r.expiry, (j->>'dte')::integer,
      NULLIF(j->>'delta_est', '')::numeric,
      r.premium, r.volume, r.open_interest, r.ask_side_perc,
      NULLIF(j->>'iv_rank', '')::numeric
    )
    ON CONFLICT (source_table, source_id) DO NOTHING;

    IF FOUND THEN v_count := v_count + 1; END IF;
  END LOOP;

  -- ---- ct_flow_alerts ----
  FOR r IN
    SELECT
      id::TEXT AS source_id,
      ticker,
      option_symbol,
      strike,
      expiry,
      CASE WHEN lower(side) = 'call' THEN 'C'
           WHEN lower(side) = 'put'  THEN 'P'
           ELSE side END AS side,
      premium,
      volume::integer AS volume,
      open_interest::integer AS open_interest,
      CASE
        WHEN is_ask IS TRUE  THEN 100
        WHEN is_bid IS TRUE  THEN 0
        ELSE 50
      END::numeric AS ask_side_perc,
      executed_at AS event_ts,
      alert_type
    FROM public.ct_flow_alerts
    WHERE executed_at >= p_since
      AND ticker = ANY(v_wl)
      AND side IN ('call','put','C','P')
  LOOP
    j := public.ct_score_flow_event(
      r.ticker, r.option_symbol, r.strike, r.expiry,
      r.side, r.premium, r.volume, r.open_interest, r.ask_side_perc,
      r.event_ts,
      (r.alert_type = 'sweep'),  -- is_sweep
      FALSE,                     -- is_multileg
      FALSE                      -- is_floor
    );

    INSERT INTO public.ct_scored_flow (
      source_table, source_id, ticker, option_symbol, event_ts,
      classification, direction, score, raw_score, score_breakdown, penalty_breakdown,
      strike, expiry, dte, delta_est, premium, volume, open_interest, ask_side_perc,
      iv_rank_at_event
    ) VALUES (
      'ct_flow_alerts', r.source_id, r.ticker, r.option_symbol, r.event_ts,
      j->>'classification', j->>'direction',
      (j->>'score')::numeric, (j->>'raw_score')::numeric,
      j->'breakdown', j->'penalty',
      r.strike, r.expiry, (j->>'dte')::integer,
      NULLIF(j->>'delta_est', '')::numeric,
      r.premium, r.volume, r.open_interest, r.ask_side_perc,
      NULLIF(j->>'iv_rank', '')::numeric
    )
    ON CONFLICT (source_table, source_id) DO NOTHING;

    IF FOUND THEN v_count := v_count + 1; END IF;
  END LOOP;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ct_score_existing_flow(TIMESTAMPTZ) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Config seeds — tunable thresholds
-- ---------------------------------------------------------------------------
INSERT INTO public.ct_config (key, value, description, category, min_value, max_value, default_value) VALUES
  ('score.opening_buy_ask_threshold', '60'::jsonb,
    'Ask-side percent required for opening_buy classification (James: 60%, tunable).',
    'score', 30, 95, '60'::jsonb),
  ('score.dte_band_lo', '15'::jsonb,
    'DTE band lower bound (full credit).',
    'score', 1, 60, '15'::jsonb),
  ('score.dte_band_hi', '45'::jsonb,
    'DTE band upper bound (full credit).',
    'score', 10, 180, '45'::jsonb),
  ('score.dte_half_lo', '7'::jsonb,
    'DTE half-credit lower bound.',
    'score', 0, 30, '7'::jsonb),
  ('score.dte_half_hi', '60'::jsonb,
    'DTE half-credit upper bound.',
    'score', 30, 365, '60'::jsonb),
  ('score.iv_low', '30'::jsonb,
    'IV rank below this = full iv_context credit.',
    'score', 0, 100, '30'::jsonb),
  ('score.iv_high', '70'::jsonb,
    'IV rank above this = zero iv_context credit.',
    'score', 0, 100, '70'::jsonb),
  ('score.slack_threshold', '80'::jsonb,
    'Composite score at or above this triggers Slack push (v1 launch).',
    'score', 40, 100, '80'::jsonb),
  ('penalty.hedge_max', '30'::jsonb,
    'Max hedge penalty deducted.',
    'score', 0, 100, '30'::jsonb),
  ('penalty.earnings_max', '20'::jsonb,
    'Max earnings penalty deducted.',
    'score', 0, 100, '20'::jsonb),
  ('penalty.earnings_window_days', '5'::jsonb,
    'Trailing days before earnings where penalty applies.',
    'score', 0, 30, '5'::jsonb),
  ('penalty.expiration_max', '15'::jsonb,
    'Max expiration-week penalty deducted.',
    'score', 0, 100, '15'::jsonb),
  ('penalty.dealer_hedge_max', '15'::jsonb,
    'Max dealer-hedge penalty deducted.',
    'score', 0, 100, '15'::jsonb)
ON CONFLICT (key) DO NOTHING;
