-- =============================================================================
-- 20260422000010_ct_quant_card_rpc.sql
--
-- Wave G: per-ticker quant card RPC. One SQL call aggregates every data surface
-- Claude needs for a single ticker into a single jsonb blob:
--   structure, flow_last_hour, dark_pool_last_hour, greek_flow_last_hour,
--   sentiment, events, news, brief tilt, freshness.
--
-- Consumers:
--   * ct-ticker-snapshot-builder  (upserts the blob into ct_ticker_snapshots
--                                  every 2 min during RTH so downstream
--                                  readers get O(1) cached reads).
--   * ct-trade-idea-generator     (reads the cached snapshot + falls back to
--                                  live build if snapshot is stale).
--   * ct-daily-brief              (future — reads 12 cards per session).
--
-- Pure SQL, STABLE, SECURITY DEFINER. Callers don't need per-table RLS perms;
-- the function reads ct_* tables which have service_role policies already.
-- =============================================================================

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.build_ticker_quant_card(
  p_ticker text,
  p_as_of  timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
WITH
params AS (
  SELECT upper(trim(p_ticker)) AS ticker,
         p_as_of              AS as_of,
         p_as_of - interval '1 hour' AS hour_ago
),

-- --------------------------------------------------------------------------
-- Structural: walls + flip computed from the latest ct_gex_timeseries snapshot
-- for this ticker. call_wall = strike with max call_gex; put_wall = strike
-- with max |put_gex|; gamma_flip = strike closest to where net_gex crosses 0;
-- spot = most recent underlying_price; net_gamma = sum(net_gex) at latest snap.
-- --------------------------------------------------------------------------
latest_gex_snap AS (
  SELECT max(snapshot_at) AS snapshot_at
  FROM ct_gex_timeseries g, params p
  WHERE g.ticker = p.ticker
    AND g.snapshot_at <= p.as_of
    AND g.snapshot_at >= p.as_of - interval '24 hours'
),
gex_rows AS (
  SELECT g.*
  FROM ct_gex_timeseries g
  JOIN params p ON g.ticker = p.ticker
  JOIN latest_gex_snap l ON g.snapshot_at = l.snapshot_at
),
call_wall_row AS (
  SELECT strike FROM gex_rows WHERE call_gex IS NOT NULL
  ORDER BY call_gex DESC NULLS LAST LIMIT 1
),
put_wall_row AS (
  SELECT strike FROM gex_rows WHERE put_gex IS NOT NULL
  ORDER BY abs(put_gex) DESC NULLS LAST LIMIT 1
),
gamma_flip_row AS (
  SELECT strike FROM gex_rows WHERE net_gex IS NOT NULL
  ORDER BY abs(net_gex) ASC NULLS LAST LIMIT 1
),
spot_row AS (
  SELECT underlying_price AS spot FROM gex_rows
  WHERE underlying_price IS NOT NULL
  LIMIT 1
),
net_gamma_total AS (
  SELECT sum(net_gex) AS net_gamma FROM gex_rows
),

-- --------------------------------------------------------------------------
-- IV rank (daily cadence)
-- --------------------------------------------------------------------------
iv_row AS (
  SELECT iv_rank, iv_percentile
  FROM ct_iv_rank_daily iv, params p
  WHERE iv.ticker = p.ticker
    AND iv.date <= (p.as_of AT TIME ZONE 'UTC')::date
  ORDER BY iv.date DESC
  LIMIT 1
),

-- --------------------------------------------------------------------------
-- Max pain (nearest expiry on or after today)
-- --------------------------------------------------------------------------
max_pain_row AS (
  SELECT max_pain_strike
  FROM ct_max_pain_daily mp, params p
  WHERE mp.ticker = p.ticker
    AND mp.date <= (p.as_of AT TIME ZONE 'UTC')::date
  ORDER BY mp.date DESC, mp.expiry ASC
  LIMIT 1
),

-- --------------------------------------------------------------------------
-- Flow (last hour): sums, whale/sweep counts, directional premium
-- --------------------------------------------------------------------------
flow_agg AS (
  SELECT
    count(*)                                                         AS alert_count,
    sum(premium)                                                     AS total_premium,
    sum(CASE WHEN side = 'call' THEN premium ELSE 0 END)             AS net_call_prem,
    sum(CASE WHEN side = 'put'  THEN premium ELSE 0 END)             AS net_put_prem,
    count(*) FILTER (WHERE alert_type ILIKE '%whale%')               AS whale_count,
    count(*) FILTER (WHERE alert_type ILIKE '%sweep%')               AS sweep_count,
    count(*) FILTER (WHERE size_gt_oi = true)                        AS opening_trades
  FROM ct_flow_alerts f, params p
  WHERE f.ticker = p.ticker
    AND f.executed_at BETWEEN p.hour_ago AND p.as_of
),

-- --------------------------------------------------------------------------
-- Dark pool (last hour)
-- --------------------------------------------------------------------------
dp_agg AS (
  SELECT
    count(*)                         AS print_count,
    sum(notional_value)              AS total_notional,
    max(notional_value)              AS largest_single,
    -- simple accumulation score: ratio of prints above VWAP-ish (price >= median)
    -- approximated as prints > median price
    sum(CASE WHEN price >= (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY price)
                             FROM ct_dark_pool_prints dp2, params p2
                             WHERE dp2.ticker = p2.ticker
                               AND dp2.executed_at BETWEEN p2.hour_ago AND p2.as_of)
             THEN notional_value ELSE 0 END) AS accumulation_score
  FROM ct_dark_pool_prints dp, params p
  WHERE dp.ticker = p.ticker
    AND dp.executed_at BETWEEN p.hour_ago AND p.as_of
),

