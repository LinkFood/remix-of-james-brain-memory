-- =============================================================================
-- 20260506190000_d2_2_googl_amzn_meta_threshold_recalibration.sql
--
-- D2.2 ship per Cowork brief 2026-05-07-d2-2-ship-brief.md (executed today).
-- Recalibrates GOOGL/AMZN/META wakeup thresholds 60 → 55 to bring them in
-- line with NVDA/AAPL/MSFT post-D2 thresholds. Pair-ships A3.K4 silent-
-- specialist warden invariant per yesterday's captain-approval.
--
-- Phase A audit-first verification PASSED 2026-05-06 18:50Z:
--   (a) ct_config thresholds confirmed at 60 for all three
--   (b) Fresh distribution: GOOGL p75=62, AMZN p75=62, META p75=58
--       (matches yesterday's A3 data; D2.2 math holds)
--   (c) Cron schedule unchanged (HH:00..54 staggered, all 10 watchlist
--       specialists active)
--
-- Bimodal-aware framing: D2.2 catches more upper-mode signal (post-recal,
-- p75 of all three sits above threshold 55). Cannot reach the lower mode
-- (~38-42 cluster). Tactical buffer pending D3 — D3 is the structural
-- answer, D2.2 is the available threshold-lever buffer.
--
-- MSFT EXPLICITLY EXCLUDED. Per A3.K1: MSFT's failure mode is cron-window-
-- vs-event-clustering misalignment + extreme threshold-fragility (p75=38,
-- gap -17 vs threshold 55). Defers to D3 + Phase A.6 cron-window study.
-- NVDA stays at 50 (A2 confirmed adequate). AAPL stays at 55 (D2 already
-- accepted via A2 multi-day re-read).
--
-- Multi-day acceptance window (per PR #30 single-sample-acceptance-window
-- discipline):
--   Day 1 (today, partial): ~2 specialist ticks per ticker remaining RTH
--   Day 2 (Thu 5/7): full RTH
--   Day 3 (Fri 5/8): NFP day, high-flow
--   Day 4 (Mon 5/11): full RTH
--   Day 5 (Tue 5/12): full RTH
--   Verdict at end of window — Wed 5/13.
--
-- Acceptance baselines (computed from A3 distribution × cron 1/hour ×
-- 6.5h RTH/day):
--   GOOGL fire rate post-recal ≈ 33% (9 of 27 reads ≥55) → ~2/day, ~10 over 5d
--   AMZN  fire rate post-recal ≈ 38% (13 of 34 reads ≥55) → ~2.5/day, ~12 over 5d
--   META  fire rate post-recal ≈ 25% (7 of 28 reads ≥55) → ~1.6/day, ~8 over 5d
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- D2.2 — threshold UPDATEs for GOOGL / AMZN / META
-- -----------------------------------------------------------------------------

UPDATE public.ct_config
SET value = '55'::jsonb
WHERE key IN (
  'specialist.GOOGL.wakeup_threshold',
  'specialist.AMZN.wakeup_threshold',
  'specialist.META.wakeup_threshold'
);

-- -----------------------------------------------------------------------------
-- A3.K4 — silent-specialist freshness warden invariant pair-ship
-- -----------------------------------------------------------------------------

-- Configurable threshold for the freshness invariant. Default 24 hours of
-- last specialist read. Lifted to ct_config per Tenet 16. Per-ticker overrides
-- can be added later (e.g., warden.specialist_silence_threshold_hours.NVDA).
INSERT INTO public.ct_config (key, value, description, category, min_value, max_value, default_value) VALUES
  ('warden.specialist_silence_threshold_hours', '24'::jsonb,
    'Hours since last specialist read (any ticker) before specialist_per_ticker_freshness_rth invariant fires warn. Calendar hours, not RTH hours — invariant only evaluates during RTH (UTC weekday 14-19) so weekend gap is ignored. Configurable to extend tolerance during low-flow weeks if needed.',
    'warden', 1, 168, '24'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- New invariant: specialist_per_ticker_freshness_rth
-- Fires (warn) when any watchlist specialist hasn't written a read in
-- > threshold-hours, but ONLY during RTH (UTC weekday 14-19). Outside RTH
-- the invariant returns 0 (passes) so weekends don't trip it.
INSERT INTO public.ct_invariants (name, category, description, query_sql, expected_min, expected_max, expected_bool, severity, runbook_path) VALUES
  ('specialist_per_ticker_freshness_rth',
   'specialist',
   'Per-ticker specialist freshness during RTH. Watchlist specialists must write at least one read every <threshold> calendar hours during RTH (UTC weekday 14-19). Fires warn if any ticker exceeds. A3.K4 pair-ship with D2.2 threshold recalibration; defense-in-depth catches per-ticker silence-class regressions (cron broken, write target broken, env-var divergence post-deploy, etc.). Configurable via ct_config.warden.specialist_silence_threshold_hours.',
$$
WITH context AS (
  SELECT
    extract(isodow from now())::int AS utc_dow,
    extract(hour   from now())::int AS utc_hour
),
is_rth AS (
  SELECT
    (utc_dow BETWEEN 1 AND 5) AND (utc_hour BETWEEN 14 AND 19) AS rth
  FROM context
),
threshold_hours AS (
  SELECT (value::text)::numeric AS hrs
  FROM public.ct_config
  WHERE key = 'warden.specialist_silence_threshold_hours'
),
per_ticker_freshness AS (
  SELECT
    ticker,
    MAX(updated_at) AS last_read_at,
    EXTRACT(EPOCH FROM (now() - MAX(updated_at))) / 3600.0 AS hours_since_last_read
  FROM public.ct_specialist_reads
  WHERE ticker = ANY(ARRAY['NVDA','AAPL','MSFT','GOOGL','AMZN','META','TSLA','QQQ','SPY','IWM'])
  GROUP BY ticker
),
silent AS (
  SELECT ptf.ticker, ptf.hours_since_last_read
  FROM per_ticker_freshness ptf, threshold_hours th
  WHERE ptf.hours_since_last_read > th.hrs
)
SELECT
  CASE WHEN (SELECT rth FROM is_rth)
    THEN (SELECT COUNT(*)::numeric FROM silent)
    ELSE 0::numeric
  END AS metric_value,
  CASE WHEN NOT (SELECT rth FROM is_rth) THEN 'off-RTH skip'
       WHEN (SELECT COUNT(*) FROM silent) = 0 THEN 'all watchlist specialists fresh'
       ELSE 'silent_specialists: ' || (
         SELECT string_agg(ticker || '(' || ROUND(hours_since_last_read::numeric, 1) || 'h)', ',' ORDER BY hours_since_last_read DESC)
         FROM silent
       )
  END AS message
$$,
   NULL,
   0,
   NULL,
   'warn',
   'docs/audit/2026-05-06-d2-escalation-A3-silent-specialist-class.md')
ON CONFLICT (name) DO UPDATE
  SET query_sql      = EXCLUDED.query_sql,
      description    = EXCLUDED.description,
      expected_min   = EXCLUDED.expected_min,
      expected_max   = EXCLUDED.expected_max,
      severity       = EXCLUDED.severity,
      runbook_path   = EXCLUDED.runbook_path,
      category       = EXCLUDED.category;
