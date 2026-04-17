-- =============================================================================
-- 20260419000004_iv_shifts.sql
--
-- Day-over-day IV rank shifts (vol regime change, session cadence).
--
-- iv_rank lives in ct_iv_rank_daily — written once per day per ticker by
-- ct-eod-positioning at 21:00 UTC. Heartbeats do NOT carry iv_rank, so we
-- cannot do intraday IV shift detection. Instead: scan ct_iv_rank_daily right
-- after EOD positioning lands, compute each watchlist ticker's delta between
-- the two most recent distinct dates, and emit a row whenever |delta| >= 10.
--
-- "SPY IV rank 22 → 48 (+26 day-over-day)" = vol regime shift worth surfacing.
--
-- Zero new UW calls — this reads only ct_iv_rank_daily.
--
-- Cadence: pg_cron at 21:05 UTC weekdays (5 min after ct-eod-positioning).
-- =============================================================================

SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- Table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_iv_shifts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  session_date    date NOT NULL,                         -- UTC date the cron ran
  ticker          text NOT NULL,
  prev_rank       numeric,                               -- iv_rank on prior distinct date
  new_rank        numeric,                               -- iv_rank on ref_day
  delta           numeric NOT NULL,                      -- new_rank - prev_rank
  direction       text NOT NULL CHECK (direction IN ('up','down')),
  attention_score int NOT NULL DEFAULT 60
    CHECK (attention_score BETWEEN 0 AND 100),
  ref_day         date NOT NULL                          -- the day new_rank was recorded
);

COMMENT ON TABLE ct_iv_shifts IS
  'Day-over-day IV rank shifts derived from ct_iv_rank_daily. One row per ticker per ref_day when |delta| >= 10. Attention ladder: |delta| >= 30 → 85, >= 20 → 75, >= 10 → 60.';

-- ----------------------------------------------------------------------------
-- Indexes
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_ct_iv_shifts_created_at
  ON ct_iv_shifts (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ct_iv_shifts_ticker_session
  ON ct_iv_shifts (ticker, session_date DESC);

CREATE INDEX IF NOT EXISTS idx_ct_iv_shifts_attention
  ON ct_iv_shifts (attention_score DESC);

-- ----------------------------------------------------------------------------
-- RLS: authenticated read, service role full
-- ----------------------------------------------------------------------------
ALTER TABLE ct_iv_shifts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ct_iv_shifts_authenticated_read ON ct_iv_shifts;
CREATE POLICY ct_iv_shifts_authenticated_read
  ON ct_iv_shifts
  FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS ct_iv_shifts_service_role_all ON ct_iv_shifts;
CREATE POLICY ct_iv_shifts_service_role_all
  ON ct_iv_shifts
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ----------------------------------------------------------------------------
-- Trigger RPC: invokes the ct-iv-shift-watch edge function
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trigger_ct_iv_shift_watch()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-iv-shift-watch'); $fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_iv_shift_watch() TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- pg_cron: 21:05 UTC weekdays (5 min after ct-eod-positioning at 21:00 UTC)
-- ----------------------------------------------------------------------------
SELECT cron.schedule(
  'ct-iv-shift-watch',
  '5 21 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-iv-shift-watch',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    )
  $cron$
);