-- --------------------------------------------------------------------------
-- Greek flow (last hour)
-- --------------------------------------------------------------------------
greek_agg AS (
  SELECT
    sum(total_delta_flow)   AS net_delta_flow,
    sum(total_vega_flow)    AS net_vega_flow,
    sum(net_call_delta)     AS net_call_delta,
    sum(net_put_delta)      AS net_put_delta,
    count(*)                AS tick_count
  FROM ct_greek_flow_minute g, params p
  WHERE g.ticker = p.ticker
    AND g.tick_timestamp BETWEEN p.hour_ago AND p.as_of
),

-- --------------------------------------------------------------------------
-- Sentiment: NOPE (latest), put/call ratio (last hour), net premium cumulative
-- --------------------------------------------------------------------------
nope_latest AS (
  SELECT nope
  FROM ct_nope_minute n, params p
  WHERE n.ticker = p.ticker
    AND n.tick_timestamp <= p.as_of
  ORDER BY n.tick_timestamp DESC
  LIMIT 1
),
net_prem_cum AS (
  SELECT
    sum(COALESCE(net_call_premium, 0) - COALESCE(net_put_premium, 0)) AS net_premium_cum,
    sum(COALESCE(net_call_volume, 0))  AS call_vol_cum,
    sum(COALESCE(net_put_volume,  0))  AS put_vol_cum
  FROM ct_net_premium_ticks npt, params p
  WHERE npt.ticker = p.ticker
    AND npt.tick_timestamp >= date_trunc('day', p.as_of AT TIME ZONE 'America/New_York')
                              AT TIME ZONE 'America/New_York'
    AND npt.tick_timestamp <= p.as_of
),

-- --------------------------------------------------------------------------
-- Events: next earnings + upcoming catalysts (next 7 days)
-- --------------------------------------------------------------------------
next_earn AS (
  SELECT event_date AS next_earnings_date,
         (raw ->> 'expected_move')::numeric AS earnings_expected_move
  FROM ct_events e, params p
  WHERE e.event_type = 'earnings'
    AND e.ticker = p.ticker
    AND e.event_date >= (p.as_of AT TIME ZONE 'UTC')::date
  ORDER BY e.event_date ASC
  LIMIT 1
),
upcoming_cats AS (
  SELECT jsonb_agg(
           jsonb_build_object(
             'event_type', event_type,
             'event_date', event_date,
             'event_time', event_time,
             'title',      title,
             'importance', importance
           ) ORDER BY event_date ASC
         ) AS catalysts
  FROM ct_events e, params p
  WHERE (e.ticker = p.ticker OR e.ticker IS NULL)
    AND e.event_date BETWEEN (p.as_of AT TIME ZONE 'UTC')::date
                         AND ((p.as_of AT TIME ZONE 'UTC')::date + 7)
),

