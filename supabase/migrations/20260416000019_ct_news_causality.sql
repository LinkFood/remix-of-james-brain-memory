-- ============================================================================
-- News → Flow causality tracker
-- For each ct_news_analyses row, measure whether flow/dark-pool activity
-- moved on the same ticker within 15 minutes of the headline.
-- Per-source hit rates become a novel derived signal ("Bloomberg moves NVDA
-- flow 68% of the time, Tradex 12%").
-- ============================================================================
SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS ct_news_causality (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  news_id               uuid NOT NULL REFERENCES ct_news_analyses(id) ON DELETE CASCADE,
  ticker                text NOT NULL,
  news_source           text,
  news_at               timestamptz NOT NULL,
  flow_hits_15min       int DEFAULT 0,
  flow_premium_15min    numeric DEFAULT 0,
  dp_hits_15min         int DEFAULT 0,
  dp_notional_15min     numeric DEFAULT 0,
  moved                 boolean,   -- flow_premium_15min > 0 OR dp_notional_15min >= 10M
  analyzed_at           timestamptz DEFAULT now(),
  UNIQUE (news_id)
);

CREATE INDEX IF NOT EXISTS ct_news_causality_source      ON ct_news_causality (news_source);
CREATE INDEX IF NOT EXISTS ct_news_causality_ticker_time ON ct_news_causality (ticker, news_at DESC);

ALTER TABLE ct_news_causality ENABLE ROW LEVEL SECURITY;

CREATE POLICY ct_news_causality_authread
  ON ct_news_causality FOR SELECT TO authenticated USING (true);

CREATE POLICY ct_news_causality_svcall
  ON ct_news_causality FOR ALL TO service_role USING (true) WITH CHECK (true);
