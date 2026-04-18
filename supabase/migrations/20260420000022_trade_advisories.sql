-- ============================================================================
-- ct_trade_advisories — ADVISORY (non-executing) per-open-position
-- recommendations from Claude Haiku.
--
-- Why this exists as a separate layer from ct_book_manager:
--   ct-book-manager EXECUTES. A CUT closes the position, a SCALE_OUT writes
--   a new size, a FLIP rips the trade and opens the opposite side. Fast,
--   deterministic, irreversible.
--
--   ct-trade-advisories ADVISES. Claude looks at the same tape Claude did
--   15min ago and offers a second opinion: "given what I'm seeing NOW —
--   new flow, new attention, new heartbeat read — here's what I would
--   consider doing." James reads. James decides. Nothing auto-fires.
--
--   Think of the book manager as Claude's hands on the wheel and
--   advisories as Claude's voice from the passenger seat. Both speak
--   every 15min, offset by 7min so they don't step on each other.
--
-- Produced by ct-trade-advisories edge function (cron 7,22,37,52 13-20
-- Mon-Fri, one Haiku call per open trade per tick).
--
-- RLS: single-user system.
--   - authenticated SELECT: James reads his own advisories.
--   - authenticated UPDATE: James acknowledges ("ack checkbox") —
--     narrowed to the acknowledgement columns via the same column-scope
--     trigger pattern used on ct_trades' journal columns. INSERTs remain
--     service-role only.
--   - service_role: full access (writer path).
-- ============================================================================

SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS ct_trade_advisories (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id                uuid NOT NULL REFERENCES ct_trades(id) ON DELETE CASCADE,
  created_at              timestamptz NOT NULL DEFAULT now(),

  -- The six advisory verbs. CHECK keeps the set closed so the UI can
  -- color/pill them deterministically.
  --   hold            — nothing new; keep the trade as-is. Default.
  --   tighten_stop    — move stop closer to price to protect gains/cap risk.
  --   trail           — convert to trailing stop to lock a winner.
  --   cut             — close the trade now (thesis invalidation).
  --   scale_out       — trim part of the position (take some off).
  --   flip_consider   — very rare: consider closing and flipping sides.
  advisory_type           text NOT NULL
    CHECK (advisory_type IN ('hold','tighten_stop','trail','cut','scale_out','flip_consider')),

  -- 1 = FYI, just logging. 5 = James should look at this NOW.
  -- Slack push fires at urgency >= 4.
  urgency                 int NOT NULL CHECK (urgency BETWEEN 1 AND 5),

  -- 2-sentence plain-prose reasoning, numbers-first, cites the new
  -- evidence since commit.
  reasoning               text NOT NULL,

  -- Mark-to-market % at advisory time. Snapshot so the advisory is
  -- interpretable later even after the trade closes.
  current_unrealized_pct  numeric,

  -- Condensed context Claude read to produce the advisory:
  --   { heartbeat_id, heartbeat_status_line, recent_attention: [...],
  --     expected_move: {...}, book_manager_last_action: '...' }
  -- Shape intentionally flexible — this is a forensic record, not an API.
  claude_read_context     jsonb,

  -- Acknowledgement fields — James clicks a checkbox in the UI.
  acknowledged_by_james   boolean NOT NULL DEFAULT false,
  acknowledged_at         timestamptz
);

-- Hot read: "show me every advisory for this trade, newest first."
CREATE INDEX IF NOT EXISTS ct_trade_advisories_trade_created
  ON ct_trade_advisories (trade_id, created_at DESC);

-- Sidebar read: "top unacked advisories by urgency."
CREATE INDEX IF NOT EXISTS ct_trade_advisories_unacked_urgency
  ON ct_trade_advisories (acknowledged_by_james, urgency DESC);

-- Dedupe-window read: "last advisory for trade X" — the edge function
-- uses (trade_id, created_at DESC) to pull the most recent row and
-- compare advisory_type + urgency within the 15-min window. The
-- existing ct_trade_advisories_trade_created index already covers it.

ALTER TABLE ct_trade_advisories ENABLE ROW LEVEL SECURITY;

-- Read: authenticated sees everything (single-user system).
DROP POLICY IF EXISTS ct_trade_advisories_read ON ct_trade_advisories;
CREATE POLICY ct_trade_advisories_read
  ON ct_trade_advisories FOR SELECT TO authenticated USING (true);

-- Update: authenticated may acknowledge. Column-scope enforcement below
-- restricts the update to acknowledgement fields — the advisory itself
-- (type, urgency, reasoning, context) is immutable from the client.
DROP POLICY IF EXISTS ct_trade_advisories_ack ON ct_trade_advisories;
CREATE POLICY ct_trade_advisories_ack
  ON ct_trade_advisories FOR UPDATE TO authenticated
  USING (true) WITH CHECK (true);

