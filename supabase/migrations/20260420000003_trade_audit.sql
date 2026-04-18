-- ============================================================================
-- ct_trade_audit — forensic, compliance-grade audit trail for every trade.
--
-- The promise: given any ct_trades row, James can reconstruct what Claude saw,
-- what he queried (MCP calls), what biases were in play, how size was computed,
-- and the raw JSON response that produced the trade — at the moment of commit.
--
-- Three commit paths write to this table:
--   - ct-claude-trade-open        (source='claude-trade-open', 9:26 ET opens)
--   - ct-alert-book-commit        (source='alert-book-commit', intraday alerts)
--   - ct-chat (commit command)    (source='chat', manual slash-command)
--
-- Audit writes are fire-and-forget from the commit path — they never block
-- the trade insert. A missing audit row is recoverable; a missing trade is not.
--
-- Multiple audit rows per trade are expected (open + modify + close). Query
-- by trade_id DESC created_at to get the timeline.
--
-- RLS: authenticated can read (single-user system, James reads his own trail);
-- service_role writes. No client writes.
-- ============================================================================

SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS ct_trade_audit (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id              uuid NOT NULL REFERENCES ct_trades(id) ON DELETE CASCADE,
  created_at            timestamptz NOT NULL DEFAULT now(),

  -- Which commit path wrote this row.
  -- Enum-ish: 'claude-trade-open' | 'alert-book-commit' | 'manual' | 'chat'.
  source                text NOT NULL,

  -- Condensed UW / market state snapshot Claude saw at the moment of commit.
  -- Typically the _snapshot field from the latest ct_heartbeats.current_reads
  -- plus a small wrapper with flow / news / theses summaries. Keep it
  -- condensed — the full heartbeat already lives in ct_heartbeats.
  uw_state_snapshot     jsonb,

  -- Array of {tool, input_preview, output_preview, ts} for every MCP call
  -- associated with this decision. For chat/open commits: the calls from the
  -- same turn. For alert commits: best-effort — the watcher's MCP calls from
  -- the 15-min window preceding the alert (those WERE the reasoning).
  mcp_calls             jsonb,

  -- Snapshot of active biases (ct_biases where active=true) at commit time.
  -- Captured even if no bias matched — "the list was empty" is forensic info.
  active_biases         jsonb,

  -- Position-sizing inputs + outputs: risk_pct, shares/contracts, notional,
  -- kelly_pct if the sizer used it, book_equity at decision time.
  sizing_computed       jsonb,

  -- Market regime at decision time — 'pos-gamma' | 'neg-gamma' | 'flip-zone'
  -- plus optional VIX tier. Derived from state.spx_macro.regime when present.
  market_regime         text,

  -- Link to the heartbeat row Claude was fed. Gives reconstructable ground
  -- truth for what the system saw — even if snapshot summaries drift.
  heartbeat_id          uuid,

  -- Optional triggers — null for 9:26 scheduled opens.
  triggering_alert_id   uuid REFERENCES ct_alerts(id) ON DELETE SET NULL,
  triggering_flag_id    uuid REFERENCES ct_flags(id)  ON DELETE SET NULL,

  -- Which prompt version produced this trade. Bump CT_PROMPT_VERSION →
  -- audit trail segments cleanly.
  prompt_version        text,

  -- Raw Claude JSON response. Capped at 20KB by the writers (truncated with
  -- a trailing "…[truncated N bytes]" marker). This is the auditing gold —
  -- if Claude hallucinated a level or misread regime, the raw text shows it.
  raw_claude_response   text
);

-- Hot query: "show me every audit row for this trade, newest first."
CREATE INDEX IF NOT EXISTS ct_trade_audit_trade       ON ct_trade_audit (trade_id);
CREATE INDEX IF NOT EXISTS ct_trade_audit_created     ON ct_trade_audit (created_at DESC);
CREATE INDEX IF NOT EXISTS ct_trade_audit_source      ON ct_trade_audit (source, created_at DESC);

-- RLS: single-user system; authenticated reads everything, service_role writes.
ALTER TABLE ct_trade_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ct_trade_audit_authread ON ct_trade_audit;
CREATE POLICY ct_trade_audit_authread
  ON ct_trade_audit FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS ct_trade_audit_svcall ON ct_trade_audit;
CREATE POLICY ct_trade_audit_svcall
  ON ct_trade_audit FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE  ct_trade_audit                        IS 'Forensic audit trail: one row per trade-decision event. Reconstructable reasoning for every ct_trades row.';
COMMENT ON COLUMN ct_trade_audit.source                 IS 'Commit path: claude-trade-open | alert-book-commit | manual | chat.';
COMMENT ON COLUMN ct_trade_audit.uw_state_snapshot      IS 'Condensed market state at commit time (heartbeat _snapshot + summaries).';
COMMENT ON COLUMN ct_trade_audit.mcp_calls              IS 'Array of {tool, input_preview, output_preview, ts}. Best-effort for alert-sourced trades (15-min window).';
COMMENT ON COLUMN ct_trade_audit.active_biases          IS 'Snapshot of active ct_biases patterns — including empty list.';
COMMENT ON COLUMN ct_trade_audit.sizing_computed        IS 'risk_pct, shares, notional, kelly_pct, book_equity.';
COMMENT ON COLUMN ct_trade_audit.market_regime          IS 'pos-gamma | neg-gamma | flip-zone (+ VIX tier when available).';
COMMENT ON COLUMN ct_trade_audit.heartbeat_id           IS 'Link to ct_heartbeats row Claude was fed. Ground truth for what the system saw.';
COMMENT ON COLUMN ct_trade_audit.triggering_alert_id    IS 'Non-null for alert-book-commit rows; null for scheduled / manual opens.';
COMMENT ON COLUMN ct_trade_audit.triggering_flag_id     IS 'Non-null when a ct_flags row triggered the decision; null otherwise.';
COMMENT ON COLUMN ct_trade_audit.prompt_version         IS 'CT_PROMPT_VERSION at decision time. Lets you segment audit trail across prompt revisions.';
COMMENT ON COLUMN ct_trade_audit.raw_claude_response    IS 'Full raw JSON Claude returned. Capped at 20KB; over-cap rows are truncated with a …[truncated N bytes] marker.';
