-- Fix put_call_ratio formula in build_ticker_quant_card.
--
-- The 4/22 multi-view used SIGNED net_call_volume / net_put_volume which
-- gives non-intuitive results (SPY showed -23.85). The textbook put-call
-- ratio uses TOTAL volumes (counts, not signed). ct_net_premium_ticks.raw
-- has put_volume and call_volume as positive integer counts — use those.
--
-- Higher ratio = more put-side activity. <1 means call-dominated, >1 means
-- put-dominated. Standard market-internals interpretation.
--
-- Only the put_call_ratio computation changes. Everything else identical to
-- 20260428200000.

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.build_ticker_quant_card(
  p_ticker text,
  p_as_of  timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_ticker       text := upper(trim(p_ticker));
  v_as_of        timestamptz := p_as_of;
  v_hour_ago     timestamptz := p_as_of - interval '1 hour';
  v_day_30_ago   timestamptz := p_as_of - interval '30 days';
  v_day_7_ago    timestamptz := p_as_of - interval '7 days';
  v_day_90_ago   timestamptz := p_as_of - interval '90 days';
  v_day_24h_ago  timestamptz := p_as_of - interval '24 hours';
  v_today        date        := (p_as_of AT TIME ZONE 'UTC')::date;
  v_month_int    int         := EXTRACT(month FROM p_as_of)::int;

  v_gen_id                   uuid;
  v_gen_started_at           timestamptz;
  v_gen_target_days          int;
  v_gen_days_remaining       int;

  v_structural               jsonb;
  v_flow_last_hour           jsonb;
  v_positioning              jsonb;
  v_macro                    jsonb;
  v_sentiment                jsonb;
  v_historical               jsonb;
  v_brief                    jsonb;
  v_freshness                jsonb;

  v_legacy_flow              jsonb;
  v_legacy_dp                jsonb;
  v_legacy_greek             jsonb;
  v_legacy_events            jsonb;

  v_latest_snapshot_at       timestamptz;
  v_gamma_flip               numeric;
BEGIN
  SELECT g.id, g.started_at, g.target_days,
         g.target_days - EXTRACT(day FROM (v_as_of - g.started_at))::int
    INTO v_gen_id, v_gen_started_at, v_gen_target_days, v_gen_days_remaining
  FROM ct_claude_generations g
  WHERE g.status = 'active'
  ORDER BY g.generation_number DESC
  LIMIT 1;

  -- STRUCTURAL
  SELECT max(snapshot_at) INTO v_latest_snapshot_at
  FROM ct_gex_timeseries
  WHERE ticker = v_ticker
    AND snapshot_at <= v_as_of
    AND snapshot_at >= v_as_of - interval '24 hours';

  v_gamma_flip := public.ct_compute_gamma_flip(v_ticker, v_as_of);

  WITH gex_rows AS (
    SELECT * FROM ct_gex_timeseries
    WHERE ticker = v_ticker AND snapshot_at = v_latest_snapshot_at
  ),
  call_wall AS (
    SELECT strike FROM gex_rows WHERE call_gex IS NOT NULL
    ORDER BY call_gex DESC NULLS LAST LIMIT 1
  ),
  put_wall AS (
    SELECT strike FROM gex_rows WHERE put_gex IS NOT NULL
    ORDER BY abs(put_gex) DESC NULLS LAST LIMIT 1
  ),
  spot_r AS (
    SELECT underlying_price AS spot FROM gex_rows
    WHERE underlying_price IS NOT NULL LIMIT 1
  ),
  net_gamma_r AS (SELECT sum(net_gex) AS net_gamma FROM gex_rows),
  iv_r AS (
    SELECT iv_rank, iv_percentile FROM ct_iv_rank_daily
    WHERE ticker = v_ticker AND date <= v_today
    ORDER BY date DESC LIMIT 1
  ),
  mp_r AS (
    SELECT max_pain_strike FROM ct_max_pain_daily
    WHERE ticker = v_ticker AND date <= v_today
    ORDER BY date DESC, expiry ASC LIMIT 1
  )
  SELECT jsonb_build_object(
    'spot',          (SELECT spot FROM spot_r),
    'gamma_flip',    v_gamma_flip,
    'call_wall',     (SELECT strike FROM call_wall),
    'put_wall',      (SELECT strike FROM put_wall),
    'max_pain',      (SELECT max_pain_strike FROM mp_r),
    'iv_rank',       (SELECT iv_rank FROM iv_r),
    'iv_percentile', (SELECT iv_percentile FROM iv_r),
    'net_gamma',     (SELECT net_gamma FROM net_gamma_r),
    'regime',        CASE
                       WHEN (SELECT net_gamma FROM net_gamma_r) > 0 THEN 'positive_gamma'
                       WHEN (SELECT net_gamma FROM net_gamma_r) < 0 THEN 'negative_gamma'
                       ELSE 'neutral'
                     END
  ) INTO v_structural;

  -- FLOW last hour
  WITH flow_agg AS (
    SELECT
      sum(CASE WHEN side='call' THEN premium ELSE 0 END) AS net_call_prem,
      sum(CASE WHEN side='put'  THEN premium ELSE 0 END) AS net_put_prem,
      count(*) FILTER (WHERE alert_type ILIKE '%sweep%') AS sweep_count,
      jsonb_agg(
        jsonb_build_object(
          'side', side, 'strike', strike, 'expiry', expiry,
          'premium', premium, 'size', size, 'alert_type', alert_type,
          'executed_at', executed_at
        ) ORDER BY premium DESC
      ) FILTER (WHERE alert_type ILIKE '%whale%') AS whales
    FROM ct_flow_alerts
    WHERE ticker = v_ticker
      AND executed_at BETWEEN v_hour_ago AND v_as_of
  ),
  dp_agg AS (
    SELECT sum(notional_value) AS dp_accumulation
    FROM ct_dark_pool_prints
    WHERE ticker = v_ticker
      AND executed_at BETWEEN v_hour_ago AND v_as_of
  ),
  greek_agg AS (
    SELECT
      sum(total_delta_flow) AS greek_flow_delta,
      sum(total_vega_flow)  AS greek_flow_vega
    FROM ct_greek_flow_minute
    WHERE ticker = v_ticker
      AND tick_timestamp BETWEEN v_hour_ago AND v_as_of
  )
  SELECT jsonb_build_object(
    'net_call_prem',    COALESCE((SELECT net_call_prem FROM flow_agg), 0),
    'net_put_prem',     COALESCE((SELECT net_put_prem  FROM flow_agg), 0),
    'whales',           COALESCE((SELECT whales FROM flow_agg), '[]'::jsonb),
    'sweep_count',      COALESCE((SELECT sweep_count FROM flow_agg), 0),
    'dp_accumulation',  COALESCE((SELECT dp_accumulation FROM dp_agg), 0),
    'greek_flow_delta', COALESCE((SELECT greek_flow_delta FROM greek_agg), 0),
    'greek_flow_vega',  COALESCE((SELECT greek_flow_vega  FROM greek_agg), 0)
  ) INTO v_flow_last_hour;

  -- POSITIONING
  WITH insiders AS (
    SELECT jsonb_agg(
      jsonb_build_object(
        'insider_name', insider_name, 'insider_title', insider_title,
        'transaction_type', transaction_type, 'shares', shares,
        'price', price, 'value_usd', value_usd,
        'trade_date', trade_date, 'filing_date', filing_date
      ) ORDER BY trade_date DESC NULLS LAST
    ) AS rows_j
    FROM (
      SELECT * FROM ct_insider_trades
      WHERE ticker = v_ticker
        AND (trade_date IS NULL OR trade_date >= v_day_30_ago::date)
      ORDER BY trade_date DESC NULLS LAST
      LIMIT 25
    ) q
  ),
  politicals AS (
    SELECT jsonb_agg(
      jsonb_build_object(
        'trader_name', trader_name, 'chamber', chamber, 'party', party,
        'side', side, 'amount_band_usd', amount_band_usd,
        'traded_at', traded_at, 'reported_at', reported_at
      ) ORDER BY traded_at DESC NULLS LAST
    ) AS rows_j
    FROM (
      SELECT * FROM ct_political_trades
      WHERE ticker = v_ticker
        AND (traded_at IS NULL OR traded_at >= v_day_30_ago::date)
      ORDER BY traded_at DESC NULLS LAST
      LIMIT 25
    ) q
  ),
  analysts AS (
    SELECT jsonb_agg(
      jsonb_build_object(
        'analyst_firm', analyst_firm, 'action_type', action_type,
        'from_rating', from_rating, 'to_rating', to_rating,
        'price_target', price_target, 'prior_price_target', prior_price_target,
        'action_date', action_date
      ) ORDER BY action_date DESC NULLS LAST
    ) AS rows_j
    FROM (
      SELECT * FROM ct_analyst_actions
      WHERE ticker = v_ticker
        AND (action_date IS NULL OR action_date >= v_day_7_ago::date)
      ORDER BY action_date DESC NULLS LAST
      LIMIT 25
    ) q
  ),
  short_i AS (
    SELECT jsonb_build_object(
      'report_date', report_date,
      'short_interest_shares', short_interest_shares,
      'short_interest_pct_float', short_interest_pct_float,
      'days_to_cover', days_to_cover,
      'short_volume_ratio_recent', short_volume_ratio_recent
    ) AS obj
    FROM ct_short_interest
    WHERE ticker = v_ticker
    ORDER BY report_date DESC
    LIMIT 1
  )
  SELECT jsonb_build_object(
    'insider_trades_last_30d',
      COALESCE((SELECT rows_j FROM insiders), '[]'::jsonb),
    'political_trades_last_30d',
      COALESCE((SELECT rows_j FROM politicals), '[]'::jsonb),
    'analyst_actions_last_7d',
      COALESCE((SELECT rows_j FROM analysts), '[]'::jsonb),
    'institutional_changes_last_90d',
      public._qc_maybe_read(format(
        $q$ SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY (t.as_of_date) DESC), '[]'::jsonb)
            FROM (
              SELECT *
              FROM ct_institutional_holdings
              WHERE ticker = %L
                AND as_of_date >= %L::date
              ORDER BY as_of_date DESC
              LIMIT 25
            ) t $q$,
        v_ticker, v_day_90_ago
      )),
    'short_interest',   (SELECT obj FROM short_i)
  ) INTO v_positioning;

  -- MACRO
  WITH vix_r AS (
    SELECT jsonb_build_object(
      'date', date, 'level', level, 'change_pct', change_pct, 'tier', tier
    ) AS obj
    FROM ct_vix_history
    WHERE date <= v_today
    ORDER BY date DESC LIMIT 1
  ),
  sector_r AS (
    SELECT jsonb_agg(obj ORDER BY captured_at DESC) AS rows_j
    FROM (
      SELECT DISTINCT ON (sector)
        jsonb_build_object(
          'sector', sector, 'captured_at', captured_at,
          'net_call_premium', net_call_premium,
          'net_put_premium',  net_put_premium,
          'net_delta', net_delta, 'net_vega', net_vega
        ) AS obj,
        captured_at
      FROM ct_sector_tide
      WHERE captured_at >= v_as_of - interval '4 hours'
      ORDER BY sector, captured_at DESC
    ) q
  ),
  bn_r AS (
    SELECT jsonb_agg(
      jsonb_build_object(
        'headline', headline, 'severity', severity,
        'sentiment', sentiment, 'category', category,
        'summary', summary, 'tickers_affected', tickers_affected,
        'macro_wide', macro_wide, 'ingested_at', ingested_at
      ) ORDER BY ingested_at DESC
    ) AS rows_j
    FROM (
      SELECT * FROM ct_breaking_news
      WHERE ingested_at >= v_day_24h_ago
        AND (v_ticker = ANY(tickers_affected) OR macro_wide = true)
      ORDER BY severity DESC, ingested_at DESC
      LIMIT 10
    ) q
  )
  SELECT jsonb_build_object(
    'vix_latest',            (SELECT obj FROM vix_r),
    'yield_curve_snapshot',  public._qc_maybe_read(
      $q$ SELECT to_jsonb(t) FROM (
          SELECT * FROM ct_yield_curve
          ORDER BY captured_at DESC
          LIMIT 1
        ) t $q$
    ),
    'central_bank_state',    public._qc_maybe_read(
      $q$ SELECT to_jsonb(t) FROM (
          SELECT * FROM ct_central_bank_rates
          ORDER BY captured_at DESC
          LIMIT 1
        ) t $q$
    ),
    'correlations',          public._qc_maybe_read(format(
      $q$ SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY (t.captured_at) DESC), '[]'::jsonb)
          FROM (
            SELECT *
            FROM ct_correlations
            WHERE ticker_a = %L
              AND window_days = 20
            ORDER BY captured_at DESC
            LIMIT 25
          ) t $q$,
      v_ticker
    )),
    'sector_tide_today',     COALESCE((SELECT rows_j FROM sector_r), '[]'::jsonb),
    'breaking_news_last_24h', COALESCE((SELECT rows_j FROM bn_r), '[]'::jsonb)
  ) INTO v_macro;

  -- SENTIMENT — fixed put_call_ratio uses TOTAL volumes from raw json
  WITH nope_r AS (
    SELECT nope FROM ct_nope_minute
    WHERE ticker = v_ticker AND tick_timestamp <= v_as_of
    ORDER BY tick_timestamp DESC LIMIT 1
  ),
  np_cum AS (
    SELECT
      sum(COALESCE(net_call_premium,0) - COALESCE(net_put_premium,0)) AS net_premium_cum_today,
      -- Total (unsigned) volumes from raw json — these are absolute counts
      -- of put/call traded volume, not signed deltas. Textbook PC ratio.
      sum(COALESCE(NULLIF(raw->>'call_volume','')::numeric, 0)) AS call_vol_total,
      sum(COALESCE(NULLIF(raw->>'put_volume','')::numeric, 0))  AS put_vol_total
    FROM ct_net_premium_ticks
    WHERE ticker = v_ticker
      AND tick_timestamp >= date_trunc('day', v_as_of AT TIME ZONE 'America/New_York')
                            AT TIME ZONE 'America/New_York'
      AND tick_timestamp <= v_as_of
  ),
  news_r AS (
    SELECT jsonb_agg(
      jsonb_build_object(
        'headline', news_headline, 'source', news_source,
        'impact', impact, 'significance', significance,
        'claude_take', left(coalesce(claude_take,''), 300),
        'news_timestamp', news_timestamp, 'created_at', created_at
      ) ORDER BY created_at DESC
    ) AS rows_j
    FROM (
      SELECT * FROM ct_news_analyses
      WHERE instrument = v_ticker
      ORDER BY created_at DESC
      LIMIT 10
    ) q
  )
  SELECT jsonb_build_object(
    'nope_latest',               (SELECT nope FROM nope_r),
    -- Standard put-call ratio: total put volume / total call volume.
    -- <1 = call-dominated, >1 = put-dominated.
    'put_call_ratio',            CASE
      WHEN COALESCE((SELECT call_vol_total FROM np_cum),0) = 0 THEN NULL
      ELSE ROUND(
             ((SELECT put_vol_total FROM np_cum) /
              NULLIF((SELECT call_vol_total FROM np_cum), 0))::numeric,
             3)
    END,
    'net_premium_cum_today',     COALESCE((SELECT net_premium_cum_today FROM np_cum), 0),
    'net_premium_cum',           COALESCE((SELECT net_premium_cum_today FROM np_cum), 0),
    'prediction_market_overlay', public._qc_maybe_read(format(
      $q$ SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY (t.captured_at) DESC), '[]'::jsonb)
          FROM (
            SELECT *
            FROM ct_prediction_markets
            WHERE ticker = %L OR ticker IS NULL
            ORDER BY captured_at DESC
            LIMIT 10
          ) t $q$,
      v_ticker
    )),
    'recent_news',               COALESCE((SELECT rows_j FROM news_r), '[]'::jsonb)
  ) INTO v_sentiment;

  -- HISTORICAL
  WITH em_r AS (
    SELECT jsonb_agg(
      jsonb_build_object(
        'report_date', report_date, 'move_pct', move_pct,
        'move_direction', move_direction, 'beat_miss', beat_miss,
        'surprise_pct', surprise_pct
      ) ORDER BY report_date DESC
    ) AS rows_j
    FROM (
      SELECT * FROM ct_earnings_moves
      WHERE ticker = v_ticker
      ORDER BY report_date DESC LIMIT 8
    ) q
  ),
  next_earn AS (
    SELECT jsonb_build_object(
      'date', event_date,
      'expected_move', (raw ->> 'expected_move')::numeric
    ) AS obj
    FROM ct_events
    WHERE event_type = 'earnings'
      AND ticker = v_ticker
      AND event_date >= v_today
    ORDER BY event_date ASC
    LIMIT 1
  )
  SELECT jsonb_build_object(
    'seasonality',              public._qc_maybe_read(format(
      $q$ SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY (t.month_int) ASC), '[]'::jsonb)
          FROM (
            SELECT *
            FROM ct_seasonality
            WHERE ticker = %L
              AND month_int = %s
            ORDER BY month_int ASC
            LIMIT 5
          ) t $q$,
      v_ticker, v_month_int
    )),
    'earnings_history',         COALESCE((SELECT rows_j FROM em_r), '[]'::jsonb),
    'next_earnings',            (SELECT obj FROM next_earn),
    'recent_indicator_events',  public._qc_maybe_read(format(
      $q$ SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY (t.event_at) DESC), '[]'::jsonb)
          FROM (
            SELECT *
            FROM ct_indicator_events
            WHERE (ticker = %L OR ticker IS NULL)
              AND event_at >= %L
            ORDER BY event_at DESC
            LIMIT 15
          ) t $q$,
      v_ticker, v_day_7_ago
    ))
  ) INTO v_historical;

  -- BRIEF
  WITH latest_brief AS (
    SELECT id, per_ticker, watchlist_focus, skip_today, session_date
    FROM ct_daily_briefs
    WHERE expires_at >= v_as_of AND supersedes_id IS NULL
    ORDER BY created_at DESC LIMIT 1
  ),
  brief_r AS (
    SELECT
      lb.id AS brief_id,
      (
        SELECT jsonb_array_elements(lb.per_ticker) ->> 'tilt'
        FROM jsonb_array_elements(lb.per_ticker) elem
        WHERE (elem ->> 'ticker') = v_ticker
        LIMIT 1
      ) AS tilt,
      (
        SELECT jsonb_array_elements(lb.per_ticker) ->> 'focus_level'
        FROM jsonb_array_elements(lb.per_ticker) elem
        WHERE (elem ->> 'ticker') = v_ticker
        LIMIT 1
      ) AS focus_level,
      v_ticker = ANY(lb.skip_today) AS avoid_today
    FROM latest_brief lb
  )
  SELECT jsonb_build_object(
    'tilt',             (SELECT tilt FROM brief_r),
    'focus_level',      (SELECT focus_level FROM brief_r),
    'avoid_today',      COALESCE((SELECT avoid_today FROM brief_r), false),
    'source_brief_id',  (SELECT brief_id FROM brief_r)
  ) INTO v_brief;

  -- FRESHNESS
  v_freshness := jsonb_build_object(
    'snapshot_at',    v_latest_snapshot_at,
    'seconds_stale',  CASE
                        WHEN v_latest_snapshot_at IS NULL THEN NULL
                        ELSE EXTRACT(EPOCH FROM (v_as_of - v_latest_snapshot_at))
                      END
  );

  -- Legacy aliases
  BEGIN
    SELECT jsonb_build_object(
      'alert_count',    COALESCE(count(*), 0),
      'total_premium',  COALESCE(sum(premium), 0),
      'net_call_prem',  COALESCE(sum(CASE WHEN side='call' THEN premium ELSE 0 END), 0),
      'net_put_prem',   COALESCE(sum(CASE WHEN side='put'  THEN premium ELSE 0 END), 0),
      'net_prem',       COALESCE(sum(CASE WHEN side='call' THEN premium ELSE 0 END)
                              - sum(CASE WHEN side='put'  THEN premium ELSE 0 END), 0),
      'whale_count',    COALESCE(count(*) FILTER (WHERE alert_type ILIKE '%whale%'), 0),
      'sweep_count',    COALESCE(count(*) FILTER (WHERE alert_type ILIKE '%sweep%'), 0),
      'opening_trades', COALESCE(count(*) FILTER (WHERE size_gt_oi = true), 0)
    ) INTO v_legacy_flow
    FROM ct_flow_alerts
    WHERE ticker = v_ticker
      AND executed_at BETWEEN v_hour_ago AND v_as_of;

    SELECT jsonb_build_object(
      'print_count',        COALESCE(count(*), 0),
      'total_notional',     COALESCE(sum(notional_value), 0),
      'largest_single',     COALESCE(max(notional_value), 0),
      'accumulation_score', COALESCE(sum(notional_value), 0)
    ) INTO v_legacy_dp
    FROM ct_dark_pool_prints
    WHERE ticker = v_ticker
      AND executed_at BETWEEN v_hour_ago AND v_as_of;

    SELECT jsonb_build_object(
      'net_delta_flow',  COALESCE(sum(total_delta_flow), 0),
      'net_vega_flow',   COALESCE(sum(total_vega_flow),  0),
      'net_call_delta',  COALESCE(sum(net_call_delta),   0),
      'net_put_delta',   COALESCE(sum(net_put_delta),    0),
      'tick_count',      COALESCE(count(*), 0)
    ) INTO v_legacy_greek
    FROM ct_greek_flow_minute
    WHERE ticker = v_ticker
      AND tick_timestamp BETWEEN v_hour_ago AND v_as_of;

    SELECT jsonb_build_object(
      'next_earnings_date',     ne.event_date,
      'earnings_expected_move', (ne.raw ->> 'expected_move')::numeric,
      'upcoming_catalysts', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'event_type', event_type, 'event_date', event_date,
            'event_time', event_time, 'title', title, 'importance', importance
          ) ORDER BY event_date ASC
        )
        FROM ct_events
        WHERE (ticker = v_ticker OR ticker IS NULL)
          AND event_date BETWEEN v_today AND (v_today + 7)
      ), '[]'::jsonb)
    ) INTO v_legacy_events
    FROM (
      SELECT event_date, raw FROM ct_events
      WHERE event_type = 'earnings' AND ticker = v_ticker AND event_date >= v_today
      ORDER BY event_date ASC LIMIT 1
    ) ne;
  END;

  RETURN jsonb_build_object(
    'ticker',                    v_ticker,
    'as_of',                     v_as_of,
    'generation_id',             v_gen_id,
    'generation_days_remaining', v_gen_days_remaining,
    'structural',                v_structural,
    'flow_last_hour',            v_legacy_flow || v_flow_last_hour,
    'positioning',               v_positioning,
    'macro',                     v_macro,
    'sentiment',                 v_sentiment,
    'historical',                v_historical,
    'brief',                     v_brief,
    'freshness',                 v_freshness,
    'structure',                 v_structural,
    'dark_pool_last_hour',       v_legacy_dp,
    'greek_flow_last_hour',      v_legacy_greek,
    'events',                    v_legacy_events,
    'news',                      v_sentiment -> 'recent_news'
  );
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.build_ticker_quant_card(text, timestamptz)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.build_ticker_quant_card IS
  'v3.1 (2026-04-28): put_call_ratio uses TOTAL volumes from raw json (textbook PC ratio: put_vol / call_vol, >1 = put-dominated). Everything else identical to v3.';
