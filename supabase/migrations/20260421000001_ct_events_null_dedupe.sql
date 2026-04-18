-- =============================================================================
-- Dedupe ct_events across NULL ticker rows (econ + FDA without ticker).
--
-- The original constraint was UNIQUE (event_type, ticker, event_date, title),
-- which Postgres treats as NULLS DISTINCT by default — so the econ calendar
-- (ticker IS NULL for every row) never collides, and each cron run inserts a
-- full duplicate set. Rebuild the unique constraint with NULLS NOT DISTINCT
-- so ON CONFLICT works for NULL-ticker rows too.
--
-- Also strips existing duplicate rows, keeping the oldest (lowest fetched_at).
-- =============================================================================
SET search_path = public, extensions;

-- 1) Collapse existing duplicates. Keep the earliest row per logical key.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY event_type, ticker, event_date, title
           ORDER BY fetched_at ASC, id ASC
         ) AS rn
  FROM ct_events
)
DELETE FROM ct_events
USING ranked
WHERE ct_events.id = ranked.id
  AND ranked.rn > 1;

-- 2) Swap the unique constraint to NULLS NOT DISTINCT.
ALTER TABLE ct_events
  DROP CONSTRAINT IF EXISTS ct_events_event_type_ticker_event_date_title_key;

ALTER TABLE ct_events
  ADD CONSTRAINT ct_events_event_type_ticker_event_date_title_key
  UNIQUE NULLS NOT DISTINCT (event_type, ticker, event_date, title);
