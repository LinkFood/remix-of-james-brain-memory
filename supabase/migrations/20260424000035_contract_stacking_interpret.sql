-- ct_contract_stacking — server-side signal interpretation
--
-- Extends the existing ct_contract_stacking RPC with three new computed
-- columns that encode the trader-intent interpretation of each stack.
-- Previously this logic lived in src/hooks/useContractStacking.ts
-- (`interpretStack()`), which meant only the UI could read it. Backend
-- consumers (tape-reader, specialists, Slack digest, Claude prompts) had
-- to either re-implement or stay ignorant. This puts the truth in SQL so
-- every consumer reads the same answer.
--
-- Interpretation table (drives signal_color / signal_label / signal_mechanism):
--
--   opening_buy / (buy+sell) >= 0.8                → accumulation
--     side=C (calls)                               → bullish   | "call accumulation"
--     side=P (puts)                                → bearish   | "put accumulation"
--
--   opening_sell / (buy+sell) >= 0.8
--     AND ask_dominant_pct < 30                    → writing (premium collection)
--     side=P (selling puts at bid)                 → bullish   | "put writing"
--     side=C (selling calls at bid)                → bearish   | "call writing"
--
--   opening_sell / (buy+sell) >= 0.8
--     AND NOT (ask_dominant_pct < 30)              → distribution
--     side=C                                       → mixed     | "call distribution"
--     side=P                                       → mixed     | "put distribution"
--
--   else                                           → mixed     | "2-sided"
--
-- NULL guards:
--   - GREATEST(buy+sell, 1) prevents divide-by-zero on the ratio
--   - ask_dominant_pct IS NULL is treated as "not ask-heavy", so a NULL
--     collapses an otherwise "writing" classification into "distribution".
--     This matches the client helper's behavior (it required a numeric
--     ask_dominant_pct to pass the writing check).
--
-- Column order: the 15 original columns first, then the 3 new signal
-- columns appended at the end. Non-breaking for existing callers.
SET search_path = public, extensions;

-- Postgres cannot CREATE OR REPLACE a function whose RETURNS TABLE shape
-- has changed. We're appending three new output columns, so drop first.
DROP FUNCTION IF EXISTS public.ct_contract_stacking(INT, INT, NUMERIC, TEXT, INT);