-- --------------------------------------------------------------------------
-- News: last 5 breaking-news items tagged to this ticker (or macro-wide)
-- --------------------------------------------------------------------------
news_rows AS (
  SELECT jsonb_agg(row_obj ORDER BY ingested_at_val DESC) AS recent_news
  FROM (
    SELECT
      jsonb_build_object(
        'headline',  headline,
        'url',       url,
        'source',    source,
        'severity',  severity,
        'sentiment', sentiment,
        'category',  category,
        'summary',   summary,
        'published_at', published_at,
        'ingested_at',  ingested_at
      ) AS row_obj,
      ingested_at AS ingested_at_val
    FROM ct_breaking_news bn, params p
    WHERE (p.ticker = ANY(bn.tickers_affected) OR bn.macro_wide = true)
      AND bn.ingested_at <= p.as_of
    ORDER BY bn.ingested_at DESC
    LIMIT 5
  ) q
),

-- --------------------------------------------------------------------------
-- Brief tilt: latest non-superseded daily brief's per-ticker entry
-- --------------------------------------------------------------------------
latest_brief AS (
  SELECT id, per_ticker, watchlist_focus, skip_today, session_date
  FROM ct_daily_briefs db, params p
  WHERE db.expires_at >= p.as_of
    AND db.supersedes_id IS NULL  -- top of the chain
  ORDER BY db.created_at DESC
  LIMIT 1
),
brief_tilt_row AS (
  SELECT
    lb.id AS brief_id,
    (
      SELECT jsonb_array_elements(lb.per_ticker) ->> 'tilt'
      FROM jsonb_array_elements(lb.per_ticker) elem
      WHERE (elem ->> 'ticker') = (SELECT ticker FROM params)
      LIMIT 1
    ) AS tilt,
    (SELECT ticker FROM params) = ANY(lb.skip_today)        AS avoid_today,
    (SELECT ticker FROM params) = ANY(lb.watchlist_focus)   AS focus_today,
    lb.session_date
  FROM latest_brief lb
)

