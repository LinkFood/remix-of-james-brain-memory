-- ============================================================================
-- ct_ghost_pnl — Claude's paper-trading book.
-- Every FLAG (conviction >= 3) and every ALERT becomes a hypothetical trade.
-- Signed return respects direction (bullish=+, bearish=-, volatility=abs, neutral=0).
-- Joined to ct_grades for actual_return_pct and verdict at horizon close.
-- ============================================================================

CREATE OR REPLACE VIEW ct_ghost_pnl AS
SELECT
  'flag'::text AS source_type,
  f.id AS subject_id,
  (f.instruments)[1] AS instrument,
  f.direction,
  f.conviction,
  f.horizon,
  f.created_at AS opened_at,
  g.graded_at AS closed_at,
  g.actual_return_pct,
  CASE
    WHEN f.direction = 'bullish'    THEN g.actual_return_pct
    WHEN f.direction = 'bearish'    THEN -g.actual_return_pct
    WHEN f.direction = 'volatility' THEN abs(g.actual_return_pct)
    ELSE 0
  END AS signed_return_pct,
  g.verdict
FROM ct_flags f
JOIN ct_grades g ON g.id = f.grade_id AND g.subject_type = 'flag'
WHERE f.conviction >= 3

UNION ALL

SELECT
  'alert'::text AS source_type,
  a.id AS subject_id,
  (a.instruments)[1] AS instrument,
  a.direction,
  a.conviction,
  a.horizon,
  a.created_at AS opened_at,
  g.graded_at AS closed_at,
  g.actual_return_pct,
  CASE
    WHEN a.direction = 'bullish'    THEN g.actual_return_pct
    WHEN a.direction = 'bearish'    THEN -g.actual_return_pct
    WHEN a.direction = 'volatility' THEN abs(g.actual_return_pct)
    ELSE 0
  END AS signed_return_pct,
  g.verdict
FROM ct_alerts a
JOIN ct_grades g ON g.id = a.grade_id AND g.subject_type = 'alert'

ORDER BY closed_at;

GRANT SELECT ON ct_ghost_pnl TO authenticated;
GRANT SELECT ON ct_ghost_pnl TO service_role;
