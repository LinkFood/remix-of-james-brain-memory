-- ct_trades live P&L — per-trade unrealized tracking for open positions.
--
-- realized_pnl_pct / realized_pnl_usd fire only at close. Between entry and
-- exit, the trades table rendered "—" for P&L because we had no field for
-- unrealized. ct-book-manager runs every 15min during RTH and already has
-- current price per trade (for hard-stop / target checks), so it writes
-- these three fields as a free byproduct — zero extra UW calls.
--
-- live_pnl_updated_at lets the frontend show "(stale)" when the book
-- manager hasn't run in >20min (cron skip, market closed, or function
-- error). Index on (status, live_pnl_updated_at) makes "stale opens"
-- queries cheap.
SET search_path = public, extensions;

ALTER TABLE ct_trades
  ADD COLUMN IF NOT EXISTS live_pnl_pct        numeric,
  ADD COLUMN IF NOT EXISTS live_pnl_usd        numeric,
  ADD COLUMN IF NOT EXISTS live_pnl_updated_at timestamptz;

CREATE INDEX IF NOT EXISTS ct_trades_status_live_pnl_updated
  ON ct_trades (status, live_pnl_updated_at DESC);
