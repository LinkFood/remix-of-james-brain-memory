-- Fix: two calls to ct-claude-trade-open fired 0.4s apart on 2026-04-23 created
-- duplicate AMZN long 7.5% @ $255.56 rows. Both still open → Claude's book
-- exposure on AMZN is 17.5%, over the 10% hard ceiling (tenet 15).
--
-- Two-part fix:
--   1. Cancel the later duplicate row (preserves audit, frees exposure)
--   2. Partial unique index prevents future duplicates at the data layer.
--
-- The index is scoped to status IN ('planned','open') so legitimately-closed
-- trades with identical past params don't block re-entry. Pyramiding at a
-- different size or price is still allowed.

-- Part 1: cleanup today's duplicate. Keep the earliest, cancel the later.
-- (We identify the duplicate by opened_at > the earliest of its group.)
WITH dupes AS (
  SELECT id
  FROM (
    SELECT
      id,
      row_number() OVER (
        PARTITION BY trader, session_date, instrument, side, entry_price, size_pct, status
        ORDER BY opened_at ASC
      ) AS rn
    FROM public.ct_trades
    WHERE status IN ('open','planned')
  ) t
  WHERE rn > 1
)
UPDATE public.ct_trades
SET
  status = 'cancelled',
  closed_at = now(),
  close_reason = 'duplicate_write_dedupe',
  close_price = entry_price,
  realized_pnl_pct = 0,
  realized_pnl_usd = 0
WHERE id IN (SELECT id FROM dupes);

-- Part 2: prevent future duplicates. Partial unique — only for open/planned.
CREATE UNIQUE INDEX IF NOT EXISTS ct_trades_dedupe_open_planned
  ON public.ct_trades (trader, session_date, instrument, side, entry_price, size_pct)
  WHERE status IN ('planned','open');

COMMENT ON INDEX public.ct_trades_dedupe_open_planned IS
  'Partial unique — prevents parallel ct-claude-trade-open invocations from writing identical open rows. Scoped so closed/cancelled trades do not block re-entry at the same price.';
