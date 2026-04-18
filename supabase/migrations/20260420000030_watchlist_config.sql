-- 20260420000030_watchlist_config — seed watcher.watchlist into ct_config.
--
-- The 12-ticker watchlist was hard-coded across ~15 edge functions and the
-- uwClient _shared module. Tuning it meant grep-replacing + redeploying every
-- consumer. This migration makes it a tunable ct_config entry so James can
-- swap tickers from /ct-settings without a code push.
--
-- CONTRACT:
--   - key          = 'watcher.watchlist'
--   - value        = jsonb array of uppercase ticker strings, 1..16 entries
--   - category     = 'watcher' (appears in the existing watcher card on
--                    /ct-settings; UI special-cases this key to render a
--                    pill-based ticker editor instead of the default slider)
--   - min/max      = NULL (numeric ranges are not meaningful for arrays;
--                    the UI / edge helper enforce a 1..16 length cap)
--   - default_value = the historical 12-ticker set, so "reset to default"
--                     on the pill editor restores the original list.
--
-- The 16-ticker ceiling is a UW budget discipline: every ticker adds a read
-- to ct-watcher's per-tick state pull plus a news + earnings call per sync.
-- Going beyond 16 risks blowing the UW monthly budget before we notice.
--
-- Edge functions consume this via `getWatchlist(supabase)` from
-- `supabase/functions/_shared/watchlist.ts`, which falls back to the same
-- default list if the config read fails. ON CONFLICT DO NOTHING so re-runs
-- never clobber a hand-edited value.

SET search_path = public, extensions;

INSERT INTO ct_config (key, value, description, category, min_value, max_value, default_value) VALUES
  (
    'watcher.watchlist',
    '["SPY","QQQ","IWM","NVDA","AAPL","MSFT","META","GOOGL","AMZN","TSLA","GLD","USO"]'::jsonb,
    'Tickers Claude watches every tick. Changing this affects watcher, book, alerts, clusters. Max 16 for UW budget discipline.',
    'watcher',
    NULL,
    NULL,
    '["SPY","QQQ","IWM","NVDA","AAPL","MSFT","META","GOOGL","AMZN","TSLA","GLD","USO"]'::jsonb
  )
ON CONFLICT (key) DO NOTHING;
