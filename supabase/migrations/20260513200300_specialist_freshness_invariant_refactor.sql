-- ============================================================================
-- Ship 4 — Specialist freshness invariant measurement-shape refactor
--
-- Cascade #40 class-kill. Three existing specialist warden invariants measure
-- MAX(ct_specialist_reads.updated_at) — the "filtered output" surface. But
-- specialists with no_events legitimately don't write specialist_reads (Tenet 9
-- signal-bearing-only writes). Result: warden false-positive critical when a
-- ticker correctly skipped on no_events. Today 2026-05-13 morning, the
-- specialist_oldest_ticker_freshness_rth fired CRITICAL with 6 consecutive
-- fails before self-recovering — exactly that bug.
--
-- Root cause framing: invariant reads OUTPUT TABLE when the truth is in the
-- ACTIVITY TABLE. ct_specialist_wakeup_log captures EVERY wakeup including
-- no_events skips. That's the right surface for cron-health.
--
-- Three-layer specialist warden ecosystem post-refactor:
--   1. specialist_wakeup_freshness_rth (NEW, warn) — cron-health canary,
--      reads ct_specialist_wakeup_log per-ticker MAX(wakeup_at)
--   2. specialist_signal_output_today_rth (RENAMED from
--      specialist_oldest_ticker_freshness_rth, info) — useful-output count
--   3. specialist_reads_today + specialist_reads_per_ticker_today_rth (DEMOTED
--      warn → info) — informational metrics
--
-- After this lands the only critical specialist alarm fires on cron-health
-- regressions (right surface) — never on legitimate no_events skips.
--
-- Composes cleanly with Ship 3's specialist_reads_embedding_backlog_1h (warn)
-- for the embedding-gate layer. Canonical glossary entry codified in
-- patterns.md / cowork patterns.md.
--
-- Phase A gate cleared post-RTH (20:00 UTC weekday) per project doc
-- project_specialist_freshness_invariant_refactor_post_rth_2026_05_07.md.
-- D2.2 window 5/7-5/12 already closed; verdict today 5/13.
-- ============================================================================
SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 1. Drop the old critical (rename to specialist_signal_output_today_rth at
--    info severity below). ct_invariants.name is PRIMARY KEY — DELETE-then-
--    INSERT is cleaner than ALTER for a rename.
-- ----------------------------------------------------------------------------
DELETE FROM public.ct_invariants
WHERE name = 'specialist_oldest_ticker_freshness_rth';

-- ----------------------------------------------------------------------------
-- 2. NEW invariant: specialist_wakeup_freshness_rth
--    Reads ct_specialist_wakeup_log (activity log — captures every wakeup
--    including legitimate no_events skips). Measures MAX age across per-ticker
--    MAX(wakeup_at). RTH-gated (UTC 14-20 weekdays). expected_max=2 hours =
--    2 wakeup cycles tolerance (per-ticker cadence is ~hourly via the
--    10-ticker round-robin at ~6-min spacing).
-- ----------------------------------------------------------------------------
INSERT INTO public.ct_invariants (
  name, category, description, query_sql,
  expected_min, expected_max, severity, runbook_path
) VALUES (
  'specialist_wakeup_freshness_rth',
  'specialist',
  'Cron-health canary for specialists. Reads ct_specialist_wakeup_log (activity log) per-ticker MAX(wakeup_at) and returns the oldest tickers age in hours during RTH (UTC 14-20 weekdays). Captures every wakeup including legitimate no_events skips — measures whether the cron is firing, not whether output landed in ct_specialist_reads. expected_max 2h = 2 wakeup cycles tolerance for the 10-ticker round-robin ~hourly cadence. Replaces specialist_oldest_ticker_freshness_rth criticals firing false-positive on no_events skips (cascade #40).',
  $sql$
    WITH context AS (
      SELECT
        extract(isodow from now())::int AS utc_dow,
        extract(hour from now())::int AS utc_hour
    ),
    is_rth AS (
      SELECT (utc_dow BETWEEN 1 AND 5) AND (utc_hour BETWEEN 14 AND 20) AS rth FROM context
    ),
    universe(ticker) AS (
      VALUES ('NVDA'),('AAPL'),('MSFT'),('GOOGL'),('AMZN'),('META'),('TSLA'),('QQQ'),('SPY'),('IWM')
    ),
    per_ticker_max AS (
      SELECT u.ticker, MAX(w.wakeup_at) AS last_wakeup
      FROM universe u
      LEFT JOIN public.ct_specialist_wakeup_log w
        ON w.ticker = u.ticker
       AND w.wakeup_at >= now() - interval '24 hours'
      GROUP BY u.ticker
    ),
    aggregated AS (
      SELECT
        MAX(EXTRACT(EPOCH FROM (now() - last_wakeup)) / 3600.0) AS max_age_hours,
        COUNT(*) FILTER (WHERE last_wakeup IS NULL) AS missing_count,
        string_agg(ticker, ',' ORDER BY ticker) FILTER (WHERE last_wakeup IS NULL) AS missing_tickers,
        (SELECT ticker FROM per_ticker_max
         WHERE last_wakeup IS NOT NULL
         ORDER BY last_wakeup ASC LIMIT 1) AS oldest_ticker
      FROM per_ticker_max
    )
    SELECT
      CASE WHEN (SELECT rth FROM is_rth)
        THEN COALESCE(max_age_hours, 999)
        ELSE 0
      END AS metric_value,
      CASE WHEN NOT (SELECT rth FROM is_rth) THEN 'off-RTH skip'
           WHEN missing_count > 0 THEN missing_count || ' tickers no wakeup in 24h - ' || missing_tickers
           ELSE 'oldest ticker - ' || oldest_ticker || ' (' || ROUND(max_age_hours::numeric, 2) || 'h ago)'
      END AS message
    FROM aggregated
  $sql$,
  0,
  2,
  'warn',
  'docs/runbooks/specialist_per_ticker_freeze.md'
);

