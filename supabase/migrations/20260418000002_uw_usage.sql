-- UW API usage tracking. Every UW response carries x-uw-daily-req-count
-- and x-uw-token-req-limit headers — capture them so we can see in real
-- time how close to the daily limit we are, and throttle or upgrade
-- before we blow through it mid-session.
SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS ct_uw_usage (
  id              bigserial PRIMARY KEY,
  observed_at     timestamptz NOT NULL DEFAULT now(),
  session_date    date NOT NULL DEFAULT (now() AT TIME ZONE 'America/New_York')::date,
  endpoint        text NOT NULL,
  daily_count     int,
  daily_limit     int,
  status          int,
  ms              int,
  caller          text
);

CREATE INDEX IF NOT EXISTS ct_uw_usage_session ON ct_uw_usage (session_date DESC, observed_at DESC);
CREATE INDEX IF NOT EXISTS ct_uw_usage_endpoint ON ct_uw_usage (endpoint, observed_at DESC);

ALTER TABLE ct_uw_usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY ct_uw_usage_read ON ct_uw_usage FOR SELECT TO authenticated USING (true);
CREATE POLICY ct_uw_usage_svc  ON ct_uw_usage FOR ALL    TO service_role  USING (true) WITH CHECK (true);

-- Convenience: latest known daily count + limit (deduped per session).
CREATE OR REPLACE VIEW ct_uw_usage_latest AS
SELECT DISTINCT ON (session_date)
  session_date,
  observed_at,
  daily_count,
  daily_limit,
  CASE WHEN daily_limit > 0 THEN ROUND(daily_count::numeric / daily_limit::numeric * 100, 1) ELSE NULL END AS pct
FROM ct_uw_usage
WHERE daily_count IS NOT NULL
ORDER BY session_date DESC, observed_at DESC;

GRANT SELECT ON ct_uw_usage_latest TO authenticated;
