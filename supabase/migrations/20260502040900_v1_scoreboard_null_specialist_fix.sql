-- =============================================================================
-- 20260502040900_v1_scoreboard_null_specialist_fix.sql
--
-- THE V1 SILENT-FAILURE CANONICAL FIX. Runbook:
--   docs/runbooks/silent_failures.md
--
-- Symptom: ct_specialist_scoreboard had not received fresh rows in ~6.6 days
-- despite ct-specialist-scoreboard-update cron running nightly with
-- last_run_status='succeeded'.
--
-- Root cause: ct_specialist_outcome_stats(p_since_days integer) returns
-- one aggregated row per specialist_name. Without a NOT NULL filter on
-- f.specialist_ticker, the GROUP BY produces an additional row with
-- specialist_name=NULL aggregating ALL non-specialist-source flags
-- (detectors, James's hand-flags, etc.) — 5,402 of them at the time of
-- the bug. The edge function ct-specialist-scoreboard-update upserts the
-- full payload verbatim. NULL violates ct_specialist_scoreboard's NOT NULL
-- PK constraint on specialist_name. PostgreSQL atomic upsert: the ENTIRE
-- BATCH rolls back. Edge function logs the error as a warning, returns
-- HTTP 200 with a partial-success payload. Cron sees HTTP 200, marks
-- 'succeeded'. Zero rows landed.
--
-- Fix (Tenet 15 — class-level prevention):
--   - This migration: WHERE f.specialist_ticker IS NOT NULL in flag_truth CTE.
--     Eliminates the NULL aggregation row at the SQL layer.
--   - The cron_zero_row_upsert_silent_failure_class warden invariant
--     (20260502040000) catches future occurrences of this class across
--     all growth-crons.
-- =============================================================================
SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.ct_specialist_outcome_stats(p_since_days integer)
RETURNS TABLE (
  specialist_name    text,
  flags_total        bigint,
  flags_with_track   bigint,
  wins               bigint,
  losses             bigint,
  flat               bigint,
  working            bigint,
  hit_rate           numeric,
  median_peak_pct    numeric,
  expected_peak_pct  numeric,
  top_pick           text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions
AS $$
  WITH window_start AS (
    SELECT (now() - make_interval(days => GREATEST(p_since_days, 1)))::timestamptz AS ts
  ),
  flag_truth AS (
    SELECT
      f.specialist_ticker                    AS specialist_name,
      f.option_symbol,
      f.created_at,
      t.track_status,
      t.peak_contract_pct,
      t.print_time
    FROM public.ct_flags f
    LEFT JOIN public.ct_contract_tracks t
      ON t.option_symbol = f.option_symbol
     AND t.print_time BETWEEN f.created_at - interval '2 hours'
                           AND f.created_at + interval '2 hours'
    WHERE f.created_at >= (SELECT ts FROM window_start)
      AND f.option_symbol IS NOT NULL
      AND f.specialist_ticker IS NOT NULL   -- THE FIX. Eliminates NULL aggregation row.
  ),
  top_picks AS (
    SELECT DISTINCT ON (specialist_name)
      specialist_name,
      option_symbol AS top_pick
    FROM flag_truth
    WHERE peak_contract_pct IS NOT NULL
    ORDER BY specialist_name, peak_contract_pct DESC NULLS LAST
  ),
  agg AS (
    SELECT
      specialist_name,
      COUNT(*)                                                      AS flags_total,
      COUNT(track_status)                                           AS flags_with_track,
      COUNT(*) FILTER (WHERE track_status IN ('WIN','EXPIRED_WIN')) AS wins,
      COUNT(*) FILTER (WHERE track_status IN ('LOSS','EXPIRED_LOSS')) AS losses,
      COUNT(*) FILTER (WHERE track_status = 'EXPIRED_FLAT')         AS flat,
      COUNT(*) FILTER (WHERE track_status = 'WORKING')              AS working,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY peak_contract_pct) AS median_peak_pct,
      AVG(
        CASE
          WHEN track_status IN ('WIN','EXPIRED_WIN')   THEN peak_contract_pct
          WHEN track_status IN ('LOSS','EXPIRED_LOSS') THEN 0
          ELSE NULL
        END
      ) AS expected_peak_pct
    FROM flag_truth
    GROUP BY specialist_name
  )
  SELECT
    a.specialist_name,
    a.flags_total,
    a.flags_with_track,
    a.wins,
    a.losses,
    a.flat,
    a.working,
    (a.wins::numeric / NULLIF(a.wins + a.losses + a.flat, 0)) AS hit_rate,
    a.median_peak_pct,
    a.expected_peak_pct,
    tp.top_pick
  FROM agg a
  LEFT JOIN top_picks tp USING (specialist_name)
  ORDER BY hit_rate DESC NULLS LAST, a.flags_total DESC;
$$;
