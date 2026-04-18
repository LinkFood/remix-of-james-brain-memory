-- 20260420000011_premarket_gaps.sql
--
-- ct_premarket_gaps — daily overnight gap detector, 9:15 ET (13:15 UTC) weekdays.
--
-- 15 min before the US cash open Claude wants a read on how the watchlist sat
-- overnight. This table persists (prev_close, premarket_price, gap_pct, tier)
-- for every watchlist ticker, one row per (session_date, ticker). The morning
-- brief pulls today's rows and the PremarketGapsCard renders them inline.
--
-- Baseline ("prev_close") derivation lives in the edge function, not here:
--   - SPY uses yesterday's ct_spy_daily.close when available.
--   - All others use the most recent ct_heartbeats._snapshot.per_ticker.<T>.price
--     captured before today's pre-bell scan.
-- If a ticker has no usable baseline (never had a heartbeat), the row is
-- skipped — see the edge function for the graceful-skip branch.
--
-- gap_pct is GENERATED so inserts don't have to keep it in sync. When either
-- input is NULL we fall back to NULL rather than divide-by-zero.
--
-- Magnitude tiers use |gap_pct|:
--   < 0.2   flat
--   0.2-0.5 minor
--   0.5-1.5 moderate
--   1.5-3   significant
--   > 3     extreme
-- These are stored rather than computed so the UI / brief can filter cheaply.

SET search_path = public, extensions;

-- ============================================================================
-- Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS ct_premarket_gaps (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_date     date         NOT NULL,
  ticker           text         NOT NULL,
  prev_close       numeric,
  premarket_price  numeric,
  gap_pct          numeric GENERATED ALWAYS AS (
                     CASE
                       WHEN prev_close IS NULL OR prev_close = 0 OR premarket_price IS NULL THEN NULL
                       ELSE (premarket_price - prev_close) / prev_close * 100
                     END
                   ) STORED,
  gap_direction    text         CHECK (gap_direction IN ('up', 'down', 'flat')),
  magnitude_tier   text         CHECK (magnitude_tier IN ('minor', 'moderate', 'significant', 'extreme', 'flat')),
  captured_at      timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (session_date, ticker)
);

CREATE INDEX IF NOT EXISTS ct_premarket_gaps_session_desc
  ON ct_premarket_gaps (session_date DESC, ticker);

CREATE INDEX IF NOT EXISTS ct_premarket_gaps_tier
  ON ct_premarket_gaps (session_date DESC, magnitude_tier);

COMMENT ON TABLE ct_premarket_gaps IS
  'Daily overnight-gap snapshot per watchlist ticker captured at 9:15 ET by ct-premarket-scan.';
COMMENT ON COLUMN ct_premarket_gaps.gap_pct IS
  'Generated: (premarket_price - prev_close) / prev_close * 100. NULL when prev_close unavailable.';
COMMENT ON COLUMN ct_premarket_gaps.magnitude_tier IS
  'Absolute-value bucket. Use >= moderate as the brief-worthy threshold.';

-- ============================================================================
-- RLS — authenticated read, service role full
-- ============================================================================
ALTER TABLE ct_premarket_gaps ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ct_premarket_gaps_read ON ct_premarket_gaps;
DROP POLICY IF EXISTS ct_premarket_gaps_svc  ON ct_premarket_gaps;

CREATE POLICY ct_premarket_gaps_read
  ON ct_premarket_gaps FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY ct_premarket_gaps_svc
  ON ct_premarket_gaps FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- Trigger RPC — mirrors trigger_ct_spy_capture (uses _ct_post helper).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.trigger_ct_premarket_scan()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-premarket-scan'); $fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_premarket_scan() TO authenticated, service_role;

-- ============================================================================
-- Cron — 15 min before the US cash open (9:15 ET = 13:15 UTC during DST),
-- weekdays only. The scan is cheap: 12 UW calls, <10s total.
-- ============================================================================
SELECT cron.schedule(
  'ct-premarket-scan',
  '15 13 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-premarket-scan',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);
