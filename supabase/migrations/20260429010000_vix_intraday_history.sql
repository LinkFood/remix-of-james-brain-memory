-- ct_vix_history — convert from one-row-per-day to intraday history.
--
-- Problem (2026-04-29):
--   1. (date) PRIMARY KEY → every same-day capture overwrites the prior. We
--      get one row per day, never an intraday curve.
--   2. change_pct + tier are GENERATED STORED — they assume prev_close is the
--      prior session close. Intraday "prev_close" can mean either yesterday's
--      close (for the morning capture) or the prior intraday level (for later
--      ones). Generated columns can't carry that nuance, so we move the math
--      into the edge function.
--
-- Fix: drop date PK, add surrogate bigserial id, replace generated columns
-- with regular columns of the same type, add (date, created_at) unique idx
-- so multiple captures per day are allowed but each capture timestamp is
-- distinct. Existing rows keep their data — backfill recomputes tier from
-- level.
--
-- No row backfill of cadence — this only changes the schema going forward.

SET search_path = public, extensions;

-- 1. Drop the GENERATED columns first (can't ALTER the PK while a generated
--    column references columns we may also touch — and we want them gone
--    regardless so the function can write its own values).
ALTER TABLE ct_vix_history DROP COLUMN IF EXISTS change_pct;
ALTER TABLE ct_vix_history DROP COLUMN IF EXISTS tier;

-- 2. Drop the date PK. Existing rows survive — only the constraint goes.
ALTER TABLE ct_vix_history DROP CONSTRAINT IF EXISTS ct_vix_history_pkey;

-- 3. Add surrogate PK. bigserial fills retroactively for existing rows.
ALTER TABLE ct_vix_history ADD COLUMN IF NOT EXISTS id bigserial;
ALTER TABLE ct_vix_history ADD CONSTRAINT ct_vix_history_pkey PRIMARY KEY (id);

-- 4. Re-add change_pct + tier as regular nullable columns. The edge function
--    populates them at insert time; SQL consumers (quant-card RPC, etc.) read
--    them as before — same column names, same types.
ALTER TABLE ct_vix_history ADD COLUMN IF NOT EXISTS change_pct numeric;
ALTER TABLE ct_vix_history ADD COLUMN IF NOT EXISTS tier text;

-- 5. Backfill tier for existing rows (one-shot SQL UPDATE — not row-data
--    backfill, just recomputing the value the GENERATED column used to hold).
UPDATE ct_vix_history
SET tier = CASE
  WHEN level < 15 THEN 'low'
  WHEN level < 25 THEN 'mid'
  WHEN level < 40 THEN 'elevated'
  ELSE 'stressed'
END
WHERE tier IS NULL AND level IS NOT NULL;

-- Backfill change_pct for existing rows where prev_close is non-null/non-zero.
UPDATE ct_vix_history
SET change_pct = (level - prev_close) / prev_close * 100
WHERE change_pct IS NULL AND prev_close IS NOT NULL AND prev_close <> 0;

-- 6. Make tier NOT NULL going forward (after backfill). Existing nulls would
--    block the constraint — guarded by the UPDATE above, but defensive WHERE
--    still keeps any genuinely-null row alive (level = NULL would be a bug).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ct_vix_history WHERE tier IS NULL) THEN
    ALTER TABLE ct_vix_history ALTER COLUMN tier SET NOT NULL;
  END IF;
END $$;

-- 7. Allow multiple captures per day, distinct by created_at.
CREATE UNIQUE INDEX IF NOT EXISTS ct_vix_history_date_created_at_uq
  ON ct_vix_history (date, created_at);

-- Existing date-DESC index still useful for "latest by day" reads.
-- Add (date DESC, created_at DESC) for "latest intraday tick" reads.
CREATE INDEX IF NOT EXISTS ct_vix_history_date_created_desc
  ON ct_vix_history (date DESC, created_at DESC);

-- -----------------------------------------------------------------------------
-- Cron rewire — replace the 3 sparse captures with */10 RTH cadence + one
-- post-close grab. UW budget delta: 39 weekday RTH fires + 1 nightly = 40/day
-- vs prior 3/day. On a 20k daily budget = 0.20% added burn (negligible).
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  -- Drop the original 21:05 close-of-day cron from the initial migration.
  PERFORM cron.unschedule('ct-vix-capture')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-vix-capture');

  -- Drop the two intraday crons added by 20260423000016_new_ingester_crons.
  PERFORM cron.unschedule('ct-vix-capture-midday')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-vix-capture-midday');
  PERFORM cron.unschedule('ct-vix-capture-late')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-vix-capture-late');

  -- New: every 10 min during US RTH (13:00-20:50 UTC = 9am-4:50pm ET).
  -- 13-20 hour range × 6 fires/hour = up to 48 fires/weekday; 9:00 ET pre-open
  -- prints catch the cash-VIX open within a tick of 9:30.
  PERFORM cron.schedule(
    'ct-vix-capture-rth',
    '*/10 13-20 * * 1-5',
    $body$ SELECT public._ct_post('ct-vix-capture'); $body$
  );

  -- Overnight anchor — 22:00 UTC (6 PM ET) post-close mark for prev_close
  -- continuity into next session.
  PERFORM cron.schedule(
    'ct-vix-capture-eod',
    '0 22 * * 1-5',
    $body$ SELECT public._ct_post('ct-vix-capture'); $body$
  );
END $$;