CREATE OR REPLACE FUNCTION public.ct_contract_stacking(
  p_window_min   INT     DEFAULT 360,
  p_min_prints   INT     DEFAULT 3,
  p_min_premium  NUMERIC DEFAULT 100000,
  p_ticker       TEXT    DEFAULT NULL,
  p_limit        INT     DEFAULT 50
)
RETURNS TABLE(
  option_symbol       TEXT,
  ticker              TEXT,
  strike              NUMERIC,
  expiry              DATE,
  side                TEXT,
  prints_count        INTEGER,
  first_ts            TIMESTAMPTZ,
  last_ts             TIMESTAMPTZ,
  premium_total       NUMERIC,
  avg_score           NUMERIC,
  max_score           NUMERIC,
  ask_dominant_pct    NUMERIC,
  opening_buy_count   INTEGER,
  opening_sell_count  INTEGER,
  last_15min_prints   INTEGER,
  is_accelerating     BOOLEAN,
  signal_color        TEXT,
  signal_label        TEXT,
  signal_mechanism    TEXT
)
LANGUAGE sql STABLE
SET search_path = public, extensions
AS $$
  WITH scoped AS (
    SELECT
      sf.option_symbol,
      sf.ticker,
      sf.strike,
      sf.expiry,
      sf.event_ts,
      sf.classification,
      sf.score,
      sf.premium,
      sf.ask_side_perc
    FROM public.ct_scored_flow sf
    WHERE sf.event_ts >= now() - make_interval(mins => p_window_min)
      AND sf.ticker IN (
        'SPY','QQQ','IWM','AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA'
      )
      AND sf.classification IN ('opening_buy','opening_sell')
      AND (p_ticker IS NULL OR sf.ticker = p_ticker)
  ),
  agg AS (
    SELECT
      s.option_symbol,
      MAX(s.ticker)                                                                AS ticker,
      MAX(s.strike)                                                                AS strike,
      MAX(s.expiry)                                                                AS expiry,
      substring(s.option_symbol FROM length(s.option_symbol) - 8 FOR 1)            AS side,
      COUNT(*)::int                                                                AS prints_count,
      MIN(s.event_ts)                                                              AS first_ts,
      MAX(s.event_ts)                                                              AS last_ts,
      COALESCE(SUM(s.premium), 0)::numeric                                         AS premium_total,
      ROUND(AVG(s.score)::numeric, 2)                                              AS avg_score,
      ROUND(MAX(s.score)::numeric, 2)                                              AS max_score,
      CASE
        WHEN COUNT(s.ask_side_perc) = 0 THEN NULL
        ELSE ROUND(AVG(s.ask_side_perc)::numeric, 1)
      END                                                                          AS ask_dominant_pct,
      COUNT(*) FILTER (WHERE s.classification = 'opening_buy')::int                AS opening_buy_count,
      COUNT(*) FILTER (WHERE s.classification = 'opening_sell')::int               AS opening_sell_count,
      COUNT(*) FILTER (WHERE s.event_ts > now() - interval '15 minutes')::int      AS last_15min_prints
    FROM scoped s
    GROUP BY s.option_symbol
  ),
  interp AS (
    SELECT
      a.*,
      (a.last_15min_prints >= 3) AS is_accelerating,
      -- buy ratio (guarded against divide-by-zero)
      (a.opening_buy_count::numeric
        / GREATEST(a.opening_buy_count + a.opening_sell_count, 1))  AS buy_ratio,
      (a.opening_sell_count::numeric
        / GREATEST(a.opening_buy_count + a.opening_sell_count, 1))  AS sell_ratio
    FROM agg a
  )
  SELECT
    i.option_symbol,
    i.ticker,
    i.strike,
    i.expiry,
    i.side,
    i.prints_count,
    i.first_ts,
    i.last_ts,
    i.premium_total,
    i.avg_score,
    i.max_score,
    i.ask_dominant_pct,
    i.opening_buy_count,
    i.opening_sell_count,
    i.last_15min_prints,
    i.is_accelerating,
    -- signal_color
    CASE
      WHEN i.buy_ratio >= 0.8 THEN
        CASE WHEN i.side = 'C' THEN 'bullish' ELSE 'bearish' END
      WHEN i.sell_ratio >= 0.8
           AND i.ask_dominant_pct IS NOT NULL
           AND i.ask_dominant_pct < 30 THEN
        CASE WHEN i.side = 'P' THEN 'bullish' ELSE 'bearish' END
      WHEN i.sell_ratio >= 0.8 THEN
        'mixed'
      ELSE
        'mixed'
    END                                                             AS signal_color,
    -- signal_label (short)
    CASE
      WHEN i.buy_ratio >= 0.8 THEN
        CASE WHEN i.side = 'C' THEN 'call accumulation' ELSE 'put accumulation' END
      WHEN i.sell_ratio >= 0.8
           AND i.ask_dominant_pct IS NOT NULL
           AND i.ask_dominant_pct < 30 THEN
        CASE WHEN i.side = 'P' THEN 'put writing' ELSE 'call writing' END
      WHEN i.sell_ratio >= 0.8 THEN
        CASE WHEN i.side = 'C' THEN 'call distribution' ELSE 'put distribution' END
      ELSE
        '2-sided'
    END                                                             AS signal_label,
    -- signal_mechanism (one-liner suitable for Claude prompts / tooltips)
    CASE
      WHEN i.buy_ratio >= 0.8 AND i.side = 'C' THEN
        concat(
          i.opening_buy_count, ' opening_buy',
          CASE WHEN i.ask_dominant_pct IS NOT NULL
               THEN ' · ask ' || i.ask_dominant_pct || '%' ELSE '' END,
          ' — buying calls opens long delta, pays premium for upside exposure (bullish)'
        )
      WHEN i.buy_ratio >= 0.8 AND i.side = 'P' THEN
        concat(
          i.opening_buy_count, ' opening_buy',
          CASE WHEN i.ask_dominant_pct IS NOT NULL
               THEN ' · ask ' || i.ask_dominant_pct || '%' ELSE '' END,
          ' — buying puts opens short delta, pays premium for downside protection (bearish)'
        )
      WHEN i.sell_ratio >= 0.8
           AND i.ask_dominant_pct IS NOT NULL
           AND i.ask_dominant_pct < 30
           AND i.side = 'P' THEN
        concat(
          i.opening_sell_count, ' opening_sell · ask ', i.ask_dominant_pct,
          '% — selling puts at the bid = collecting premium, betting underlying holds above strike (bullish)'
        )
      WHEN i.sell_ratio >= 0.8
           AND i.ask_dominant_pct IS NOT NULL
           AND i.ask_dominant_pct < 30
           AND i.side = 'C' THEN
        concat(
          i.opening_sell_count, ' opening_sell · ask ', i.ask_dominant_pct,
          '% — selling calls at the bid = collecting premium, betting underlying stays below strike (bearish)'
        )
      WHEN i.sell_ratio >= 0.8 AND i.side = 'C' THEN
        concat(
          i.opening_sell_count, ' opening_sell',
          CASE WHEN i.ask_dominant_pct IS NOT NULL
               THEN ' · ask ' || i.ask_dominant_pct || '%' ELSE '' END,
          ' — call sells without clear bid-side pressure: distribution, intent ambiguous'
        )
      WHEN i.sell_ratio >= 0.8 AND i.side = 'P' THEN
        concat(
          i.opening_sell_count, ' opening_sell',
          CASE WHEN i.ask_dominant_pct IS NOT NULL
               THEN ' · ask ' || i.ask_dominant_pct || '%' ELSE '' END,
          ' — put sells without clear bid-side pressure: distribution, intent ambiguous'
        )
      ELSE
        concat(
          i.opening_buy_count, ' opening_buy / ',
          i.opening_sell_count, ' opening_sell',
          CASE WHEN i.ask_dominant_pct IS NOT NULL
               THEN ' · ask ' || i.ask_dominant_pct || '%' ELSE '' END,
          ' — 2-sided flow, no dominant opening direction'
        )
    END                                                             AS signal_mechanism
  FROM interp i
  WHERE i.prints_count >= p_min_prints
    AND i.premium_total >= p_min_premium
  ORDER BY i.premium_total DESC
  LIMIT p_limit
$$;

GRANT EXECUTE ON FUNCTION public.ct_contract_stacking(INT, INT, NUMERIC, TEXT, INT)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.ct_contract_stacking(INT, INT, NUMERIC, TEXT, INT) IS
$doc$Stacking detector + server-side signal interpretation.

Returns aggregated contract-level flow with three interpretation columns:
  signal_color     bullish | bearish | mixed
  signal_label     short tag (e.g. 'put writing', 'call accumulation')
  signal_mechanism one-liner explaining the trader intent behind the flow,
                    suitable for Claude prompts and UI tooltips.

Interpretation rules mirror the legacy client helper interpretStack() in
src/hooks/useContractStacking.ts — SQL is now the source of truth; the
client helper remains as a fallback until frontend consumers migrate.$doc$;
