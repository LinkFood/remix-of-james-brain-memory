-- Wire live ct_alerts into the book. Today: 15 alerts with trade_setup blocks
-- fired during market hours, but NONE reached ct_trades because the only
-- book-opening flows are ct-claude-trade-open (9:26 ET) and the 10:30 reopen.
-- After that, alerts are purely advisory. This migration + ct-alert-book-commit
-- closes the loop with guardrails (cooldown, capacity, bias, whitelist, price).
--
-- Guarantees:
--   - ct_trades.source accepts 'alert' (prior constraint blocked it)
--   - ct_alerts.committed_trade_id points back at the trade that was opened
--     so we can see which alerts made it to the book and dedupe re-runs
--   - trigger RPC exists so James can invoke manually while tuning
--
-- Pg_cron schedule is intentionally NOT created here — James will add it
-- after observing a few manual runs.
SET search_path = public, extensions;

-- 1. Widen ct_trades.source to allow alert-sourced trades.
--    Prior constraint: ('claude','james_manual','chat_commit').
ALTER TABLE ct_trades DROP CONSTRAINT IF EXISTS ct_trades_source_check;
ALTER TABLE ct_trades
  ADD CONSTRAINT ct_trades_source_check
  CHECK (source IN ('claude','james_manual','chat_commit','alert'));

-- 2. Back-link alerts to the trade they opened. Nullable — most alerts will
--    NEVER commit (guards reject them, or they're invalidations).
ALTER TABLE ct_alerts
  ADD COLUMN IF NOT EXISTS committed_trade_id uuid REFERENCES ct_trades(id) ON DELETE SET NULL;

-- Partial index — only the tiny slice of alerts that actually made the book.
CREATE INDEX IF NOT EXISTS ct_alerts_committed
  ON ct_alerts (committed_trade_id)
  WHERE committed_trade_id IS NOT NULL;

-- 3. Trigger RPC — invokable from SQL editor / dashboard, mirrors the
--    pattern in 20260417000005_ct_book.sql.
CREATE OR REPLACE FUNCTION public.trigger_ct_alert_book_commit()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-alert-book-commit'); $fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_alert_book_commit() TO authenticated, service_role;

-- 4. Widen ct_reports.report_type to allow 'midday' — today's EOD gets a mid-session
--    sibling fired at 12:30 ET so James can see the tape + Claude's lean without
--    waiting till 5:30. Prior constraint: ('eod','weekly','quarterly').
ALTER TABLE ct_reports DROP CONSTRAINT IF EXISTS ct_reports_report_type_check;
ALTER TABLE ct_reports
  ADD CONSTRAINT ct_reports_report_type_check
  CHECK (report_type IN ('eod','midday','weekly','quarterly'));
