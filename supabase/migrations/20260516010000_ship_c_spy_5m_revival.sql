-- Ship C — SPY/universe 5m price-bar revival + per-timeframe freshness warden.
--
-- Phase A finding (cluster #2 2026-05-16, re-verified here): ct_price_bars 5m
-- exists for all 10 tickers (4,522 rows each) but FROZE 2026-04-22 16:50Z. It
-- was a one-time ad-hoc seed; no cron ever fed it. trigger_ct_price_backfill
-- builds the ct-price-backfill request body with lookback_days only, and
-- ct-price-backfill's 5m branch is `if (include5m)`-gated with include5m
-- defaulting false -- so every scheduled backfill skips 5m. ct-edge-miner's
-- computeRegimeTag silently runs on the 1m fallback, biasing the realized-vol
-- axis ~2.2x toward low_vol (the 0.0008 threshold is 5m-calibrated).
--
-- Class: cron-doesn't-request-needed-flag-creates-one-time-seed. A consumer
-- (the 5m branch, the 5m forward-return RPC) was built ahead of a producer
-- that was never wired into a cron.
--
-- Fix: trigger_ct_price_backfill now always requests include_5m. Same function
-- signature -- a pure CREATE OR REPLACE, no new overload (avoids the
-- signature-scoped overload-orphan trap). Every scheduled + ad-hoc backfill
-- now fetches 5m alongside 1m.
--
-- Pair-shipped: price_bar_freshness_per_timeframe warden invariant -- a
-- generalized per-timeframe staleness check so a whole timeframe silently
-- freezing is structurally visible next time.
--
-- NOTE (brief-author-state-vs-intent): ct-price-backfill runs WEEKLY. This
-- revives 5m on the weekly cadence -- enough for historical 5m + the
-- forward-return RPC, but computeRegimeTag still falls through to 1m for any
-- session newer than the last weekly backfill. Full current-session 5m would
-- need a live 5m poll or a daily backfill -- flagged for captain, out of this
-- ship's scope.

SET search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. trigger_ct_price_backfill always requests 5m. Same signature as
--    20260422000030 -- pure replace, no overload.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trigger_ct_price_backfill(_lookback_days INT DEFAULT 2)
RETURNS jsonb
LANGUAGE sql
AS $fn$
  SELECT public._ct_post_with_body(
    'ct-price-backfill',
    jsonb_build_object('lookback_days', _lookback_days, 'include_5m', true)
  );
$fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_price_backfill(INT) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Warden invariant — price_bar_freshness_per_timeframe.
--    For every timeframe with rows in the last 30 days, measure staleness in
--    hours. metric_value = the stalest. Threshold 200h (~8.3 days) tolerates
--    the weekly 5m backfill cadence + a missed run, and a 3-day weekend gap
--    on 1m, while still catching a timeframe that has gone fully dark.
-- ---------------------------------------------------------------------------
INSERT INTO public.ct_invariants
  (name, category, description, query_sql, expected_min, expected_max, expected_bool, severity, runbook_path, enabled)
VALUES (
  'price_bar_freshness_per_timeframe',
  'data_freshness',
  'ct_price_bars per-timeframe freshness — staleness in hours of the newest bar for every timeframe active in the last 30 days. Catches a whole timeframe silently freezing (the SPY 5m one-time-seed class). Threshold 200h covers the weekly 5m backfill cadence and weekend 1m gaps.',
  $inv$WITH tf AS (SELECT timeframe, EXTRACT(EPOCH FROM (now() - max(ts))) / 3600.0 AS stale_h FROM public.ct_price_bars WHERE ts > now() - interval '30 days' GROUP BY timeframe) SELECT COALESCE(MAX(stale_h), 0)::numeric AS metric_value, COALESCE(string_agg(timeframe || ' ' || ROUND(stale_h)::text || 'h stale', ', ' ORDER BY stale_h DESC), 'no ct_price_bars rows in last 30 days') AS message FROM tf$inv$,
  NULL, 200, NULL, 'warn',
  'docs/SYSTEM_INDEX.md', true
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description, query_sql = EXCLUDED.query_sql,
  expected_max = EXCLUDED.expected_max, severity = EXCLUDED.severity,
  enabled = EXCLUDED.enabled, runbook_path = EXCLUDED.runbook_path;
