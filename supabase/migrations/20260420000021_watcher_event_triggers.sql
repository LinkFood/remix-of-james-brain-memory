-- =============================================================================
-- 20260420000021_watcher_event_triggers.sql
--
-- Audit table for event-driven ct-watcher invocations.
--
-- The scheduled watcher ticks every 15 minutes. For time-critical events
-- (magnitude-5 news, attention-85 sweep/dp clusters, regime inversions) we
-- fire an immediate watcher tick via _shared/watcherDispatch.ts. Every
-- attempt — whether it fired or was debounced/killed — is recorded here.
--
-- Per-source debounce windows (enforced in code, not schema):
--   priority='urgent' → 90 seconds
--   priority='high'   → 180 seconds
-- A news_event within 90s of another news_event is SKIPPED, but a
-- sweep_cluster from the same window can still fire. Non-cumulative.
--
-- Also:
--   - Adds `triggered_by jsonb` to ct_observations, ct_flags, ct_alerts so
--     rows written by ct-watcher during an event-driven cycle carry a
--     pointer back to the audit row that kicked them off.
-- =============================================================================

SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- Audit table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_watcher_event_triggers (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  source                     text NOT NULL CHECK (source IN (
                               'news_event',
                               'sweep_cluster',
                               'dp_cluster',
                               'regime_inversion'
                             )),
  reason                     text NOT NULL,
  priority                   text NOT NULL CHECK (priority IN ('high','urgent')),
  trigger_fired              boolean NOT NULL DEFAULT false,
  skip_reason                text,           -- 'kill_switch' | 'debounced' | 'no_env' | null
  heartbeat_id               uuid,           -- set by ct-watcher once its cycle writes a heartbeat
  ticks_since_last_trigger   int NOT NULL DEFAULT 0
);

COMMENT ON TABLE ct_watcher_event_triggers IS
  'Audit log for every event-driven ct-watcher invocation attempt. Includes fired, debounced, and kill-switch-skipped attempts.';
COMMENT ON COLUMN ct_watcher_event_triggers.source IS
  'Which upstream detector fired: news_event, sweep_cluster, dp_cluster, regime_inversion.';
COMMENT ON COLUMN ct_watcher_event_triggers.trigger_fired IS
  'True if the watcher was actually invoked. False if debounced or kill-switched.';
COMMENT ON COLUMN ct_watcher_event_triggers.skip_reason IS
  'Populated when trigger_fired=false. One of kill_switch, debounced, no_env, insert_failed.';
COMMENT ON COLUMN ct_watcher_event_triggers.ticks_since_last_trigger IS
  'Count of prior event triggers from the same source in the last hour at the time of this attempt.';

CREATE INDEX IF NOT EXISTS idx_ct_wet_created_at
  ON ct_watcher_event_triggers (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ct_wet_source_created
  ON ct_watcher_event_triggers (source, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ct_wet_fired
  ON ct_watcher_event_triggers (trigger_fired, created_at DESC);

ALTER TABLE ct_watcher_event_triggers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ct_watcher_event_triggers_authenticated_read
  ON ct_watcher_event_triggers;
CREATE POLICY ct_watcher_event_triggers_authenticated_read
  ON ct_watcher_event_triggers
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS ct_watcher_event_triggers_service_role_all
  ON ct_watcher_event_triggers;
CREATE POLICY ct_watcher_event_triggers_service_role_all
  ON ct_watcher_event_triggers
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ----------------------------------------------------------------------------
-- triggered_by pointer columns on watcher-written tables
-- Shape: { source: text, reason: text, priority: text, trigger_id: uuid }
-- Nullable — scheduled ticks write nothing there, event-driven ticks populate.
-- ----------------------------------------------------------------------------
ALTER TABLE ct_observations ADD COLUMN IF NOT EXISTS triggered_by jsonb;
ALTER TABLE ct_flags        ADD COLUMN IF NOT EXISTS triggered_by jsonb;
ALTER TABLE ct_alerts       ADD COLUMN IF NOT EXISTS triggered_by jsonb;

COMMENT ON COLUMN ct_observations.triggered_by IS
  'If the tick was event-driven, pointer to ct_watcher_event_triggers + source/priority/reason. Null for scheduled ticks.';
COMMENT ON COLUMN ct_flags.triggered_by IS
  'If the tick was event-driven, pointer to ct_watcher_event_triggers + source/priority/reason. Null for scheduled ticks.';
COMMENT ON COLUMN ct_alerts.triggered_by IS
  'If the tick was event-driven, pointer to ct_watcher_event_triggers + source/priority/reason. Null for scheduled ticks.';
