-- ============================================================================
-- Config presets — one-click risk profiles for ct_config.
--
-- Tuning 30+ ct_config keys individually is tedious. Hedge funds call these
-- "risk profiles": conservative / moderate / aggressive / paranoid. One
-- click, the whole preset map lands as UPDATEs on ct_config. Existing keys
-- not in the preset map are left untouched (so gate.* stays put if the
-- preset doesn't touch it).
--
-- Keys referenced by a preset that do NOT exist in ct_config are SKIPPED
-- (logged, not an error). Rationale: presets are forward-compatible — a
-- wave-14 key added later should not break wave-12 presets, and vice versa.
--
-- Moderate = the wave-12 seeded defaults (also the `default_value` of every
-- row). "Reset to defaults" is equivalent to applying the moderate preset.
--
-- Atomic: each key is a single UPDATE inside one function call. The outer
-- function runs inside the RPC transaction, so a partial failure rolls back.
-- Concurrent calls (rare: two tabs) are last-write-wins — we do NOT take a
-- table lock. Slack notify and audit log live in the same transaction.
--
-- ct_config_preset_log is append-only audit:
--   { id, preset, applied_at, applied_by (uuid or null for service-role),
--     keys_changed (int), diff_summary (jsonb: [{key, old, new}, ...]) }
-- ============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- Audit log
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_config_preset_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  preset        text NOT NULL,
  applied_at    timestamptz NOT NULL DEFAULT now(),
  applied_by    uuid,
  keys_changed  integer NOT NULL DEFAULT 0,
  keys_skipped  integer NOT NULL DEFAULT 0,
  diff_summary  jsonb NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS ct_config_preset_log_applied_at_idx
  ON ct_config_preset_log (applied_at DESC);

ALTER TABLE ct_config_preset_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY ct_config_preset_log_read ON ct_config_preset_log
  FOR SELECT TO authenticated USING (true);

CREATE POLICY ct_config_preset_log_svc ON ct_config_preset_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE ct_config_preset_log IS
  'Append-only audit of preset applications. diff_summary is an array of {key, old, new} jsonb triples for every row actually changed.';

-- -----------------------------------------------------------------------------
-- Preset map helper — returns the jsonb map for a given preset name.
-- Keeping the maps in SQL (not edge function) so the RPC is self-contained
-- and can be called from anywhere (PSQL, cron, CLI, edge) without drift.
--
-- MODERATE = wave-12 seeded defaults verbatim. If the seed values in
-- 20260419000012_ct_config.sql / 20260419000014_extended_config_seeds.sql /
-- 20260420000007_concentration_config.sql / 20260420000008_pre_trade_gate.sql
-- ever change, update MODERATE here too.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._ct_preset_map(p_preset text)
RETURNS jsonb LANGUAGE sql IMMUTABLE
AS $fn$
  SELECT CASE p_preset
    -- ------------------------------------------------------------------
    -- CONSERVATIVE — tight, few trades. For when you want fewer, higher-
    -- conviction entries and the book is feeling fragile.
    -- ------------------------------------------------------------------
    WHEN 'conservative' THEN jsonb_build_object(
      'cooldown.same_direction_min',          to_jsonb(60),
      'cooldown.invalidation_min',            to_jsonb(120),
      'alert_commit.cooldown_min',            to_jsonb(120),
      'alert_commit.size_pct',                to_jsonb(10),
      'alert_commit.max_concurrent',          to_jsonb(2),
      'concentration.max_ticker_pct',         to_jsonb(20),
      'concentration.max_theme_pct',          to_jsonb(40),
      'concentration.max_direction_pct',      to_jsonb(60),
      'concentration.max_concurrent_options_trades', to_jsonb(1),
      'book.drawdown.warn_pct',               to_jsonb(-0.5),
      'book.drawdown.urgent_pct',             to_jsonb(-1.0),
      'book.drawdown.hwm_urgent_pct',         to_jsonb(-2.0),
      'clusters.sweep.count_min',             to_jsonb(4),
      'clusters.sweep.premium_usd',           to_jsonb(1000000),
      'clusters.sweep.window_min',            to_jsonb(5),
      'clusters.dp.count_min',                to_jsonb(4),
      'clusters.dp.notional_usd',             to_jsonb(2000000),
      'clusters.iv.delta_warn',               to_jsonb(15),
      'clusters.iv.delta_urgent',             to_jsonb(25),
      'clusters.iv.delta_extreme',            to_jsonb(35),
      'scoring.attention.urgent',             to_jsonb(85),
      'scoring.attention.alert',              to_jsonb(90),
      'scoring.attention.flag_conv5',         to_jsonb(90),
      'slack.push.attention_min',             to_jsonb(80),
      'slack.digest.verbose',                 to_jsonb(true),
      'usage.warn_pct',                       to_jsonb(60),
      'usage.hot_pct',                        to_jsonb(80),
      'usage.exhaust_pct',                    to_jsonb(92),
      'watcher.mcp.budget_per_tick',          to_jsonb(1),
      'gate.bias_block_severity',             to_jsonb(3),
      'gate.uw_warn_pct',                     to_jsonb(85),
      'gate.alert_cooldown_min',              to_jsonb(120),
      'gate.session_open_warn_min',           to_jsonb(10),
      'gate.session_close_warn_min',          to_jsonb(20)
    )

    -- ------------------------------------------------------------------
    -- MODERATE — wave-12 seeded defaults. Applying this == full reset.
    -- ------------------------------------------------------------------
    WHEN 'moderate' THEN jsonb_build_object(
      'cooldown.same_direction_min',          to_jsonb(30),
      'cooldown.invalidation_min',            to_jsonb(60),
      'alert_commit.cooldown_min',            to_jsonb(60),
      'alert_commit.size_pct',                to_jsonb(20),
      'alert_commit.max_concurrent',          to_jsonb(3),
      'concentration.max_ticker_pct',         to_jsonb(40),
      'concentration.max_theme_pct',          to_jsonb(60),
      'concentration.max_direction_pct',      to_jsonb(80),
      'concentration.max_concurrent_options_trades', to_jsonb(2),
      'book.drawdown.warn_pct',               to_jsonb(-1.0),
      'book.drawdown.urgent_pct',             to_jsonb(-2.0),
      'book.drawdown.hwm_urgent_pct',         to_jsonb(-3.0),
      'clusters.sweep.count_min',             to_jsonb(3),
      'clusters.sweep.premium_usd',           to_jsonb(500000),
      'clusters.sweep.window_min',            to_jsonb(5),
      'clusters.dp.count_min',                to_jsonb(3),
      'clusters.dp.notional_usd',             to_jsonb(1000000),
      'clusters.dp.window_min',               to_jsonb(10),
      'clusters.iv.delta_warn',               to_jsonb(10),
      'clusters.iv.delta_urgent',             to_jsonb(20),
      'clusters.iv.delta_extreme',            to_jsonb(30),
      'scoring.attention.urgent',             to_jsonb(80),
      'scoring.attention.alert',              to_jsonb(85),
      'scoring.attention.flag_conv5',         to_jsonb(85),
      'slack.push.attention_min',             to_jsonb(75),
      'slack.digest.verbose',                 to_jsonb(true),
      'usage.warn_pct',                       to_jsonb(70),
      'usage.hot_pct',                        to_jsonb(85),
      'usage.exhaust_pct',                    to_jsonb(95),
      'watcher.mcp.budget_per_tick',          to_jsonb(1),
      'gate.bias_block_severity',             to_jsonb(4),
      'gate.uw_warn_pct',                     to_jsonb(90),
      'gate.alert_cooldown_min',              to_jsonb(60),
      'gate.session_open_warn_min',           to_jsonb(5),
      'gate.session_close_warn_min',          to_jsonb(15)
    )

    -- ------------------------------------------------------------------
    -- AGGRESSIVE — more trades, tighter signal latency. Opens the book up.
    -- ------------------------------------------------------------------
    WHEN 'aggressive' THEN jsonb_build_object(
      'cooldown.same_direction_min',          to_jsonb(15),
      'cooldown.invalidation_min',            to_jsonb(30),
      'alert_commit.cooldown_min',            to_jsonb(30),
      'alert_commit.size_pct',                to_jsonb(25),
      'alert_commit.max_concurrent',          to_jsonb(5),
      'concentration.max_ticker_pct',         to_jsonb(50),
      'concentration.max_theme_pct',          to_jsonb(75),
      'concentration.max_direction_pct',      to_jsonb(90),
      'concentration.max_concurrent_options_trades', to_jsonb(3),
      'book.drawdown.warn_pct',               to_jsonb(-2.0),
      'book.drawdown.urgent_pct',             to_jsonb(-4.0),
      'book.drawdown.hwm_urgent_pct',         to_jsonb(-5.0),
      'clusters.sweep.count_min',             to_jsonb(2),
      'clusters.sweep.premium_usd',           to_jsonb(250000),
      'clusters.sweep.window_min',            to_jsonb(5),
      'clusters.dp.count_min',                to_jsonb(2),
      'clusters.dp.notional_usd',             to_jsonb(500000),
      'clusters.iv.delta_warn',               to_jsonb(8),
      'clusters.iv.delta_urgent',             to_jsonb(15),
      'clusters.iv.delta_extreme',            to_jsonb(25),
      'scoring.attention.urgent',             to_jsonb(70),
      'scoring.attention.alert',              to_jsonb(75),
      'scoring.attention.flag_conv5',         to_jsonb(75),
      'slack.push.attention_min',             to_jsonb(60),
      'slack.digest.verbose',                 to_jsonb(true),
      'usage.warn_pct',                       to_jsonb(80),
      'usage.hot_pct',                        to_jsonb(90),
      'usage.exhaust_pct',                    to_jsonb(98),
      'watcher.mcp.budget_per_tick',          to_jsonb(2),
      'gate.bias_block_severity',             to_jsonb(5),
      'gate.uw_warn_pct',                     to_jsonb(95),
      'gate.alert_cooldown_min',              to_jsonb(30),
      'gate.session_open_warn_min',           to_jsonb(3),
      'gate.session_close_warn_min',          to_jsonb(10)
    )

    -- ------------------------------------------------------------------
    -- PARANOID — for volatile days. Conservative, but even tighter.
    -- ------------------------------------------------------------------
    WHEN 'paranoid' THEN jsonb_build_object(
      'cooldown.same_direction_min',          to_jsonb(120),
      'cooldown.invalidation_min',            to_jsonb(180),
      'alert_commit.cooldown_min',            to_jsonb(240),
      'alert_commit.size_pct',                to_jsonb(5),
      'alert_commit.max_concurrent',          to_jsonb(1),
      'concentration.max_ticker_pct',         to_jsonb(10),
      'concentration.max_theme_pct',          to_jsonb(25),
      'concentration.max_direction_pct',      to_jsonb(40),
      'concentration.max_concurrent_options_trades', to_jsonb(0),
      'book.drawdown.warn_pct',               to_jsonb(-0.3),
      'book.drawdown.urgent_pct',             to_jsonb(-0.75),
      'book.drawdown.hwm_urgent_pct',         to_jsonb(-1.5),
      'clusters.sweep.count_min',             to_jsonb(5),
      'clusters.sweep.premium_usd',           to_jsonb(2000000),
      'clusters.sweep.window_min',            to_jsonb(5),
      'clusters.dp.count_min',                to_jsonb(5),
      'clusters.dp.notional_usd',             to_jsonb(3000000),
      'clusters.iv.delta_warn',               to_jsonb(20),
      'clusters.iv.delta_urgent',             to_jsonb(30),
      'clusters.iv.delta_extreme',            to_jsonb(40),
      'scoring.attention.urgent',             to_jsonb(90),
      'scoring.attention.alert',              to_jsonb(95),
      'scoring.attention.flag_conv5',         to_jsonb(95),
      'slack.push.attention_min',             to_jsonb(90),
      'slack.digest.verbose',                 to_jsonb(true),
      'usage.warn_pct',                       to_jsonb(50),
      'usage.hot_pct',                        to_jsonb(70),
      'usage.exhaust_pct',                    to_jsonb(85),
      'watcher.mcp.budget_per_tick',          to_jsonb(0),
      'gate.bias_block_severity',             to_jsonb(2),
      'gate.uw_warn_pct',                     to_jsonb(75),
      'gate.alert_cooldown_min',              to_jsonb(240),
      'gate.session_open_warn_min',           to_jsonb(15),
      'gate.session_close_warn_min',          to_jsonb(30)
    )

    -- 'default' aliases to 'moderate' (wave-12 seeded values)
    WHEN 'default' THEN public._ct_preset_map('moderate')

    ELSE NULL
  END;
$fn$;

-- -----------------------------------------------------------------------------
-- Dry-run helper — returns the diff between current ct_config and a preset
-- WITHOUT applying anything. Used by the UI to show a preview before
-- confirming. Shape: [{ key, current, next, action: 'change'|'skip'|'noop' }].
-- 'skip' = preset references a key missing from ct_config.
-- 'noop' = key exists and is already at the preset value.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.preview_config_preset(p_preset text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  preset_map jsonb;
  result     jsonb := '[]'::jsonb;
  k          text;
  v_next     jsonb;
  v_current  jsonb;
  existed    boolean;
BEGIN
  preset_map := public._ct_preset_map(p_preset);
  IF preset_map IS NULL THEN
    RAISE EXCEPTION 'Unknown preset: %', p_preset
      USING HINT = 'Valid presets: conservative, moderate, aggressive, paranoid, default';
  END IF;

  FOR k, v_next IN SELECT * FROM jsonb_each(preset_map) LOOP
    SELECT value, true INTO v_current, existed FROM ct_config WHERE key = k;
    IF NOT FOUND THEN
      result := result || jsonb_build_array(jsonb_build_object(
        'key', k,
        'current', NULL,
        'next', v_next,
        'action', 'skip'
      ));
    ELSIF v_current IS DISTINCT FROM v_next THEN
      result := result || jsonb_build_array(jsonb_build_object(
        'key', k,
        'current', v_current,
        'next', v_next,
        'action', 'change'
      ));
    ELSE
      result := result || jsonb_build_array(jsonb_build_object(
        'key', k,
        'current', v_current,
        'next', v_next,
        'action', 'noop'
      ));
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'preset', p_preset,
    'entries', result
  );
END
$fn$;

GRANT EXECUTE ON FUNCTION public.preview_config_preset(text) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- The main event — apply a preset atomically.
--
-- Behavior:
--   - Validates preset name; unknown = exception.
--   - For each key in the preset map:
--       * If the key exists in ct_config AND value differs, UPDATE and record
--         a diff entry.
--       * If the key exists and value matches, SKIP (no write, no diff entry
--         — keeps the log clean).
--       * If the key does NOT exist, SKIP and bump keys_skipped.
--   - Inserts one ct_config_preset_log row with diff_summary + counts.
--   - Returns { preset, keys_changed, keys_skipped, log_id, diff_summary }.
--
-- Concurrency: last-write-wins. No table lock. Two simultaneous applies will
-- both run; the later UPDATE wins on each key. Both get audit rows.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_config_preset(
  p_preset     text,
  p_applied_by uuid DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  preset_map    jsonb;
  diff          jsonb := '[]'::jsonb;
  changed       integer := 0;
  skipped       integer := 0;
  k             text;
  v_next        jsonb;
  v_current     jsonb;
  log_id        uuid;
BEGIN
  preset_map := public._ct_preset_map(p_preset);
  IF preset_map IS NULL THEN
    RAISE EXCEPTION 'Unknown preset: %', p_preset
      USING HINT = 'Valid presets: conservative, moderate, aggressive, paranoid, default';
  END IF;

  FOR k, v_next IN SELECT * FROM jsonb_each(preset_map) LOOP
    SELECT value INTO v_current FROM ct_config WHERE key = k;

    IF NOT FOUND THEN
      -- Key in preset but not seeded — skip, don't error.
      skipped := skipped + 1;
      CONTINUE;
    END IF;

    IF v_current IS DISTINCT FROM v_next THEN
      UPDATE ct_config SET value = v_next WHERE key = k;
      diff := diff || jsonb_build_array(jsonb_build_object(
        'key', k,
        'old', v_current,
        'new', v_next
      ));
      changed := changed + 1;
    END IF;
  END LOOP;

  INSERT INTO ct_config_preset_log (preset, applied_by, keys_changed, keys_skipped, diff_summary)
  VALUES (p_preset, p_applied_by, changed, skipped, diff)
  RETURNING id INTO log_id;

  RETURN jsonb_build_object(
    'preset',        p_preset,
    'log_id',        log_id,
    'keys_changed',  changed,
    'keys_skipped',  skipped,
    'diff_summary',  diff
  );
END
$fn$;

GRANT EXECUTE ON FUNCTION public.apply_config_preset(text, uuid) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Current-preset detection helper — scans the log for the most recent
-- application. Returns { preset, applied_at, applied_by, keys_changed } or
-- NULL if no presets have ever been applied.
--
-- The UI uses this to render "current preset: moderate · applied 3h ago".
-- If the user hand-edits individual keys after applying a preset, we surface
-- that as "custom (drifted from <preset>)" — the drift detection is done
-- client-side by re-running preview_config_preset and checking keys_changed.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.current_config_preset()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
  SELECT jsonb_build_object(
    'preset',        preset,
    'applied_at',    applied_at,
    'applied_by',    applied_by,
    'keys_changed',  keys_changed,
    'keys_skipped',  keys_skipped,
    'log_id',        id
  )
  FROM ct_config_preset_log
  ORDER BY applied_at DESC
  LIMIT 1;
$fn$;

GRANT EXECUTE ON FUNCTION public.current_config_preset() TO authenticated, service_role;
