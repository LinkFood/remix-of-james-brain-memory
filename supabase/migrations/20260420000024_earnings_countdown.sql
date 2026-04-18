-- =============================================================================
-- 20260420000024_earnings_countdown.sql
--
-- Earnings countdown + pre-event watcher pings.
--
-- EXTENDS the existing ct_events table rather than creating a new
-- ct_earnings_calendar — ct_events already carries earnings rows via
-- ct-event-calendar-ingester (pre/afterhours calendars). New columns below
-- are earnings-only; they stay null for fda/econ rows.
--
-- Also extends ct_watcher_event_triggers so the new 'earnings_approach'
-- source is allowed by the CHECK constraint and gets a uniqueness guarantee
-- per (ticker, report_date, threshold_hours) so we never fire the same
-- pre-event ping twice.
-- =============================================================================

SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 1) ct_events — earnings metadata columns (nullable, earnings-only)
-- ----------------------------------------------------------------------------
ALTER TABLE ct_events ADD COLUMN IF NOT EXISTS report_time          text;
ALTER TABLE ct_events ADD COLUMN IF NOT EXISTS eps_estimate         numeric;
ALTER TABLE ct_events ADD COLUMN IF NOT EXISTS prev_actual          numeric;
ALTER TABLE ct_events ADD COLUMN IF NOT EXISTS iv_rank_at_capture   numeric;
ALTER TABLE ct_events ADD COLUMN IF NOT EXISTS updated_at           timestamptz NOT NULL DEFAULT now();

COMMENT ON COLUMN ct_events.report_time IS
  'bmo | amc | intraday — only populated for earnings rows written by ct-earnings-sync.';
COMMENT ON COLUMN ct_events.eps_estimate IS
  'Consensus EPS estimate at time of capture (earnings rows only).';
COMMENT ON COLUMN ct_events.prev_actual IS
  'Prior-period EPS actual at time of capture (earnings rows only).';
COMMENT ON COLUMN ct_events.iv_rank_at_capture IS
  'ct_iv_rank_daily.iv_rank snapshot at the moment ct-earnings-sync wrote the row. Used to track IV ramp leading into earnings.';

-- Per-ticker next-earnings lookup used hourly by ct-earnings-pre-event-check.
CREATE INDEX IF NOT EXISTS idx_ct_events_earnings_ticker_date
  ON ct_events (ticker, event_date)
  WHERE event_type = 'earnings';

-- ----------------------------------------------------------------------------
-- 2) ct_watcher_event_triggers — allow 'earnings_approach' + dedupe key
-- ----------------------------------------------------------------------------
ALTER TABLE ct_watcher_event_triggers
  DROP CONSTRAINT IF EXISTS ct_watcher_event_triggers_source_check;
ALTER TABLE ct_watcher_event_triggers
  ADD CONSTRAINT ct_watcher_event_triggers_source_check
  CHECK (source IN (
    'news_event',
    'sweep_cluster',
    'dp_cluster',
    'regime_inversion',
    'earnings_approach'
  ));

-- dedupe_key is source-specific. For earnings_approach we use
-- '<TICKER>:<report_date>:<threshold_hours>'. Null for every other source
-- (those still use per-source time debouncing in watcherDispatch).
ALTER TABLE ct_watcher_event_triggers
  ADD COLUMN IF NOT EXISTS dedupe_key text;

COMMENT ON COLUMN ct_watcher_event_triggers.dedupe_key IS
  'Optional per-source dedupe hash. Earnings uses TICKER:report_date:threshold_hours to ensure each (ticker, report, 48h/24h/1h) fires exactly once.';

-- One row per (ticker, report_date, threshold) for earnings_approach only.
-- Partial unique index — other sources are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS ux_ct_wet_earnings_dedupe
  ON ct_watcher_event_triggers (dedupe_key)
  WHERE source = 'earnings_approach' AND dedupe_key IS NOT NULL;
