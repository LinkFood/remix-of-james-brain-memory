-- ============================================================================
-- ct_events — earnings / FDA / econ calendar ingest
-- One table, three event types. Deduped by (event_type, ticker, event_date, title).
-- ============================================================================
SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS ct_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type   text NOT NULL CHECK (event_type IN ('earnings','fda','econ')),
  ticker       text,                                         -- null for econ-wide events
  event_date   date NOT NULL,
  event_time   timetz,                                       -- null if date-only
  title        text,
  importance   int,                                          -- econ impact/severity 1-3, null otherwise
  raw          jsonb,
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_type, ticker, event_date, title)
);

CREATE INDEX IF NOT EXISTS ct_events_type_date ON ct_events (event_type, event_date);
CREATE INDEX IF NOT EXISTS ct_events_ticker_date ON ct_events (ticker, event_date);

-- RLS — matches pattern in 20260416000007_ct_flow_tables.sql
ALTER TABLE ct_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (true)', 'ct_events_authread', 'ct_events');
  EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)', 'ct_events_svcall', 'ct_events');
END $$;
