-- UW publishes 5 rate-limit headers on every response. We already capture
-- x-uw-daily-req-count and x-uw-token-req-limit. Extend ct_uw_usage with
-- the 3 minute-level headers so non-critical crons can back off when the
-- per-minute budget is stressed, not just when the daily budget is.
--
-- Headers (per UW documentation):
--   x-uw-daily-req-count          → daily_count   (already captured)
--   x-uw-token-req-limit          → daily_limit   (already captured)
--   x-uw-minute-req-counter       → minute_counter   (NEW)
--   x-uw-req-per-minute-remaining → minute_remaining (NEW)
--   x-uw-req-per-minute-reset     → minute_reset_at  (NEW, timestamp)
--
-- Also backfill `caller` (source edge function name) so we can attribute
-- UW spend per function when inspecting the budget bar.
SET search_path = public, extensions;

ALTER TABLE ct_uw_usage
  ADD COLUMN IF NOT EXISTS minute_counter    int,
  ADD COLUMN IF NOT EXISTS minute_remaining  int,
  ADD COLUMN IF NOT EXISTS minute_reset_at   timestamptz;

-- Rebuild latest view to include minute pressure. Keep existing column
-- order + semantics intact so UwUsageBadge keeps working.
DROP VIEW IF EXISTS ct_uw_usage_latest;
CREATE VIEW ct_uw_usage_latest AS
SELECT DISTINCT ON (session_date)
  session_date,
  observed_at,
  daily_count,
  daily_limit,
  CASE WHEN daily_limit > 0 THEN ROUND(daily_count::numeric / daily_limit::numeric * 100, 1) ELSE NULL END AS pct,
  minute_counter,
  minute_remaining,
  minute_reset_at
FROM ct_uw_usage
WHERE daily_count IS NOT NULL
ORDER BY session_date DESC, observed_at DESC;

GRANT SELECT ON ct_uw_usage_latest TO authenticated;

-- Helper RPC: "should non-critical callers bail?"
-- Returns true when daily_count >= threshold * daily_limit for the most
-- recent sample today, OR when minute_remaining is below a per-minute
-- floor. Specialists + grader ignore this (they're critical). Backfills,
-- screener sweeps, and probes call this before firing UW traffic.
CREATE OR REPLACE FUNCTION ct_uw_budget_ok(
  daily_threshold numeric DEFAULT 0.95,
  minute_floor    int     DEFAULT 10
) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (
      SELECT
        CASE
          WHEN daily_limit IS NULL OR daily_limit = 0 THEN true
          WHEN daily_count::numeric / daily_limit::numeric >= daily_threshold THEN false
          WHEN minute_remaining IS NOT NULL AND minute_remaining < minute_floor THEN false
          ELSE true
        END
      FROM ct_uw_usage_latest
      LIMIT 1
    ),
    true  -- no samples → assume ok
  );
$$;

GRANT EXECUTE ON FUNCTION ct_uw_budget_ok(numeric, int) TO authenticated, service_role;

COMMENT ON FUNCTION ct_uw_budget_ok IS
  'Returns false when UW daily budget is ≥95% consumed OR per-minute remaining <10. Non-critical crons call this to voluntarily bail before contributing to exhaustion.';
