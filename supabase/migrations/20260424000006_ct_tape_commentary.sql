-- ct_tape_commentary — Claude's running read of the tape.
--
-- ct-tape-reader cron fires every 10min RTH + on high-conviction flag insert
-- (event trigger). Reads last ~10min of scored flow + VIX + market tide,
-- sends to Claude Haiku, writes the paragraph here. /tape shows the latest;
-- /tape-reader shows the full day timeline.
--
-- Also stores the scored_flow_ids the commentary referenced so later we can
-- do reflection: "what did the reader say at 10:30, and what actually happened
-- by 11:30?" — self-improvement loop.
SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS ct_tape_commentary (
  id                  bigserial PRIMARY KEY,
  created_at          timestamptz NOT NULL DEFAULT now(),
  session_date        date NOT NULL DEFAULT (now() AT TIME ZONE 'America/New_York')::date,
  trigger_kind        text NOT NULL CHECK (trigger_kind IN ('scheduled','flag_interrupt','manual')),
  commentary          text NOT NULL,
  flow_ids            bigint[] NOT NULL DEFAULT '{}',
  flag_ids            uuid[]   NOT NULL DEFAULT '{}',
  vix_level           numeric,
  market_tide         text,        -- 'bullish' | 'bearish' | 'flat' | null
  window_start        timestamptz,
  window_end          timestamptz,
  model               text NOT NULL DEFAULT 'claude-haiku-4-5',
  input_tokens        int,
  output_tokens       int,
  cost_usd            numeric(10, 6)
);

CREATE INDEX IF NOT EXISTS idx_ct_tape_commentary_session ON ct_tape_commentary (session_date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ct_tape_commentary_created ON ct_tape_commentary (created_at DESC);

ALTER TABLE ct_tape_commentary ENABLE ROW LEVEL SECURITY;
CREATE POLICY ct_tape_commentary_read ON ct_tape_commentary FOR SELECT TO authenticated USING (true);
CREATE POLICY ct_tape_commentary_svc  ON ct_tape_commentary FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE ct_tape_commentary IS
  'Claude reads the tape every 10min RTH + on conviction flags. One paragraph of context per row. Feeds /tape banner + /tape-reader timeline.';