-- ----------------------------------------------------------------------------
-- 3. NEW: specialist_signal_output_today_rth (renamed from
--    specialist_oldest_ticker_freshness_rth, demoted critical -> info)
--    Same measurement (MAX age per-ticker on ct_specialist_reads), but the
--    name now reflects what it's actually measuring (signal-bearing-output
--    cadence, not cron health), and severity reflects that no_events skips
--    are legitimate behavior.
-- ----------------------------------------------------------------------------
INSERT INTO public.ct_invariants (
  name, category, description, query_sql,
  expected_min, expected_max, severity, runbook_path
) VALUES (
  'specialist_signal_output_today_rth',
  'specialist',
  'Per-ticker SIGNAL OUTPUT cadence on ct_specialist_reads (filtered output table — written only when specialist has signal-bearing read). Reads MAX age across per-ticker MAX(updated_at). RTH-gated (10:30-16:00 ET, M-F). Renamed and demoted from specialist_oldest_ticker_freshness_rth (was critical) — that name framed the metric as cron-health when it actually measures useful-output count. Cron-health now lives at specialist_wakeup_freshness_rth (reads activity log). This invariant remains useful as informational diagnostic — sustained 6h+ across multiple tickers in RTH means signal density dropped, watchlist tilt restrictive, or filter too tight — but a single ticker stale is no longer a critical alarm (legitimate no_events skips).',
  $sql$
    SELECT
      CASE
        WHEN extract(dow from now() AT TIME ZONE 'America/New_York') NOT IN (1,2,3,4,5) THEN 0
        WHEN (now() AT TIME ZONE 'America/New_York')::time < '10:30' THEN 0
        WHEN (now() AT TIME ZONE 'America/New_York')::time > '16:00' THEN 0
        ELSE EXTRACT(EPOCH FROM (now() - MIN(per_ticker_max))) / 3600
      END::numeric AS metric_value,
      'oldest stale ticker - ' || COALESCE(
        (SELECT ticker FROM (
           SELECT ticker, MAX(updated_at) AS m FROM ct_specialist_reads
           WHERE ticker = ANY(ARRAY['NVDA','AAPL','MSFT','GOOGL','AMZN','META','TSLA','QQQ','SPY','IWM'])
           GROUP BY ticker ORDER BY MAX(updated_at) ASC LIMIT 1) sub),
        'none')
      || ' (' || ROUND(EXTRACT(EPOCH FROM (now() - MIN(per_ticker_max))) / 3600, 1) || 'h ago)' AS message
    FROM (
      SELECT MAX(updated_at) AS per_ticker_max FROM ct_specialist_reads
      WHERE ticker = ANY(ARRAY['NVDA','AAPL','MSFT','GOOGL','AMZN','META','TSLA','QQQ','SPY','IWM'])
      GROUP BY ticker
    ) t
  $sql$,
  0,
  6,
  'info',
  'docs/runbooks/specialist_per_ticker_freeze.md'
);

-- ----------------------------------------------------------------------------
-- 4. DEMOTE: specialist_reads_today  warn -> info
--    Same measurement (count distinct tickers with reads today). The reason
--    to demote is the same as #3 — no_events skips are legitimate, so a
--    sub-threshold count is informational, not actionable alarm-worthy.
-- ----------------------------------------------------------------------------
UPDATE public.ct_invariants
SET
  severity = 'info',
  description = 'Count of distinct watchlist tickers with reads today. Demoted warn -> info as part of cascade #40 refactor (2026-05-13) — sub-threshold counts during RTH can be legitimate no_events skips on restrictive-threshold tickers. Cron-health alarm now lives at specialist_wakeup_freshness_rth (warn, reads activity log).',
  updated_at = now()
WHERE name = 'specialist_reads_today';

-- ----------------------------------------------------------------------------
-- 5. DEMOTE: specialist_reads_per_ticker_today_rth  warn -> info
--    Same reasoning as #4.
-- ----------------------------------------------------------------------------
UPDATE public.ct_invariants
SET
  severity = 'info',
  description = 'Per-ticker specialists must fire during RTH. By 14:30 UTC (10:30 ET), at least 7 of the 10 watchlist tickers should have at least one row in ct_specialist_reads written today (ET trading day). Demoted warn -> info as part of cascade #40 refactor (2026-05-13) — sub-threshold counts during RTH can be legitimate no_events skips. Cron-health alarm now lives at specialist_wakeup_freshness_rth (warn, reads activity log).',
  updated_at = now()
WHERE name = 'specialist_reads_per_ticker_today_rth';
