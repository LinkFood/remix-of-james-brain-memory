-- 20260420000014_news_sentiment.sql
-- Adds structured sentiment scoring to ct_news_analyses so the watcher can
-- treat per-ticker news sentiment as evidence axis E (catalyst) instead of
-- re-reading claude_take prose every cycle.
--
-- Columns:
--   sentiment            — directional read for the ticker specifically.
--                          Distinct from `impact` (legacy bullish/bearish/neutral/mixed)
--                          because `sentiment` is the NET signal after weighing
--                          sector / competitor / catalyst knock-on effects.
--   sentiment_magnitude  — 1..5. 1=tepid, 5=seismic (requires repositioning).
--   sentiment_reasoning  — 1 sentence justification, numbers-first.
--
-- View:
--   ct_news_sentiment_rollup — per ticker per session_date, pos/neg/neutral
--                              counts + net sentiment score (sum of signed
--                              magnitudes). Net < 0 = bearish lean.

ALTER TABLE ct_news_analyses
  ADD COLUMN IF NOT EXISTS sentiment text
    CHECK (sentiment IN ('positive','negative','neutral')),
  ADD COLUMN IF NOT EXISTS sentiment_magnitude int
    CHECK (sentiment_magnitude BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS sentiment_reasoning text;

-- Helpful index for watcher rollup (per ticker, last 24h, where sentiment set)
CREATE INDEX IF NOT EXISTS ct_news_analyses_sentiment_recent_idx
  ON ct_news_analyses (instrument, created_at DESC)
  WHERE sentiment IS NOT NULL;

-- Per-ticker per-session sentiment rollup.
-- session_date bucket uses UTC date of created_at (matches how the rest of
-- the CT tables session-bucket — session_date_utc is how alerts/flags group).
-- Net score = sum of signed magnitudes: positive adds +magnitude, negative
-- adds -magnitude, neutral adds 0. Gives the watcher ONE number per ticker.
CREATE OR REPLACE VIEW ct_news_sentiment_rollup AS
SELECT
  instrument,
  (created_at AT TIME ZONE 'UTC')::date AS session_date,
  COUNT(*) FILTER (WHERE sentiment = 'positive') AS positive_count,
  COUNT(*) FILTER (WHERE sentiment = 'negative') AS negative_count,
  COUNT(*) FILTER (WHERE sentiment = 'neutral')  AS neutral_count,
  COALESCE(SUM(
    CASE sentiment
      WHEN 'positive' THEN  sentiment_magnitude
      WHEN 'negative' THEN -sentiment_magnitude
      ELSE 0
    END
  ), 0) AS net_sentiment_score,
  MAX(created_at) AS last_item_at,
  COUNT(*) AS total_scored
FROM ct_news_analyses
WHERE sentiment IS NOT NULL
  AND sentiment_magnitude IS NOT NULL
GROUP BY instrument, session_date;

COMMENT ON VIEW ct_news_sentiment_rollup IS
  'Per-ticker per-session news sentiment rollup. net_sentiment_score is the sum of signed magnitudes (positive = +magnitude, negative = -magnitude). Watcher uses this as evidence axis E (catalyst).';
