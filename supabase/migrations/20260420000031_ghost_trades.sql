-- =============================================================================
-- 20260420000031_ghost_trades.sql
--
-- Ghost Trades mode for ct-replay.
--
-- The replay harness already simulates the watcher's decision logic against a
-- historical session (dry-run, no real writes). "Ghost trades" layers one more
-- counterfactual on top: "what if James had auto-committed EVERY alert with a
-- trade_setup — direction != neutral, entry_level + stop_level + target_level
-- present?" We walk price history per alert and ask: did price hit stop,
-- target, or neither by horizon_end? Aggregate into a hypothetical P&L curve
-- and compare against what James actually traded that day.
--
-- This is a PURE SIMULATION. Nothing writes to ct_trades. The ghost book lives
-- only in ct_replay_runs.ghost_trades + ct_replay_runs.ghost_trades_summary.
--
-- Resolution caveat:
--   Exits are checked against ct_price_ticks first (2-min cadence, 7-day
--   retention) and fall back to ct_heartbeats _snapshot.per_ticker prices
--   (15-min cadence, no retention). 15-min resolution WILL miss stops that
--   were hit and recovered between ticks, and will use a coarse exit price.
--   The summary includes a `resolution` field so the UI can warn.
-- =============================================================================

SET search_path = public, extensions;

ALTER TABLE public.ct_replay_runs
  ADD COLUMN IF NOT EXISTS ghost_trades_summary jsonb,
  ADD COLUMN IF NOT EXISTS ghost_trades jsonb;

COMMENT ON COLUMN public.ct_replay_runs.ghost_trades_summary IS
  'Aggregate of ghost_trades mode: {mode, total_trades, wins, losses, pushes, win_rate, total_pnl_pct, total_pnl_usd, max_drawdown_pct, starting_equity, final_equity, resolution: "price_ticks"|"heartbeats"|"mixed", equity_curve: [{t, equity, pnl_pct}], actual_trades_count, actual_pnl_pct_session, filter_edge_usd, filter_edge_pct, insight_text}. Only populated when mode=ghost_trades.';

COMMENT ON COLUMN public.ct_replay_runs.ghost_trades IS
  'Array of simulated trades from ghost_trades mode. Each row: {alert_ref, tick_time, instrument, direction, entry_level, stop_level, target_level, horizon_end, size_pct, size_usd, exit_time, exit_price, exit_reason: "stop"|"target"|"horizon_close"|"no_price_data", realized_pnl_pct, realized_pnl_usd, resolution: "price_ticks"|"heartbeats", ticks_walked}. Length = number of qualifying alerts in the session.';
