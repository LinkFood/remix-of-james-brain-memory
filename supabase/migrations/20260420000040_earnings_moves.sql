-- =============================================================================
-- 20260420000040_earnings_moves.sql
--
-- ct_earnings_moves — per-ticker historical day-after earnings move cache.
--
-- Populated weekly (Sun 22:15 UTC) by ct-earnings-moves-sync for each
-- watchlist ticker's past 8 reported quarters. One row per (ticker,
-- report_date). Feeds:
--   - EarningsMovesTile (TickerTerminal) — "avg ±4.2%, range +11/-6, 5 beats"
--   - ct-earnings-pre-event-check addendum — calibrated expected_move
--     context for Claude when the 48h/24h/1h watcher fires
--
-- SCHEMA NOTES
--   report_time         text — 'bmo' | 'amc' | 'intraday' | null (mirrors ct_events)
--   pre_earnings_close  numeric — close used as the "before" mark:
--                         - BMO report: close on (report_date - 1 trading day)
--                         - AMC/intraday report: close on report_date
--                         Null when no usable price source had the date.
--   post_earnings_close numeric — close used as the "after" mark:
--                         - BMO report: close on report_date
--                         - AMC/intraday report: close on (report_date + 1
--                           trading day)
--                         Null when no usable price source had the date.
--   move_pct            numeric — (post - pre)/pre * 100. Null when either
--                         price is null.
--   move_direction      text — 'up' | 'down' | 'flat' | null (sign of move_pct)
--   beat_miss           text — 'beat' | 'miss' | 'inline' | null (mirrors
--                         ct_fundamentals_cache.last_earnings_surprise_pct
--                         classification at capture time)
--   surprise_pct        numeric — (actual - est) / |est| * 100 when available
--   reason              text — free-form diagnostic when price is missing
--                         ('no_pre_source' | 'no_post_source' | 'both_missing'
--                         | 'filled'). Makes the thin-history state legible.
--
-- THIN-HISTORY REALITY
--   Price history in this project is sparse today:
--     - ct_spy_daily covers SPY only (one row per weekday, forward-only from
--       ~mid-April 2026)
--     - ct_price_ticks carries 2-min ticks for 14 tickers but retains 7 days
--     - ct_heartbeats.current_reads holds a per-tick JSON of per-ticker
--       prices (however long heartbeats are retained — typically weeks, not
--       quarters)
--   UW exposes no historical-bars endpoint in uwClient.ts. The sync therefore
--   best-effort-fills each row: if any source covers the needed session, the
--   row has prices; otherwise the row is still inserted with NULLs +
--   `reason='no_pre_source'` etc, so the UI can surface "thin history" rather
--   than silently dropping the quarter.
--
--   Expect coverage to grow organically as the project runs — once the ticks
--   pipeline has been online for a full quarter, newer rows will backfill
--   cleanly; older quarters will remain null-price until a true historical
--   bars source is wired up.
--
-- VOLUME
--   12 tickers × 8 quarters = 96 rows upper-bound. Trivial table, no
--   retention policy needed.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- Table
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ct_earnings_moves (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker                text NOT NULL,
  report_date           date NOT NULL,
  report_time           text,
  pre_earnings_close    numeric,
  post_earnings_close   numeric,
  move_pct              numeric,
  move_direction        text CHECK (move_direction IN ('up','down','flat') OR move_direction IS NULL),
  beat_miss             text CHECK (beat_miss IN ('beat','miss','inline') OR beat_miss IS NULL),
  surprise_pct          numeric,
  reason                text,
  captured_at           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ct_earnings_moves_ticker_date
  ON public.ct_earnings_moves (ticker, report_date);

CREATE INDEX IF NOT EXISTS idx_ct_earnings_moves_ticker_date_desc
  ON public.ct_earnings_moves (ticker, report_date DESC);

COMMENT ON TABLE public.ct_earnings_moves IS
  'Per-ticker historical day-after earnings move cache. Populated weekly by ct-earnings-moves-sync from ct_events + thin price sources (ct_spy_daily, ct_price_ticks, ct_heartbeats.current_reads). NULL price columns are expected — historical bars pipeline is sparse.';
COMMENT ON COLUMN public.ct_earnings_moves.pre_earnings_close IS
  'BMO → prior trading day close. AMC/intraday → report_date close. Null if no source covered that session.';
COMMENT ON COLUMN public.ct_earnings_moves.post_earnings_close IS
  'BMO → report_date close. AMC/intraday → next trading day close. Null if no source covered that session.';
COMMENT ON COLUMN public.ct_earnings_moves.reason IS
  'Diagnostic tag: filled | no_pre_source | no_post_source | both_missing | stale_event_time. Lets UI distinguish genuine flat-move from missing data.';

-- -----------------------------------------------------------------------------
-- RLS — authenticated read, service role full (mirrors ct_fundamentals_cache)
-- -----------------------------------------------------------------------------
ALTER TABLE public.ct_earnings_moves ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ct_earnings_moves_read ON public.ct_earnings_moves;
DROP POLICY IF EXISTS ct_earnings_moves_svc  ON public.ct_earnings_moves;

CREATE POLICY ct_earnings_moves_read
  ON public.ct_earnings_moves FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY ct_earnings_moves_svc
  ON public.ct_earnings_moves FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- Cron — Sunday 22:15 UTC (15m after ct-fundamentals-sync so the
-- fundamentals_cache surprise_pct for the most recent quarter is already
-- fresh when this job reads it). Same vault pattern as ct_fundamentals_cron.
-- -----------------------------------------------------------------------------
SELECT cron.schedule(
  'ct-earnings-moves-sync',
  '15 22 * * 0',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-earnings-moves-sync',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);
