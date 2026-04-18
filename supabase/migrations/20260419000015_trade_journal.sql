-- Trade journal — per-trade notes from Claude (post-mortem) and James (freeform).
--
-- Every closed trade deserves a post-mortem. ct-book-manager writes one at
-- close (fire-and-forget Haiku call). ct-book-eod-close backfills any
-- closes it missed (e.g. eod_flat without a prior post-mortem). James can
-- add his own freeform notes at any time — even on planned/open trades
-- (pre-trade thesis refinement).
--
-- journal_version increments on every Claude regenerate. The current note
-- always overwrites, but the version bump creates an implicit history trail
-- (higher version = more regenerations, meaning the trade was important
-- enough to revisit).
--
-- RLS: reads were already open to `authenticated` via policy on 05. We add
-- a narrow authenticated UPDATE policy here limited to journal columns —
-- James can edit his own notes, but cannot alter trade economics (entry,
-- stop, realized_pnl, etc). service_role remains full access.

SET search_path = public, extensions;

ALTER TABLE ct_trades
  ADD COLUMN IF NOT EXISTS claude_notes         text,
  ADD COLUMN IF NOT EXISTS james_notes          text,
  ADD COLUMN IF NOT EXISTS journal_updated_at   timestamptz,
  ADD COLUMN IF NOT EXISTS journal_version      int NOT NULL DEFAULT 1;

-- Partial index: finding closed trades without a post-mortem is the hot
-- query for the EOD backfill path. Keep it tight.
CREATE INDEX IF NOT EXISTS ct_trades_missing_claude_notes
  ON ct_trades (session_date, closed_at DESC)
  WHERE status = 'closed' AND claude_notes IS NULL;

-- Authenticated UPDATE policy — scoped to journal columns only.
-- Postgres RLS doesn't gate columns directly, so we rely on a trigger to
-- reject writes that touch anything else. Service role bypasses RLS
-- entirely so the ct-book-manager / ct-book-eod-close paths are unaffected.
DROP POLICY IF EXISTS ct_trades_journal_update ON ct_trades;
CREATE POLICY ct_trades_journal_update
  ON ct_trades
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- Column-scope guard — only allow authenticated writers to change journal
-- fields. Anything else (entry_price, status, size, realized_pnl_*, …)
-- would be a bug in the client and we reject it loudly.
CREATE OR REPLACE FUNCTION ct_trades_guard_authenticated_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  r text := current_setting('request.jwt.claim.role', true);
BEGIN
  -- Service role bypasses (shouldn't hit this trigger via RLS but belt+braces)
  IF r IS NULL OR r <> 'authenticated' THEN
    RETURN NEW;
  END IF;

  -- Every non-journal column must be unchanged.
  IF NEW.id                  IS DISTINCT FROM OLD.id                  THEN RAISE EXCEPTION 'ct_trades: authenticated UPDATE may only touch journal columns (id)'; END IF;
  IF NEW.session_date        IS DISTINCT FROM OLD.session_date        THEN RAISE EXCEPTION 'ct_trades: authenticated UPDATE may only touch journal columns (session_date)'; END IF;
  IF NEW.instrument          IS DISTINCT FROM OLD.instrument          THEN RAISE EXCEPTION 'ct_trades: authenticated UPDATE may only touch journal columns (instrument)'; END IF;
  IF NEW.side                IS DISTINCT FROM OLD.side                THEN RAISE EXCEPTION 'ct_trades: authenticated UPDATE may only touch journal columns (side)'; END IF;
  IF NEW.size_pct            IS DISTINCT FROM OLD.size_pct            THEN RAISE EXCEPTION 'ct_trades: authenticated UPDATE may only touch journal columns (size_pct)'; END IF;
  IF NEW.size_usd            IS DISTINCT FROM OLD.size_usd            THEN RAISE EXCEPTION 'ct_trades: authenticated UPDATE may only touch journal columns (size_usd)'; END IF;
  IF NEW.entry_price         IS DISTINCT FROM OLD.entry_price         THEN RAISE EXCEPTION 'ct_trades: authenticated UPDATE may only touch journal columns (entry_price)'; END IF;
  IF NEW.stop_price          IS DISTINCT FROM OLD.stop_price          THEN RAISE EXCEPTION 'ct_trades: authenticated UPDATE may only touch journal columns (stop_price)'; END IF;
  IF NEW.target_price        IS DISTINCT FROM OLD.target_price        THEN RAISE EXCEPTION 'ct_trades: authenticated UPDATE may only touch journal columns (target_price)'; END IF;
  IF NEW.thesis              IS DISTINCT FROM OLD.thesis              THEN RAISE EXCEPTION 'ct_trades: authenticated UPDATE may only touch journal columns (thesis)'; END IF;
  IF NEW.conviction          IS DISTINCT FROM OLD.conviction          THEN RAISE EXCEPTION 'ct_trades: authenticated UPDATE may only touch journal columns (conviction)'; END IF;
  IF NEW.status              IS DISTINCT FROM OLD.status              THEN RAISE EXCEPTION 'ct_trades: authenticated UPDATE may only touch journal columns (status)'; END IF;
  IF NEW.opened_at           IS DISTINCT FROM OLD.opened_at           THEN RAISE EXCEPTION 'ct_trades: authenticated UPDATE may only touch journal columns (opened_at)'; END IF;
  IF NEW.close_price         IS DISTINCT FROM OLD.close_price         THEN RAISE EXCEPTION 'ct_trades: authenticated UPDATE may only touch journal columns (close_price)'; END IF;
  IF NEW.closed_at           IS DISTINCT FROM OLD.closed_at           THEN RAISE EXCEPTION 'ct_trades: authenticated UPDATE may only touch journal columns (closed_at)'; END IF;
  IF NEW.close_reason        IS DISTINCT FROM OLD.close_reason        THEN RAISE EXCEPTION 'ct_trades: authenticated UPDATE may only touch journal columns (close_reason)'; END IF;
  IF NEW.realized_pnl_pct    IS DISTINCT FROM OLD.realized_pnl_pct    THEN RAISE EXCEPTION 'ct_trades: authenticated UPDATE may only touch journal columns (realized_pnl_pct)'; END IF;
  IF NEW.realized_pnl_usd    IS DISTINCT FROM OLD.realized_pnl_usd    THEN RAISE EXCEPTION 'ct_trades: authenticated UPDATE may only touch journal columns (realized_pnl_usd)'; END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ct_trades_guard_authenticated_update_trg ON ct_trades;
CREATE TRIGGER ct_trades_guard_authenticated_update_trg
  BEFORE UPDATE ON ct_trades
  FOR EACH ROW
  EXECUTE FUNCTION ct_trades_guard_authenticated_update();

COMMENT ON COLUMN ct_trades.claude_notes        IS 'Post-mortem written by Claude Haiku at close (ct-book-manager or ct-book-eod-close backfill). Markdown ok.';
COMMENT ON COLUMN ct_trades.james_notes         IS 'Freeform journal notes from the user. Edited live via Book.tsx, saved via RLS UPDATE.';
COMMENT ON COLUMN ct_trades.journal_updated_at  IS 'Touched on any journal write (either side).';
COMMENT ON COLUMN ct_trades.journal_version     IS 'Increments on every claude_notes regeneration. Higher = more revisits.';
