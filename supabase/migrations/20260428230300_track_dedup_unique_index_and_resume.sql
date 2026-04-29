-- Lock per-symbol identity in. The partial UNIQUE INDEX is the structural
-- commitment per Co-Trader tenet 15 (ground-up, no band-aids): from this
-- moment forward the database itself rejects any attempt to land a second
-- WORKING row for the same option_symbol. The bug class becomes impossible.
--
-- Why partial (only WORKING):
--   Closed/expired tracks are historical ledger rows. Same option_symbol can
--   legitimately appear across many lifetimes — e.g. a contract gets opened,
--   hits +50% WIN, expires, then a NEW print on the same option_symbol
--   (still tradeable up to actual expiry-day) opens a new lifetime track.
--   Partial index lets the new lifetime live alongside the closed one.
--
-- Why we drop the old alert_id UNIQUE:
--   Pre-dedup writer used .upsert(onConflict: 'alert_id'). New writer
--   (ct_upsert_contract_track) keys on option_symbol + WORKING. alert_id is
--   no longer the identity column — it's just a pointer to one of the
--   alerts that fed this track. Keeping the UNIQUE on alert_id would
--   prevent a new lifetime from re-using a closed track's alert_id (it
--   shouldn't, but it's a footgun).
SET search_path = public, extensions;

-- Drop legacy UNIQUE on alert_id (auto-named by Postgres at table creation).
ALTER TABLE public.ct_contract_tracks
  DROP CONSTRAINT IF EXISTS ct_contract_tracks_alert_id_key;

-- Partial UNIQUE INDEX — only WORKING rows must be unique per option_symbol.
CREATE UNIQUE INDEX IF NOT EXISTS ct_contract_tracks_option_symbol_working_uniq
  ON public.ct_contract_tracks (option_symbol)
  WHERE track_status = 'WORKING';

-- Re-create print-grader crons (unscheduled in Phase 1). Same body / cadence
-- as 20260427150000_grader_cron_faster_rth.sql so behavior is identical.
DO $cron$
BEGIN
  PERFORM cron.schedule(
    'ct-print-grader-rth',
    '*/10 13-20 * * 1-5',
    $body$SELECT public.invoke_edge_function('ct-print-grader', '{}'::jsonb);$body$
  );
  PERFORM cron.schedule(
    'ct-print-grader-offhours',
    '0,30 0-12,21-23 * * *',
    $body$SELECT public.invoke_edge_function('ct-print-grader', '{}'::jsonb);$body$
  );
END
$cron$;
