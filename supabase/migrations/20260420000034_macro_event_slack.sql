-- =============================================================================
-- 20260420000034_macro_event_slack.sql
--
-- Macro-event calendar surface: adds Slack-dedupe column to ct_events, allows
-- 'macro_event_approach' as a ct_watcher_event_triggers source, and partial
-- unique index for per-(event_key, threshold) firing.
--
-- Canonical macro event keys (inferred from ct_events.title on event_type='econ'
-- rows, since the calendar ingester dumps all macro data under event_type='econ'
-- with the specific event name in `title`). Keys used downstream:
--   fomc | cpi | ppi | jobs | employment | gdp | fed_speak | retail_sales
-- See ct_events_macro_view for the mapping.
-- =============================================================================

SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 1) ct_events — last-pushed-at column for hourly Slack-digest dedupe
-- ----------------------------------------------------------------------------
ALTER TABLE ct_events
  ADD COLUMN IF NOT EXISTS last_slack_pushed_at timestamptz;

COMMENT ON COLUMN ct_events.last_slack_pushed_at IS
  'Last time ct-macro-event-slack posted a notification for this event. Hourly cron dedupes via this column — one push per event per calendar day.';

-- Lookup index for the hourly cron "events in next 24h that we have not yet
-- pushed today" query.
CREATE INDEX IF NOT EXISTS idx_ct_events_date_pushed
  ON ct_events (event_date, last_slack_pushed_at)
  WHERE event_type = 'econ';

-- ----------------------------------------------------------------------------
-- 2) ct_watcher_event_triggers — whitelist 'macro_event_approach' source
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
    'earnings_approach',
    'macro_event_approach'
  ));

-- Per-(event_key, event_date, threshold) dedupe. event_key is the canonical
-- macro type from the 7 canonical types. dedupe_key shape:
--   'MACRO:<event_key>:<event_date>:<threshold_hours>'
-- Partial unique index — earnings_approach keeps its own partial index,
-- other sources unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS ux_ct_wet_macro_dedupe
  ON ct_watcher_event_triggers (dedupe_key)
  WHERE source = 'macro_event_approach' AND dedupe_key IS NOT NULL;
