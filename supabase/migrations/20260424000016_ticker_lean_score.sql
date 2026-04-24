-- ct_ticker_lean_score — our composite bull/bear lean per ticker.
--
-- Distinct from ct_scored_flow (which scores INDIVIDUAL flow events).
-- This scores THE TICKER as a whole, right now, from everything we know.
-- Score: 0 = max bearish, 50 = neutral, 100 = max bullish.
-- Each component contributes ±N to the neutral midpoint.
--
-- Components (weighted — flow is the primary signal on an options-flow
-- platform, so it gets the biggest ±):
--   Flow          ±30   (net call - put premium last 24h / options_adv_30d, TIME-DECAYED)
--   Specialist    ±20   (active flags direction × (score-50))
--   News          ±15   (severity × sentiment, TIME-DECAYED over 7d)
--   Walls         ±15   (spot vs call/put wall, ×1.5 in negative gamma)
--   OI momentum   ±10   (opening buys score>=60 last 24h)
--   IV            ±10   (extremes: low IV = complacency bull, high IV = fear bear)
--
-- Also emitted:
--   confidence   text   (LOW/MED/HIGH based on # non-zero components)
--   n_inputs     int    (raw count of data points feeding the score)
--
-- Persisted with momentum_delta vs previous live snapshot so UI can
-- show trajectory, not just level.
SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS ct_ticker_lean_score (
  id                 bigserial PRIMARY KEY,
  ticker             text NOT NULL,
  score_at           timestamptz NOT NULL DEFAULT now(),
  score_date         date NOT NULL DEFAULT (now() AT TIME ZONE 'America/New_York')::date,
  is_closing         boolean NOT NULL DEFAULT false,
  score              numeric NOT NULL,
  lean               text NOT NULL CHECK (lean IN ('bullish','bearish','neutral')),
  confidence         text NOT NULL CHECK (confidence IN ('low','med','high')),
  n_inputs           int NOT NULL DEFAULT 0,
  momentum_delta     numeric,                   -- score - last live score (nullable for first)
  breakdown          jsonb NOT NULL,
  UNIQUE (ticker, score_date, is_closing)
);

CREATE INDEX IF NOT EXISTS idx_ct_ticker_lean_score_ticker_date ON ct_ticker_lean_score (ticker, score_date DESC, score_at DESC);
CREATE INDEX IF NOT EXISTS idx_ct_ticker_lean_score_closing ON ct_ticker_lean_score (score_date DESC, is_closing) WHERE is_closing = true;

ALTER TABLE ct_ticker_lean_score ENABLE ROW LEVEL SECURITY;
CREATE POLICY ct_ticker_lean_score_read ON ct_ticker_lean_score FOR SELECT TO authenticated USING (true);
CREATE POLICY ct_ticker_lean_score_svc  ON ct_ticker_lean_score FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE ct_ticker_lean_score IS
  'Composite ticker lean 0-100. 50 neutral, >50 bullish, <50 bearish. Confidence reflects data coverage. Time-decayed components. Retraceable via breakdown jsonb.';

CREATE OR REPLACE FUNCTION public.ct_compute_lean_score(p_ticker TEXT, p_as_of TIMESTAMPTZ DEFAULT now())
RETURNS JSONB
LANGUAGE plpgsql STABLE
SET search_path = public, extensions
AS $$
DECLARE
  v_components JSONB := '{}'::jsonb;
  v_snapshot   RECORD;

  v_flow_cmp   NUMERIC := 0;
  v_flow_w     NUMERIC := 0;      -- time-decayed weighted sum
  v_flow_adv   NUMERIC;
  v_flow_n     INT := 0;

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

  SELECT options_adv_30d INTO v_flow_adv
  FROM ct_ticker_baselines WHERE ticker = p_ticker
  ORDER BY baseline_date DESC LIMIT 1;

  -- 1. FLOW component ±30, time-decayed over 24h.
  -- Weight = 1 / (1 + minutes_old/60). 0min=1.0, 60min=0.5, 360min=0.14.
  SELECT
    COALESCE(SUM(
      (COALESCE(net_call_premium,0) + COALESCE(net_put_premium,0))
      / (1 + EXTRACT(EPOCH FROM (p_as_of - tick_timestamp)) / 3600.0)
    ), 0),
    COUNT(*)
  INTO v_flow_w, v_flow_n
  FROM ct_net_premium_ticks
  WHERE ticker = p_ticker
    AND tick_timestamp >= p_as_of - INTERVAL '24 hours';

  IF v_flow_adv IS NOT NULL AND v_flow_adv > 0 THEN
    v_flow_cmp := GREATEST(-30, LEAST(30, (v_flow_w / v_flow_adv) * 30));
  END IF;
  IF v_flow_n > 0 THEN v_n_nonzero := v_n_nonzero + 1; END IF;
  v_components := v_components || jsonb_build_object(
    'flow', jsonb_build_object(
      'contribution', ROUND(v_flow_cmp, 2),
      'weighted_net_24h', ROUND(v_flow_w, 0),
      'adv_30d', v_flow_adv,
      'n_ticks', v_flow_n
    )
  );

  -- 2. WALLS / gamma component ±15.
  -- HONEST CAVEAT: UW GEX data is currently unreliable (call_wall and put_wall
  -- often collapse to the same round-number strike, e.g. NVDA at 199.65 with
  -- both walls at $200). When that happens we SKIP this component rather
  -- than feeding noise into the composite. The breakdown records the reason.
  DECLARE
    v_walls_reliable boolean := false;
    v_walls_skip_reason text := null;
  BEGIN
    IF v_snapshot.spot IS NULL OR v_snapshot.call_wall IS NULL OR v_snapshot.put_wall IS NULL THEN
      v_walls_skip_reason := 'no_data';
    ELSIF v_snapshot.call_wall = v_snapshot.put_wall THEN
      v_walls_skip_reason := 'call_wall_equals_put_wall';
    ELSIF ABS(v_snapshot.call_wall - v_snapshot.put_wall) / NULLIF(v_snapshot.spot, 0) < 0.003 THEN
      -- Walls <0.3% apart = round-number pin, not informative.
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

  -- 3. IV component ±10.
  IF v_snapshot.iv_rank IS NOT NULL THEN
    IF v_snapshot.iv_rank >= 70 THEN v_iv_cmp := -5;
    ELSIF v_snapshot.iv_rank <= 30 THEN v_iv_cmp := 5;
    END IF;
    v_n_nonzero := v_n_nonzero + 1;
  END IF;
  v_components := v_components || jsonb_build_object(
    'iv', jsonb_build_object('contribution', v_iv_cmp, 'iv_rank', v_snapshot.iv_rank)
  );

  -- 4. NEWS ±15 with decay over 7d.
  -- decay = 1 / (1 + hours_old/6). 1h=0.86, 6h=0.5, 24h=0.2, 72h=0.08.
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

  -- 5. SPECIALIST conviction ±20, last 48h active/conviction flags.
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

  -- 6. OI MOMENTUM ±10 — score>=60 opening buys last 24h.
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

  -- Composite
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

-- Snapshot-all wrapper — computes momentum_delta vs the previous live row.
CREATE OR REPLACE FUNCTION public.ct_snapshot_all_lean_scores(p_is_closing BOOLEAN DEFAULT false)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public, extensions
AS $$
DECLARE
  v_wl    TEXT[] := ARRAY['SPY','QQQ','IWM','AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA'];
  v_t     TEXT;
  v_res   JSONB;
  v_cur   NUMERIC;
  v_prev  NUMERIC;
  v_delta NUMERIC;
  v_count INT := 0;
BEGIN
  FOREACH v_t IN ARRAY v_wl LOOP
    v_res := ct_compute_lean_score(v_t, now());
    v_cur := (v_res->>'score')::numeric;

    -- Previous live score for this ticker (any date)
    SELECT score INTO v_prev FROM ct_ticker_lean_score
    WHERE ticker = v_t AND is_closing = false
    ORDER BY score_at DESC LIMIT 1;
    v_delta := CASE WHEN v_prev IS NULL THEN NULL ELSE v_cur - v_prev END;

    INSERT INTO ct_ticker_lean_score (
      ticker, is_closing, score, lean, confidence, n_inputs,
      momentum_delta, breakdown, score_date
    ) VALUES (
      v_t,
      p_is_closing,
      v_cur,
      v_res->>'lean',
      v_res->>'confidence',
      (v_res->>'n_inputs')::int,
      v_delta,
      v_res->'components',
      (now() AT TIME ZONE 'America/New_York')::date
    )
    ON CONFLICT (ticker, score_date, is_closing) DO UPDATE
    SET score = EXCLUDED.score, lean = EXCLUDED.lean,
        confidence = EXCLUDED.confidence, n_inputs = EXCLUDED.n_inputs,
        momentum_delta = EXCLUDED.momentum_delta,
        breakdown = EXCLUDED.breakdown, score_at = now();
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;

GRANT EXECUTE ON FUNCTION public.ct_snapshot_all_lean_scores(BOOLEAN) TO authenticated, service_role;

-- Cron: live every 15min during RTH, closing snapshot 5min after close.
DO $$ BEGIN PERFORM cron.unschedule('ct-lean-score-live'); EXCEPTION WHEN OTHERS THEN NULL; END $$;
SELECT cron.schedule(
  'ct-lean-score-live',
  '*/15 13-20 * * 1-5',
  $body$SELECT ct_snapshot_all_lean_scores(false);$body$
);

DO $$ BEGIN PERFORM cron.unschedule('ct-lean-score-close'); EXCEPTION WHEN OTHERS THEN NULL; END $$;
SELECT cron.schedule(
  'ct-lean-score-close',
  '5 20 * * 1-5',
  $body$SELECT ct_snapshot_all_lean_scores(true);$body$
);

-- Validation table + function: each closing score graded against
-- next-day price move. Feeds self-improvement.
CREATE TABLE IF NOT EXISTS ct_lean_score_outcomes (
  id               bigserial PRIMARY KEY,
  ticker           text NOT NULL,
  closing_date     date NOT NULL,
  closing_score    numeric NOT NULL,
  closing_lean     text NOT NULL,
  closing_spot     numeric,
  next_close_spot  numeric,
  next_close_pct   numeric,
  outcome          text CHECK (outcome IN ('win','loss','flat','pending')),
  evaluated_at     timestamptz,
  UNIQUE (ticker, closing_date)
);
ALTER TABLE ct_lean_score_outcomes ENABLE ROW LEVEL SECURITY;
CREATE POLICY ct_lean_score_outcomes_read ON ct_lean_score_outcomes FOR SELECT TO authenticated USING (true);
CREATE POLICY ct_lean_score_outcomes_svc  ON ct_lean_score_outcomes FOR ALL TO service_role USING (true) WITH CHECK (true);
