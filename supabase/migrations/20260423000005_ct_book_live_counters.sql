-- Fix: ct_book.trades_count / wins / losses / realized_pnl only update at EOD
-- close. Intraday digests show "0 trades (0W/0L)" while the book is churning.
-- Also: Claude often has no ct_book row at all for a session because
-- ct-claude-trade-open creates one only if the session has NO book row —
-- but james-side activity can create the james row first, skipping Claude.
--
-- Two-part fix:
--   A. Trigger on ct_trades that refreshes counters + P&L on ct_book per
--      (trader, session_date) on any INSERT/UPDATE/DELETE. Creates the row
--      if missing. Always live.
--   B. One-time backfill for today's data so the digest stops lying right now.

-- ============================================================================
-- A. Trigger function
-- ============================================================================

CREATE OR REPLACE FUNCTION public._ct_refresh_book_counters()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_session DATE;
  v_trader  TEXT;
BEGIN
  -- Use NEW for INSERT/UPDATE, OLD for DELETE
  IF TG_OP = 'DELETE' THEN
    v_session := OLD.session_date;
    v_trader  := OLD.trader;
  ELSE
    v_session := NEW.session_date;
    v_trader  := NEW.trader;
  END IF;

  IF v_session IS NULL OR v_trader IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Ensure the row exists. Uses the existing UNIQUE(trader, session_date).
  -- Starting balance rolls yesterday's ending_balance forward if present.
  INSERT INTO public.ct_book (trader, session_date, starting_balance, high_water_mark)
  SELECT
    v_trader,
    v_session,
    COALESCE(
      (SELECT ending_balance FROM public.ct_book
       WHERE trader = v_trader AND session_date < v_session AND ending_balance IS NOT NULL
       ORDER BY session_date DESC LIMIT 1),
      CASE WHEN v_trader = 'claude' THEN 50000 ELSE 10000 END
    ),
    COALESCE(
      (SELECT high_water_mark FROM public.ct_book
       WHERE trader = v_trader AND session_date < v_session
       ORDER BY session_date DESC LIMIT 1),
      CASE WHEN v_trader = 'claude' THEN 50000 ELSE 10000 END
    )
  ON CONFLICT (trader, session_date) DO NOTHING;

  -- Recompute live counters. P&L uses realized_pnl_usd when populated,
  -- else realized_pnl_pct * size_usd / 100 (book-manager writes pct only
  -- until EOD; this gives us live dollar P&L without waiting).
  UPDATE public.ct_book b
  SET
    trades_count = sub.trades_count,
    wins         = sub.wins,
    losses       = sub.losses,
    realized_pnl = sub.realized_pnl,
    updated_at   = now()
  FROM (
    SELECT
      count(*) FILTER (WHERE status IN ('open','closed'))                                AS trades_count,
      count(*) FILTER (WHERE status = 'closed' AND coalesce(realized_pnl_pct, 0) > 0)    AS wins,
      count(*) FILTER (WHERE status = 'closed' AND coalesce(realized_pnl_pct, 0) < 0)    AS losses,
      coalesce(
        sum(
          coalesce(
            realized_pnl_usd,
            (coalesce(size_usd, 0) * coalesce(realized_pnl_pct, 0) / 100.0)
          )
        ) FILTER (WHERE status = 'closed'),
        0
      ) AS realized_pnl
    FROM public.ct_trades
    WHERE trader = v_trader AND session_date = v_session
  ) sub
  WHERE b.trader = v_trader AND b.session_date = v_session;

  RETURN COALESCE(NEW, OLD);
END $$;

-- ============================================================================
-- Install trigger
-- ============================================================================

DROP TRIGGER IF EXISTS ct_trades_refresh_book ON public.ct_trades;
CREATE TRIGGER ct_trades_refresh_book
AFTER INSERT OR UPDATE OR DELETE ON public.ct_trades
FOR EACH ROW
EXECUTE FUNCTION public._ct_refresh_book_counters();

-- ============================================================================
-- B. Backfill — force refresh for every existing (trader, session_date) pair
-- in ct_trades. Runs the same computation the trigger does, but in one pass.
-- ============================================================================

-- First ensure rows exist for every (trader, session_date) that has trades
INSERT INTO public.ct_book (trader, session_date, starting_balance, high_water_mark)
SELECT DISTINCT
  t.trader,
  t.session_date,
  CASE WHEN t.trader = 'claude' THEN 50000 ELSE 10000 END,
  CASE WHEN t.trader = 'claude' THEN 50000 ELSE 10000 END
FROM public.ct_trades t
LEFT JOIN public.ct_book b
  ON b.trader = t.trader AND b.session_date = t.session_date
WHERE b.id IS NULL AND t.trader IS NOT NULL AND t.session_date IS NOT NULL
ON CONFLICT (trader, session_date) DO NOTHING;

-- Then refresh counters for everyone
UPDATE public.ct_book b
SET
  trades_count = sub.trades_count,
  wins         = sub.wins,
  losses       = sub.losses,
  realized_pnl = sub.realized_pnl,
  updated_at   = now()
FROM (
  SELECT
    trader,
    session_date,
    count(*) FILTER (WHERE status IN ('open','closed'))                                AS trades_count,
    count(*) FILTER (WHERE status = 'closed' AND coalesce(realized_pnl_pct, 0) > 0)    AS wins,
    count(*) FILTER (WHERE status = 'closed' AND coalesce(realized_pnl_pct, 0) < 0)    AS losses,
    coalesce(
      sum(
        coalesce(
          realized_pnl_usd,
          (coalesce(size_usd, 0) * coalesce(realized_pnl_pct, 0) / 100.0)
        )
      ) FILTER (WHERE status = 'closed'),
      0
    ) AS realized_pnl
  FROM public.ct_trades
  WHERE trader IS NOT NULL AND session_date IS NOT NULL
  GROUP BY trader, session_date
) sub
WHERE b.trader = sub.trader AND b.session_date = sub.session_date;
