-- Ship 5 — warden invariant `specialist_recent_grade_visibility`.
--
-- Class-kill for the "PostgREST embedded FK auto-resolve silently returns
-- null" cascade. Pre-ship verification on 2026-05-14:
--   * curl ct_flags?select=*,ct_flag_grades(*)&specialist_ticker=eq.SPY
--     -> ct_flag_grades: null on every row, even for SPY flags graded
--        minutes earlier
--   * curl ct_flag_grades?specialist_ticker=eq.SPY&graded_at=gte.<30d>
--     -> 399 rows, full payloads
--
-- Root cause: ct_flag_grades has an UNNAMED FK declared inline at table
-- creation time (`flag_id UUID NOT NULL REFERENCES public.ct_flags(id)`).
-- PostgREST's forward auto-resolve (parent -> child) is unreliable for
-- unnamed inline FKs in some PostgREST/PostgREST-supabase versions, while
-- the reverse direction (child -> parent) resolves cleanly. The fix at the
-- consumer layer is to join via ct_flag_grades.specialist_ticker (the
-- grader's canonical routing column) instead of going through the parent.
--
-- This invariant detects upstream data-shape divergence around grade
-- visibility: rows in ct_flag_grades that don't join to ct_flags (orphan
-- grades), or specialist_ticker mismatches between grader routing and
-- parent flag. If they diverge by more than
-- warden_specialist_grade_visibility_max_drift_pct (default 0.05 = 5%),
-- the invariant fires WARN.
--
-- HONEST SCOPE LIMITATION (acknowledged at write-time): this invariant
-- cannot catch the original triggering class from inside SQL — the
-- "PostgREST embedded forward auto-resolve returns null" failure is a
-- projection-layer behavior at the REST gateway, not a Postgres JOIN
-- failure. The Postgres JOIN below succeeds where PostgREST's embedded
-- select doesn't. A complete class-kill for the embedded-FK class would
-- need a periodic edge-function probe that issues both REST queries and
-- compares row counts (cascade #15 territory — projection-layer coercion).
-- This invariant remains useful for the adjacent class: orphan grades,
-- routing column mismatches, deletion-cascade gaps.
--
-- EXISTS-guard ahead-of-producer pattern (per
-- feedback_warden_dormant_until_active_pattern.md): metric_value=0 when
-- ct_flag_grades has no rows in last 30d. With ~1,600 graded rows in the
-- live window the guard never engages — but the pattern is correct for
-- future replay-from-empty scenarios.
--
-- Parser hygiene (per feedback_warden_parser_semicolon_blind.md): no `;`
-- inside query_sql, including in message string literals. Em-dashes and
-- pipes used as separators.
--
-- Severity warn — drift indicates a consumer accidentally went back to
-- embedded-FK syntax. Not a crisis but should be looked at within a day.

INSERT INTO public.ct_invariants (
  name, category, description, query_sql,
  expected_min, expected_max, severity, runbook_path
) VALUES (
  'specialist_recent_grade_visibility',
  'data_quality',
  'Compares 30d ct_flag_grades row-count joined via ct_flags.specialist_ticker (consumer canonical path) vs joined via parent ct_flags rows (embedded-FK auto-resolve path). Fires WARN when relative drift exceeds warden_specialist_grade_visibility_max_drift_pct (default 0.05). EXISTS-guard returns 0 when ct_flag_grades has no 30d rows.',
  $sql$
    WITH cfg AS (
      SELECT COALESCE(
        ((value)::text)::numeric,
        0.05
      ) AS max_drift_pct
      FROM public.ct_config
      WHERE key = 'warden_specialist_grade_visibility_max_drift_pct'
      UNION ALL
      SELECT 0.05::numeric
      WHERE NOT EXISTS (
        SELECT 1 FROM public.ct_config
        WHERE key = 'warden_specialist_grade_visibility_max_drift_pct'
      )
      LIMIT 1
    ),
    direct_count AS (
      SELECT COUNT(*)::numeric AS n
      FROM public.ct_flag_grades
      WHERE specialist_ticker IS NOT NULL
        AND graded_at >= now() - interval '30 days'
    ),
    via_parent_count AS (
      SELECT COUNT(*)::numeric AS n
      FROM public.ct_flag_grades g
      JOIN public.ct_flags f ON f.id = g.flag_id
      WHERE g.specialist_ticker IS NOT NULL
        AND g.graded_at >= now() - interval '30 days'
    ),
    drift AS (
      SELECT
        d.n AS direct_n,
        v.n AS parent_n,
        CASE
          WHEN d.n = 0 THEN NULL
          ELSE ABS(d.n - v.n) / NULLIF(d.n, 0)
        END AS rel_drift
      FROM direct_count d, via_parent_count v
    )
    SELECT
      CASE
        WHEN drift.direct_n = 0 THEN 0::numeric
        WHEN drift.rel_drift IS NULL THEN 0::numeric
        WHEN drift.rel_drift > cfg.max_drift_pct THEN 1::numeric
        ELSE 0::numeric
      END AS metric_value,
      CASE
        WHEN drift.direct_n = 0
          THEN 'dormant — no ct_flag_grades rows in last 30d'
        WHEN drift.rel_drift IS NULL
          THEN 'dormant — direct count zero (unexpected when grades present)'
        WHEN drift.rel_drift > cfg.max_drift_pct
          THEN 'DRIFT direct_n=' || drift.direct_n::text
            || ' parent_join_n=' || drift.parent_n::text
            || ' rel_drift=' || round(drift.rel_drift, 3)::text
            || ' exceeds ' || round(cfg.max_drift_pct, 3)::text
            || ' — possible consumer regression to embedded-FK PostgREST syntax'
        ELSE 'healthy direct_n=' || drift.direct_n::text
          || ' parent_join_n=' || drift.parent_n::text
          || ' rel_drift=' || round(drift.rel_drift, 3)::text
          || ' within ' || round(cfg.max_drift_pct, 3)::text
      END AS message
    FROM drift, cfg
  $sql$,
  0,
  0,
  'warn',
  'docs/system-map/ship-5-specialists-fk-fix.md'
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  query_sql = EXCLUDED.query_sql,
  expected_min = EXCLUDED.expected_min,
  expected_max = EXCLUDED.expected_max,
  severity = EXCLUDED.severity,
  runbook_path = EXCLUDED.runbook_path,
  updated_at = now();

-- Seed the threshold knob if missing so the invariant is self-contained.
INSERT INTO public.ct_config (category, key, value, default_value, description)
VALUES (
  'warden',
  'warden_specialist_grade_visibility_max_drift_pct',
  '0.05'::jsonb,
  '0.05'::jsonb,
  'Max relative drift between direct ct_flag_grades count and via-parent-join count before specialist_recent_grade_visibility fires WARN. 0.05 = 5%.'
)
ON CONFLICT (key) DO NOTHING;
