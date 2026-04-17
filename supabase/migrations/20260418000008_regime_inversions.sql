-- =============================================================================
-- 20260418000008_regime_inversions.sql
--
-- Dealer gamma regime inversions (session-scale structural flips).
--
-- Positive gamma regime: price above gamma-flip level → dealers long gamma →
-- they dampen volatility → mean-reverting / pinning behavior.
-- Negative gamma regime: price below gamma-flip level → dealers short gamma →
-- they amplify volatility → trending / momentum behavior.
--
-- A flip between these two states is a STRUCTURAL REGIME CHANGE — rare,
-- high-signal, always-on alert-worthy. We emit the first flip per ticker per
-- session (with a 60-min re-fire exception for multi-flip days).
--
-- Source of truth: ct_heartbeats.current_reads — regime is derived at watcher
-- condense-time and captured on every heartbeat. Zero new UW calls.
-- =============================================================================

SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- Table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_regime_inversions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  session_date    date NOT NULL,
  ticker          text NOT NULL,               -- watchlist ticker or 'SPX' for macro
  prev_regime     text NOT NULL
    CHECK (prev_regime IN ('positive','negative')),
  new_regime      text NOT NULL
    CHECK (new_regime  IN ('positive','negative')),
  prev_net_gamma  numeric,
  new_net_gamma   numeric,
  flip_level      numeric,                     -- gamma-flip strike at new heartbeat
  spot_at_flip    numeric,
  heartbeat_id    uuid REFERENCES ct_heartbeats(id) ON DELETE SET NULL,
  attention_score int NOT NULL DEFAULT 80
    CHECK (attention_score BETWEEN 0 AND 100)
);

COMMENT ON TABLE ct_regime_inversions IS
  'Dealer gamma regime flips (positive<->negative). One row per flip. Session dedupe with 60-min re-fire exception. Attention 80 by default — always high-signal.';

-- ----------------------------------------------------------------------------
-- Indexes
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_ct_regime_inversions_session_created
  ON ct_regime_inversions (session_date DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ct_regime_inversions_ticker_session
  ON ct_regime_inversions (ticker, session_date DESC);

-- ----------------------------------------------------------------------------
-- RLS: authenticated read, service role full
-- ----------------------------------------------------------------------------
ALTER TABLE ct_regime_inversions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ct_regime_inversions_authenticated_read ON ct_regime_inversions;
CREATE POLICY ct_regime_inversions_authenticated_read
  ON ct_regime_inversions
  FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS ct_regime_inversions_service_role_all ON ct_regime_inversions;
CREATE POLICY ct_regime_inversions_service_role_all
  ON ct_regime_inversions
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ----------------------------------------------------------------------------
-- Trigger RPC: invokes the ct-regime-watch edge function
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trigger_ct_regime_watch()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-regime-watch'); $fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_regime_watch() TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- pg_cron: every 5 min, weekdays 13-20 UTC (~9am-4pm ET market hours)
-- Heartbeats write every ~15 min, so a 5-min watch catches every new write
-- within 5 minutes of it landing.
-- ----------------------------------------------------------------------------
SELECT cron.schedule(
  'ct-regime-watch',
  '*/5 13-20 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-regime-watch',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    )
  $cron$
);
