-- ============================================================================
-- Per-Thesis Scorecard RPC — one row per hypothesis, pre-aggregated server-side.
--
-- SQL-level aggregation is much cheaper than fetching raw ct_grades rows and
-- computing on the client. The UI ("PerThesisPanel") renders:
--   win rate · Elo · calibration delta · trend · last-graded-at
-- broken down per thesis.
--
-- Deterministic: no now()-based fields. last_grade_at is the MAX of the
-- underlying graded_at timestamps; that IS deterministic (depends on data).
--
-- Note: idx_ct_grades_hypothesis is already created by migration
-- 20260422000001_ct_theses.sql, so we skip it here.
-- ============================================================================
SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.ct_hypothesis_scorecard()
RETURNS TABLE (
  hypothesis_id       uuid,
  claim               text,
  status              text,
  confidence          numeric,
  elo                 int,
  tickers             text[],
  horizon             text,
  total_grades        int,
  wins                int,
  losses              int,
  win_rate            numeric,
  avg_return_pct      numeric,
  last_grade_at       timestamptz,
  calibration_delta   numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
  WITH grade_rollup AS (
    SELECT
      g.hypothesis_id,
      COUNT(*)::int                                                       AS total_grades,
      COUNT(*) FILTER (WHERE g.verdict = 'right')::int                    AS wins,
      COUNT(*) FILTER (WHERE g.verdict = 'wrong')::int                    AS losses,
      -- win rate over decided verdicts only (right + wrong + partial);
      -- ambiguous is excluded from the denominator to match the rest of
      -- the scorecard convention.
      CASE
        WHEN COUNT(*) FILTER (WHERE g.verdict IN ('right','wrong','partial')) = 0
          THEN NULL
        ELSE (COUNT(*) FILTER (WHERE g.verdict = 'right'))::numeric
             / COUNT(*) FILTER (WHERE g.verdict IN ('right','wrong','partial'))::numeric
      END                                                                 AS win_rate,
      AVG(g.actual_return_pct)                                            AS avg_return_pct,
      MAX(g.graded_at)                                                    AS last_grade_at,
      AVG(g.calibration_delta)                                            AS calibration_delta
    FROM ct_grades g
    WHERE g.hypothesis_id IS NOT NULL
    GROUP BY g.hypothesis_id
  )
  SELECT
    h.id                                           AS hypothesis_id,
    h.claim,
    h.status,
    h.confidence,
    h.elo,
    h.tickers,
    h.horizon,
    COALESCE(gr.total_grades, 0)                   AS total_grades,
    COALESCE(gr.wins, 0)                           AS wins,
    COALESCE(gr.losses, 0)                         AS losses,
    gr.win_rate,
    gr.avg_return_pct,
    gr.last_grade_at,
    gr.calibration_delta
  FROM ct_hypotheses h
  LEFT JOIN grade_rollup gr ON gr.hypothesis_id = h.id
  ORDER BY h.elo DESC, h.created_at DESC;
$fn$;

GRANT EXECUTE ON FUNCTION public.ct_hypothesis_scorecard()
  TO authenticated, service_role;

COMMENT ON FUNCTION public.ct_hypothesis_scorecard() IS
  'Per-thesis scorecard: one row per ct_hypothesis with win rate, Elo, calibration delta, and last-graded-at. Used by /scorecard PerThesisPanel.';