SELECT jsonb_build_object(
  'ticker',   (SELECT ticker FROM params),
  'as_of',    (SELECT as_of FROM params),

  'structure', jsonb_build_object(
    'spot',       (SELECT spot FROM spot_row),
    'gamma_flip', (SELECT strike FROM gamma_flip_row),
    'call_wall',  (SELECT strike FROM call_wall_row),
    'put_wall',   (SELECT strike FROM put_wall_row),
    'max_pain',   (SELECT max_pain_strike FROM max_pain_row),
    'iv_rank',    (SELECT iv_rank FROM iv_row),
    'iv_percentile', (SELECT iv_percentile FROM iv_row),
    'net_gamma',  (SELECT net_gamma FROM net_gamma_total),
    'regime',     CASE
                    WHEN (SELECT net_gamma FROM net_gamma_total) > 0 THEN 'positive_gamma'
                    WHEN (SELECT net_gamma FROM net_gamma_total) < 0 THEN 'negative_gamma'
                    ELSE 'neutral'
                  END,
    'latest_gex_snapshot_at', (SELECT snapshot_at FROM latest_gex_snap)
  ),

  'flow_last_hour', jsonb_build_object(
    'alert_count',    COALESCE((SELECT alert_count    FROM flow_agg), 0),
    'total_premium',  COALESCE((SELECT total_premium  FROM flow_agg), 0),
    'net_call_prem',  COALESCE((SELECT net_call_prem  FROM flow_agg), 0),
    'net_put_prem',   COALESCE((SELECT net_put_prem   FROM flow_agg), 0),
    'net_prem',       COALESCE((SELECT net_call_prem - net_put_prem FROM flow_agg), 0),
    'whale_count',    COALESCE((SELECT whale_count    FROM flow_agg), 0),
    'sweep_count',    COALESCE((SELECT sweep_count    FROM flow_agg), 0),
    'opening_trades', COALESCE((SELECT opening_trades FROM flow_agg), 0)
  ),

  'dark_pool_last_hour', jsonb_build_object(
    'print_count',        COALESCE((SELECT print_count        FROM dp_agg), 0),
    'total_notional',     COALESCE((SELECT total_notional     FROM dp_agg), 0),
    'largest_single',     COALESCE((SELECT largest_single     FROM dp_agg), 0),
    'accumulation_score', COALESCE((SELECT accumulation_score FROM dp_agg), 0)
  ),

  'greek_flow_last_hour', jsonb_build_object(
    'net_delta_flow',  COALESCE((SELECT net_delta_flow  FROM greek_agg), 0),
    'net_vega_flow',   COALESCE((SELECT net_vega_flow   FROM greek_agg), 0),
    'net_call_delta',  COALESCE((SELECT net_call_delta  FROM greek_agg), 0),
    'net_put_delta',   COALESCE((SELECT net_put_delta   FROM greek_agg), 0),
    'tick_count',      COALESCE((SELECT tick_count      FROM greek_agg), 0)
  ),

  'sentiment', jsonb_build_object(
    'nope_latest',     (SELECT nope FROM nope_latest),
    'put_call_ratio',  CASE
                         WHEN COALESCE((SELECT call_vol_cum FROM net_prem_cum), 0) = 0 THEN NULL
                         ELSE (SELECT put_vol_cum / NULLIF(call_vol_cum, 0) FROM net_prem_cum)
                       END,
    'net_premium_cum', COALESCE((SELECT net_premium_cum FROM net_prem_cum), 0)
  ),

  'events', jsonb_build_object(
    'next_earnings_date',     (SELECT next_earnings_date     FROM next_earn),
    'earnings_expected_move', (SELECT earnings_expected_move FROM next_earn),
    'upcoming_catalysts',     COALESCE((SELECT catalysts FROM upcoming_cats), '[]'::jsonb)
  ),

  'news', COALESCE((SELECT recent_news FROM news_rows), '[]'::jsonb),

  'brief', jsonb_build_object(
    'source_brief_id', (SELECT brief_id     FROM brief_tilt_row),
    'tilt',            (SELECT tilt         FROM brief_tilt_row),
    'avoid_today',     COALESCE((SELECT avoid_today  FROM brief_tilt_row), false),
    'focus_today',     COALESCE((SELECT focus_today  FROM brief_tilt_row), false),
    'session_date',    (SELECT session_date FROM brief_tilt_row)
  ),

  'freshness', jsonb_build_object(
    'gex_snapshot_at',   (SELECT snapshot_at FROM latest_gex_snap),
    'seconds_stale_gex', CASE
                           WHEN (SELECT snapshot_at FROM latest_gex_snap) IS NULL THEN NULL
                           ELSE EXTRACT(EPOCH FROM ((SELECT as_of FROM params) - (SELECT snapshot_at FROM latest_gex_snap)))
                         END,
    'as_of',             (SELECT as_of FROM params)
  )
);
$fn$;

GRANT EXECUTE ON FUNCTION public.build_ticker_quant_card(text, timestamptz) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Manual-trigger RPC for the snapshot builder (fires the edge function via
-- the Vault-powered _ct_post helper). Lets /crons "Run now" work without the
-- CLI-vs-runtime service_role key mismatch.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trigger_ct_ticker_snapshot_builder()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-ticker-snapshot-builder'); $fn$;
GRANT EXECUTE ON FUNCTION public.trigger_ct_ticker_snapshot_builder() TO authenticated, service_role;
