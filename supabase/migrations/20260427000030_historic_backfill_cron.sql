-- ct-historical-quote-backfill — weekend-only cron + supporting unique
-- constraint so the function's upsert(onConflict='option_symbol,ts') works.
--
-- Why weekend-only:
--   /historic costs UW budget. Weekends UW budget is idle. Backfill catches
--   the last 7 days of horizon-aligned quotes so Pass 3 grader can fill in
--   the /tape Horizons column for the past week. By Monday open the dataset
--   is current and live polling takes over without budget contention.
--
-- Belt + suspenders:
--   Cron schedule fires Sat (6) + Sun (0) only. Function ALSO checks
--   getUTCDay() and returns early on weekdays. Either failure mode (cron
--   misconfig OR manual cron addition) is still gated.

SET search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- Unique constraint on (option_symbol, ts) — backs the function's upsert.
-- Enables idempotent re-runs: same horizon resolved twice writes one row.
--
-- Pre-existing rows: deduplicate via DELETE-keep-newest before adding the
-- index (otherwise the unique index creation fails on conflicts).
-- ---------------------------------------------------------------------------
DELETE FROM public.ct_contract_quotes a
USING public.ct_contract_quotes b
WHERE a.id < b.id
  AND a.option_symbol = b.option_symbol
  AND a.ts = b.ts;

CREATE UNIQUE INDEX IF NOT EXISTS ct_contract_quotes_symbol_ts_unique
  ON public.ct_contract_quotes (option_symbol, ts);

-- ---------------------------------------------------------------------------
-- Weekend-only schedule. cron expression: every 30 min on Saturday and Sunday.
-- 0,6 in the day-of-week field = Sun OR Sat. Re-runnable.
-- ---------------------------------------------------------------------------
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-historical-quote-backfill') THEN
    PERFORM cron.unschedule('ct-historical-quote-backfill');
  END IF;

  PERFORM cron.schedule(
    'ct-historical-quote-backfill',
    '*/30 * * * 0,6',
    $body$SELECT public.invoke_edge_function('ct-historical-quote-backfill', '{}'::jsonb);$body$
  );
END
$cron$;
