-- =============================================================================
-- 20260501080000_specialist_reads_warden.sql
--
-- Phase B of the specialist-recall property install. Seeds a Warden invariant
-- that catches the substrate going dead (which would silently break the
-- recall organ's ability to inject prior history).
--
-- Why two invariants and not one:
--   1. specialist_reads_per_ticker_today_rth — operational health. RTH-gated.
--      Catches "did the per-ticker specialists fire today?" If <7 of 10
--      tickers have a read in today's RTH window, something's broken upstream
--      (cron stalled, watchlist filter wrong, dispatcher dead).
--   2. specialist_memory_table_dead — documentation invariant. ct_specialist_memory
--      is intentionally empty by v2 architecture (the legacy v1 writer path
--      gates on flag.source='specialist' which v2 never produces). This
--      invariant exists so future-Claude reading the warden output sees the
--      table is dead BY DESIGN, not by accident. Severity 'info' — never
--      Slacks, just visible in get_warden_health for inspection.
--
-- Both runbook to docs/runbooks/specialists.md.
-- =============================================================================
SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 1) specialist_reads_per_ticker_today_rth — operational freshness
-- ----------------------------------------------------------------------------
-- Time gate: pre-RTH and weekends pass with metric_value=10 (no specialists
-- expected). After 14:30 UTC (10:30 ET) on a weekday, expect ≥7 of 10
-- watchlist tickers to have at least one read today.
INSERT INTO public.ct_invariants
  (name, category, description, query_sql,
   expected_min, expected_max, severity, runbook_path, enabled)
VALUES (
  'specialist_reads_per_ticker_today_rth',
  'specialists',
  'Per-ticker specialists must fire during RTH. By 14:30 UTC (10:30 ET), at least 7 of the 10 watchlist tickers should have at least one row in ct_specialist_reads written today (ET trading day). Below that = a specialist cron is dead, watchlist filter is wrong, or the dispatcher stopped.',
  $sql$
    SELECT
      CASE
        -- Weekend: no specialists expected
        WHEN extract(dow from now() AT TIME ZONE 'America/New_York') NOT IN (1,2,3,4,5) THEN 10
        -- Pre-RTH-warmup window: don't fire yet
        WHEN (now() AT TIME ZONE 'America/New_York')::time < '10:30' THEN 10
        ELSE (
          SELECT count(DISTINCT ticker)
          FROM ct_specialist_reads
          WHERE updated_at >= ((now() AT TIME ZONE 'America/New_York')::date
                                AT TIME ZONE 'America/New_York')
        )
      END::numeric                                                  AS metric_value,
      'distinct watchlist tickers with reads today'                 AS message
  $sql$,
  7,    -- expected_min — at least 7 of 10
  10,   -- expected_max — never more than 10 (sanity)
  'warn',
  'docs/runbooks/specialists.md',
  true
)
ON CONFLICT (name) DO UPDATE
SET
  category      = EXCLUDED.category,
  description   = EXCLUDED.description,
  query_sql     = EXCLUDED.query_sql,
  expected_min  = EXCLUDED.expected_min,
  expected_max  = EXCLUDED.expected_max,
  severity      = EXCLUDED.severity,
  runbook_path  = EXCLUDED.runbook_path,
  enabled       = EXCLUDED.enabled,
  updated_at    = now();

-- ----------------------------------------------------------------------------
-- 2) specialist_memory_table_dead — documentation invariant (severity info)
-- ----------------------------------------------------------------------------
-- This passes only when ct_specialist_memory is empty/near-empty, which is
-- the v2-correct state. If it ever starts filling up, that means someone
-- reactivated the dead writer path or wrote a new one — surface that for
-- review. Severity info: never Slacks (per Warden's severity ladder), but
-- visible in get_warden_health when inspecting the system.
INSERT INTO public.ct_invariants
  (name, category, description, query_sql,
   expected_min, expected_max, severity, runbook_path, enabled)
VALUES (
  'specialist_memory_table_dead',
  'specialists',
  'ct_specialist_memory is the legacy v1 substrate. The writer in ct-flag-grader gates on flag.source=specialist which v2 never produces, so the table is empty BY DESIGN. The recall property sources from ct_specialist_reads + ct_flag_grades instead (see specialistRecallContext.ts). This invariant flips to fail if rows start accumulating — which would mean someone reactivated the dead path. Severity info: never Slacks, just shows in get_warden_health.',
  $sql$
    SELECT
      count(*)::numeric                                  AS metric_value,
      'rows in legacy ct_specialist_memory'              AS message
    FROM ct_specialist_memory
  $sql$,
  0,
  10,    -- 2 residue rows exist; 10 is generous slack before "this is filling up"
  'info',
  'docs/runbooks/specialists.md',
  true
)
ON CONFLICT (name) DO UPDATE
SET
  category      = EXCLUDED.category,
  description   = EXCLUDED.description,
  query_sql     = EXCLUDED.query_sql,
  expected_min  = EXCLUDED.expected_min,
  expected_max  = EXCLUDED.expected_max,
  severity      = EXCLUDED.severity,
  runbook_path  = EXCLUDED.runbook_path,
  enabled       = EXCLUDED.enabled,
  updated_at    = now();
