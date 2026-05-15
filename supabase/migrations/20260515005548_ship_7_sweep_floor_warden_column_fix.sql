-- Item 1 — Ship 7 sweep-floor warden column-name fix.
--
-- Bug: original Ship 7 invariant migration (20260514234001) referenced
-- ct_contract_tracks.created_at in two CTEs (active EXISTS guard + stats
-- aggregate). ct_contract_tracks has NO created_at column — the table
-- uses first_tracked_at (NOT NULL DEFAULT now()) per its 2026-04-26
-- creation migration. Warden invariant ticks have been erroring with
-- column "created_at" does not exist every cycle since deploy.
--
-- Fix: UPDATE the registered invariant's query_sql to use first_tracked_at.
-- Same shape otherwise (gate RTH, EXISTS-guard, threshold from ct_config,
-- median-sweep calc, structured message). No mid-string semicolons.
--
-- Sibling memory: this is instance #N of column-name-vs-table-schema-drift
-- (cascade #43 family). Engine-room write-time discipline catches column
-- references at schema-existence — Ship 7's class-kill warden itself
-- couldn't tick because of this exact class.

SET search_path = public, extensions;

UPDATE public.ct_invariants
SET query_sql = $w$
    WITH gate AS (
      SELECT
        EXTRACT(DOW FROM (now() AT TIME ZONE 'UTC'))::int BETWEEN 1 AND 5
          AND EXTRACT(HOUR FROM (now() AT TIME ZONE 'UTC'))::int BETWEEN 13 AND 20
          AS in_rth
    ),
    active AS (
      SELECT EXISTS(
        SELECT 1 FROM public.ct_contract_tracks
        WHERE first_tracked_at >= now() - interval '24 hours'
          AND track_status = 'WORKING'
          AND dte_at_print <= 7
      ) AS has_rows
    ),
    threshold AS (
      SELECT
        COALESCE(
          (SELECT (value)::text::numeric FROM public.ct_config WHERE key = 'warden_poller_short_dte_sweep_floor'),
          5
        ) AS floor_val
    ),
    stats AS (
      SELECT
        COUNT(*)::numeric AS n_tracks,
        COALESCE(
          percentile_cont(0.5) WITHIN GROUP (ORDER BY sweep_count),
          0
        )::numeric AS median_sweeps
      FROM public.ct_contract_tracks
      WHERE first_tracked_at >= now() - interval '24 hours'
        AND track_status = 'WORKING'
        AND dte_at_print <= 7
    ),
    calc AS (
      SELECT
        gate.in_rth,
        active.has_rows,
        threshold.floor_val,
        stats.n_tracks,
        stats.median_sweeps
      FROM gate, active, threshold, stats
    )
    SELECT
      CASE
        WHEN NOT calc.in_rth                          THEN 0::numeric
        WHEN NOT calc.has_rows                        THEN 0::numeric
        WHEN calc.n_tracks = 0                        THEN 0::numeric
        WHEN calc.median_sweeps < calc.floor_val      THEN 1::numeric
        ELSE 0::numeric
      END AS metric_value,
      CASE
        WHEN NOT calc.in_rth
          THEN 'dormant — outside RTH window (Mon-Fri 13-20 UTC)'
        WHEN NOT calc.has_rows
          THEN 'dormant — no short-DTE WORKING tracks in last 24h'
        WHEN calc.n_tracks = 0
          THEN 'dormant — n=0 over window'
        WHEN calc.median_sweeps < calc.floor_val
          THEN 'STARVATION | median_sweeps=' || round(calc.median_sweeps, 2)::text
            || ' below floor ' || calc.floor_val::text
            || ' over n=' || calc.n_tracks::text || ' short-DTE tracks (24h)'
        ELSE 'healthy | median_sweeps=' || round(calc.median_sweeps, 2)::text
          || ' floor=' || calc.floor_val::text
          || ' n=' || calc.n_tracks::text
      END AS message
    FROM calc
  $w$
WHERE name = 'contract_poller_short_dte_sweep_floor';
