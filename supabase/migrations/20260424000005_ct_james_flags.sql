-- ct_james_flags — James's own "this is interesting" signal on the tape.
-- Single-user system, so no user_id column. One row per mark.
--
-- Specialists can read these as context when proposing flags (training signal):
-- "James has flagged 3 NVDA bullish opening_buy prints today → weight that
-- classification pattern higher for NVDA."
SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS ct_james_flags (
  id              bigserial PRIMARY KEY,
  option_symbol   text        NOT NULL,
  ticker          text        NOT NULL,
  source_flow_id  bigint,      -- nullable: matches ct_scored_flow.id if flagged from scored row
  source_alert_id text,        -- nullable: matches ct_flow_alerts.alert_id if flagged from alert row
  direction_view  text         CHECK (direction_view IN ('bullish','bearish','neutral')),
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ct_james_flags_symbol ON ct_james_flags (option_symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ct_james_flags_ticker ON ct_james_flags (ticker, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ct_james_flags_created ON ct_james_flags (created_at DESC);

ALTER TABLE ct_james_flags ENABLE ROW LEVEL SECURITY;
CREATE POLICY ct_james_flags_read ON ct_james_flags FOR SELECT TO authenticated USING (true);
CREATE POLICY ct_james_flags_insert ON ct_james_flags FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY ct_james_flags_update ON ct_james_flags FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY ct_james_flags_delete ON ct_james_flags FOR DELETE TO authenticated USING (true);
CREATE POLICY ct_james_flags_svc ON ct_james_flags FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE ct_james_flags IS
  'James marks prints on /tape as "interesting". Feeds specialists a training signal on what James considers unusual enough to flag by hand.';