-- Writer path: service_role only.
DROP POLICY IF EXISTS ct_trade_advisories_svc ON ct_trade_advisories;
CREATE POLICY ct_trade_advisories_svc
  ON ct_trade_advisories FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Column-scope guard — authenticated UPDATE may only touch the two
-- acknowledgement columns. Anything else is a breach (mirrors the
-- ct_trades journal guard from migration 20260419000015).
CREATE OR REPLACE FUNCTION ct_trade_advisories_ack_only_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  -- service_role bypasses — this guard only fires under authenticated.
  IF current_setting('request.jwt.claims', true) IS NULL THEN
    RETURN NEW;
  END IF;
  IF (auth.role() IS DISTINCT FROM 'authenticated') THEN
    RETURN NEW;
  END IF;

  -- Reject any change to the non-ack columns.
  IF NEW.trade_id               IS DISTINCT FROM OLD.trade_id
  OR NEW.created_at              IS DISTINCT FROM OLD.created_at
  OR NEW.advisory_type           IS DISTINCT FROM OLD.advisory_type
  OR NEW.urgency                 IS DISTINCT FROM OLD.urgency
  OR NEW.reasoning               IS DISTINCT FROM OLD.reasoning
  OR NEW.current_unrealized_pct  IS DISTINCT FROM OLD.current_unrealized_pct
  OR NEW.claude_read_context     IS DISTINCT FROM OLD.claude_read_context
  THEN
    RAISE EXCEPTION 'authenticated UPDATE on ct_trade_advisories may only change acknowledged_by_james + acknowledged_at';
  END IF;

  -- If James is flipping ack true and hasn't stamped the time, do it for him.
  IF NEW.acknowledged_by_james = true AND NEW.acknowledged_at IS NULL THEN
    NEW.acknowledged_at := now();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ct_trade_advisories_ack_guard ON ct_trade_advisories;
CREATE TRIGGER ct_trade_advisories_ack_guard
  BEFORE UPDATE ON ct_trade_advisories
  FOR EACH ROW EXECUTE FUNCTION ct_trade_advisories_ack_only_guard();

COMMENT ON TABLE  ct_trade_advisories IS
  'Advisory (non-executing) per-open-position recommendations from Claude Haiku. Emitted by ct-trade-advisories every 15min during RTH, offset 7min from ct-book-manager. James reads, decides, acknowledges — nothing auto-fires.';

COMMENT ON COLUMN ct_trade_advisories.advisory_type IS
  'hold | tighten_stop | trail | cut | scale_out | flip_consider. Closed set — UI pills depend on this.';
COMMENT ON COLUMN ct_trade_advisories.urgency IS
  '1=FYI, 5=consider action now. Slack push fires at urgency >= 4.';
COMMENT ON COLUMN ct_trade_advisories.reasoning IS
  '2 sentences, numbers-first, cites the NEW evidence since commit. No cheerleading.';
COMMENT ON COLUMN ct_trade_advisories.current_unrealized_pct IS
  'Mark-to-market % at advisory time. Snapshot so the advisory stays interpretable after close.';
COMMENT ON COLUMN ct_trade_advisories.claude_read_context IS
  'Condensed forensic record: heartbeat_id/status, recent attention, expected_move, last book_manager action. Shape flexible.';
COMMENT ON COLUMN ct_trade_advisories.acknowledged_by_james IS
  'Flipped true via the Ack checkbox in the Trade Journal / CommandStation advisories strip.';

-- ============================================================================
-- Schedule ct-trade-advisories — 7,22,37,52 13-20 UTC Mon-Fri.
--
-- Offset 7min from ct-book-manager (which fires at :00/:15/:30/:45 during
-- 13:30–19:45 UTC / 09:30–15:45 ET). The advisory layer speaks 7min AFTER
-- each book-manager tick so:
--   1. book-manager has already written its action row (we read it as context)
--   2. the two layers never compete for UW / Claude budget at the same instant
--   3. James gets a second look 7min later — the freshest possible read
--      before the next book-manager tick
--
-- Window 13-20 UTC covers 09:00–16:00 ET (a little before/after bell), which
-- is wider than book-manager's strict RTH so the premarket and early-post-
-- bell ticks still get advisory coverage when open positions carry overnight
-- (uncommon but possible for multi-day holds).
--
-- The edge function itself early-exits if the open book is empty, so ticks
-- outside active positions cost one cheap query and bail.
-- ============================================================================
SELECT cron.schedule(
  'ct-trade-advisories',
  '7,22,37,52 13-20 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-trade-advisories',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);
