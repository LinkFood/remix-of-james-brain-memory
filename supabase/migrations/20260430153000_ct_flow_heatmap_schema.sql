-- =============================================================================
-- 20260430153000_ct_flow_heatmap_schema.sql
--
-- Flow Heatmap snapshot storage. Per-(ticker, expiry_date) rows recording
-- where flow premium is stacking across the future expiry calendar. All
-- four math modes are computed at write time so the frontend can toggle
-- between them without re-aggregation:
--
--   A. total_premium                            — calls + puts (raw $)
--   B. net_signed_premium                       — calls - puts (raw, NOT direction-aware)
--   C. aggressive_directional_premium_raw       — ask-aggressive call $ minus
--                                                  ask-aggressive put $ (via
--                                                  inferDirection — RepeatedHits-
--                                                  on-null-flag rule applies)
--   C'. aggressive_directional_premium_decay    — same as C with exp(-age_days/5)
--                                                  recency weight
--   D. voi_unusual_score                        — Σvolume / ΣOI for the bucket;
--                                                  null if any contributing row
--                                                  has unknown OI
--
-- expiry_bucket_week stores the Friday-of-week containing the expiry. ISO 8601
-- weeks are Mon-Sun, so we offset to Friday explicitly. Combined views
-- aggregate; per-ticker rows are the storage truth.
--
-- contributing_alert_ids preserves provenance (top 50 by premium) so any
-- snapshot row can be drilled back to the raw flow alerts that built it.
-- =============================================================================

SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS ct_flow_heatmap_snapshots (
  id                                         bigserial PRIMARY KEY,
  snapshot_at                                timestamptz NOT NULL DEFAULT now(),
  ticker                                     text NOT NULL,
  expiry_date                                date NOT NULL,
  expiry_bucket_week                         date NOT NULL,
  total_premium                              numeric NOT NULL DEFAULT 0,
  net_signed_premium                         numeric NOT NULL DEFAULT 0,
  aggressive_directional_premium_raw         numeric NOT NULL DEFAULT 0,
  aggressive_directional_premium_decay       numeric NOT NULL DEFAULT 0,
  voi_unusual_score                          numeric,
  contributing_alert_ids                     jsonb NOT NULL DEFAULT '[]'::jsonb,
  top_strikes                                jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_alert_count                         integer NOT NULL DEFAULT 0,
  lookback_hours                             integer NOT NULL,
  is_eod_snapshot                            boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS ct_flow_heatmap_snapshots_ticker_time
  ON ct_flow_heatmap_snapshots (ticker, snapshot_at DESC);

CREATE INDEX IF NOT EXISTS ct_flow_heatmap_snapshots_time_ticker
  ON ct_flow_heatmap_snapshots (snapshot_at DESC, ticker);

CREATE INDEX IF NOT EXISTS ct_flow_heatmap_snapshots_bucket_ticker_time
  ON ct_flow_heatmap_snapshots (expiry_bucket_week, ticker, snapshot_at DESC);

ALTER TABLE ct_flow_heatmap_snapshots ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'ct_flow_heatmap_snapshots'
      AND policyname = 'ct_flow_heatmap_snapshots_svcall'
  ) THEN
    CREATE POLICY ct_flow_heatmap_snapshots_svcall
      ON ct_flow_heatmap_snapshots
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;
