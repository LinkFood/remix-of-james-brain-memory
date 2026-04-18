-- ct_drawdown_alerts — kill-switch-level guardrail for Claude's $10k paper book.
--
-- ct-book-manager updates ct_book.realized_pnl / unrealized_pnl every 15min.
-- ct-drawdown-watch polls every 10min during RTH, reads the current session's
-- ct_book row, computes live intraday P&L + drawdown from HWM, and fires a
-- Slack alert once per (session_date, tier) when thresholds are breached.
--
-- Dedupe IS THE UNIQUE CONSTRAINT. The watch function attempts an INSERT;
-- a unique-violation (Postgres 23505) means "already alerted this tier today,
-- skip quietly." Tier upgrades (warn → urgent) fire naturally because they
-- insert under a different tier key.
--
-- James decides kill — we never auto-kill.
SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS ct_drawdown_alerts (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_date            date NOT NULL,
  tier                    text NOT NULL CHECK (tier IN ('warn','urgent')),
  intraday_pnl_pct        numeric NOT NULL,     -- negative when down on day
  drawdown_from_hwm_pct   numeric NOT NULL,     -- negative when below HWM
  equity_at_trigger       numeric NOT NULL,     -- live_equity at time of alert
  created_at              timestamptz NOT NULL DEFAULT now(),
  -- THE DEDUPE: one alert per tier per session. INSERT fails with unique
  -- violation on retry; the function catches it and moves on.
  CONSTRAINT ct_drawdown_alerts_session_tier_uniq UNIQUE (session_date, tier)
);

CREATE INDEX IF NOT EXISTS ct_drawdown_alerts_session
  ON ct_drawdown_alerts (session_date DESC, tier);

-- RLS: auth read, service_role full
ALTER TABLE ct_drawdown_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY ct_drawdown_alerts_read ON ct_drawdown_alerts
  FOR SELECT TO authenticated USING (true);
CREATE POLICY ct_drawdown_alerts_svc  ON ct_drawdown_alerts
  FOR ALL    TO service_role  USING (true) WITH CHECK (true);

-- Trigger RPC — matches pattern from 20260417000005_ct_book.sql.
CREATE OR REPLACE FUNCTION public.trigger_ct_drawdown_watch()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-drawdown-watch'); $fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_drawdown_watch() TO authenticated, service_role;

-- Cron: every 10min during RTH (13:00-20:00 UTC = 9am-4pm ET), weekdays.
-- Overlaps ct-book-manager (*/15) deliberately — drawdown must check often.
SELECT cron.schedule(
  'ct-drawdown-watch',
  '*/10 13-20 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-drawdown-watch',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);
