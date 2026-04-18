-- ct_config — tunable configuration for Co-Trader.
--
-- Many thresholds across the system (cooldowns, attention-score tiers,
-- cluster triggers, Slack push gates, UW usage tiers, drawdown bands,
-- watcher budgets) are hard-coded. Tuning them today requires code edits
-- and redeploys. This table lets James (or a future admin) tune them from
-- the /ct-settings UI without touching code.
--
-- INTEGRATION CONTRACT (not wired yet — next iteration):
--   Edge functions opt in by calling getConfig(key) from
--   _shared/configCache.ts. Values are cached for 60s per isolate to avoid
--   per-tick DB hits. Changes apply on the NEXT cron tick — no redeploy.
--   Nothing in this migration *reads* this table; the existing hard-coded
--   thresholds keep running. Opt-in happens function-by-function later.
--
-- SCHEMA NOTES:
--   - value, default_value are jsonb so the same table handles numbers,
--     booleans, strings, and eventually nested objects uniformly.
--   - min_value / max_value are numeric and apply to numeric values only.
--     For booleans/strings they are NULL and the UI skips range validation.
--   - category is a flat string used purely for UI grouping.
--   - key is the machine identifier used by getConfig() and must be UNIQUE.
--
SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS ct_config (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key            text NOT NULL UNIQUE,
  value          jsonb NOT NULL,
  description    text,
  category       text NOT NULL,
  min_value      numeric,
  max_value      numeric,
  default_value  jsonb NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ct_config_category_idx ON ct_config (category);

-- Auto-bump updated_at on any value change.
CREATE OR REPLACE FUNCTION public._ct_config_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS ct_config_touch ON ct_config;
CREATE TRIGGER ct_config_touch
  BEFORE UPDATE ON ct_config
  FOR EACH ROW EXECUTE FUNCTION public._ct_config_touch_updated_at();

-- RLS: authenticated read, service_role full.
ALTER TABLE ct_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY ct_config_read ON ct_config
  FOR SELECT TO authenticated USING (true);

CREATE POLICY ct_config_write_auth ON ct_config
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY ct_config_svc ON ct_config
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Helper RPC: single-key lookup returning the value as jsonb.
-- configCache.ts will call this. Returns NULL jsonb if key missing so the
-- caller can fall back to its hard-coded default.
CREATE OR REPLACE FUNCTION public.ct_config_get(p_key text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
  SELECT value FROM public.ct_config WHERE key = p_key;
$fn$;

GRANT EXECUTE ON FUNCTION public.ct_config_get(text) TO authenticated, service_role;

-- Seed defaults. ON CONFLICT DO NOTHING so re-runs are harmless and
-- operator-edited values are never clobbered.
INSERT INTO ct_config (key, value, description, category, min_value, max_value, default_value) VALUES
  -- Cooldown
  ('cooldown.same_direction_min', '30'::jsonb,
    'Minutes to suppress a duplicate same-direction signal on the same ticker.',
    'cooldown', 5, 120, '30'::jsonb),
  ('cooldown.invalidation_min', '60'::jsonb,
    'Minutes before a stale signal is auto-invalidated if no follow-through prints.',
    'cooldown', 15, 180, '60'::jsonb),

  -- Alert commit (paper book entries)
  ('alert_commit.cooldown_min', '60'::jsonb,
    'Minutes to wait before re-committing the same ticker+direction to the paper book.',
    'cooldown', 5, 240, '60'::jsonb),
  ('alert_commit.size_pct', '20'::jsonb,
    'Percent of available book equity committed per alert (paper size).',
    'cooldown', 1, 100, '20'::jsonb),
  ('alert_commit.max_concurrent', '3'::jsonb,
    'Maximum number of concurrent open paper positions.',
    'cooldown', 1, 20, '3'::jsonb),

  -- Scoring
  ('scoring.attention.urgent', '80'::jsonb,
    'Attention score at which a signal is tagged URGENT.',
    'scoring', 50, 100, '80'::jsonb),
  ('scoring.attention.alert', '85'::jsonb,
    'Attention score at which a Slack alert fires (post-URGENT gate).',
    'scoring', 50, 100, '85'::jsonb),
  ('scoring.attention.flag_conv5', '85'::jsonb,
    'Attention score required to flag a 5-min convergence cluster.',
    'scoring', 50, 100, '85'::jsonb),

  -- Clusters — sweeps
  ('clusters.sweep.premium_usd', '500000'::jsonb,
    'Minimum total premium (USD) to count as a sweep cluster.',
    'clusters', 50000, 10000000, '500000'::jsonb),
  ('clusters.sweep.count_min', '3'::jsonb,
    'Minimum number of sweep prints inside the cluster window.',
    'clusters', 2, 20, '3'::jsonb),
  ('clusters.sweep.window_min', '5'::jsonb,
    'Sweep cluster window in minutes.',
    'clusters', 1, 60, '5'::jsonb),

  -- Clusters — dark pool
  ('clusters.dp.notional_usd', '1000000'::jsonb,
    'Minimum total notional (USD) for a dark-pool cluster.',
    'clusters', 100000, 50000000, '1000000'::jsonb),
  ('clusters.dp.count_min', '3'::jsonb,
    'Minimum number of DP prints inside the cluster window.',
    'clusters', 2, 20, '3'::jsonb),
  ('clusters.dp.window_min', '10'::jsonb,
    'Dark-pool cluster window in minutes.',
    'clusters', 1, 120, '10'::jsonb),

  -- Slack
  ('slack.digest.verbose', 'true'::jsonb,
    'Verbose digest: include evidence lines and rationale per alert.',
    'slack', NULL, NULL, 'true'::jsonb),
  ('slack.push.attention_min', '75'::jsonb,
    'Minimum attention score for a live Slack push (below this, digest-only).',
    'slack', 0, 100, '75'::jsonb),

  -- UW usage
  ('usage.warn_pct', '70'::jsonb,
    'UW API usage percent that triggers the warn tier.',
    'usage', 10, 100, '70'::jsonb),
  ('usage.hot_pct', '85'::jsonb,
    'UW API usage percent that triggers the hot tier (throttle reads).',
    'usage', 10, 100, '85'::jsonb),
  ('usage.exhaust_pct', '95'::jsonb,
    'UW API usage percent that triggers the exhaust tier (reads paused).',
    'usage', 10, 100, '95'::jsonb),

  -- Book drawdown
  ('book.drawdown.warn_pct', '-1.0'::jsonb,
    'Intraday P&L percent that triggers a drawdown warn alert (negative = down).',
    'book', -20, 0, '-1.0'::jsonb),
  ('book.drawdown.urgent_pct', '-2.0'::jsonb,
    'Intraday P&L percent that triggers a drawdown urgent alert.',
    'book', -20, 0, '-2.0'::jsonb),
  ('book.drawdown.hwm_urgent_pct', '-3.0'::jsonb,
    'Drawdown from session high-water-mark that triggers an urgent alert.',
    'book', -20, 0, '-3.0'::jsonb),

  -- Watcher
  ('watcher.mcp.budget_per_tick', '1'::jsonb,
    'Maximum number of MCP/research tool calls the watcher may make per tick.',
    'watcher', 0, 20, '1'::jsonb)
ON CONFLICT (key) DO NOTHING;
