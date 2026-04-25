-- 20260427000050_dte_eligibility.sql
-- Per-ticker 0DTE expiry availability config.
--
-- The 10-ticker watchlist has heterogeneous expiry calendars:
--   * SPY/QQQ/IWM       — daily expiry, 0DTE always tradable
--   * NVDA              — weekly Friday expiry only, 0DTE only on Fridays
--   * AAPL/MSFT/GOOGL/AMZN/META/TSLA — weekly minimum, no 0DTE ever
--
-- Without this lookup, signature watcher fires "NVDA 0DTE alarm" on a
-- Wednesday for what's actually a 2-day play, and specialists theorize
-- about 0DTE setups that can't structurally exist. This row gives every
-- consumer a single source of truth.

SET search_path = public, extensions;

INSERT INTO public.ct_config (key, value, description, category, default_value) VALUES
  ('ticker_dte_eligibility',
   '{
      "SPY":   {"daily_0dte": true,  "label": "Daily 0DTE"},
      "QQQ":   {"daily_0dte": true,  "label": "Daily 0DTE"},
      "IWM":   {"daily_0dte": true,  "label": "Daily 0DTE"},
      "NVDA":  {"daily_0dte": false, "weekly_friday_0dte": true, "label": "Friday 0DTE only"},
      "AAPL":  {"daily_0dte": false, "weekly_friday_0dte": false, "label": "Weekly+ only"},
      "MSFT":  {"daily_0dte": false, "weekly_friday_0dte": false, "label": "Weekly+ only"},
      "GOOGL": {"daily_0dte": false, "weekly_friday_0dte": false, "label": "Weekly+ only"},
      "AMZN":  {"daily_0dte": false, "weekly_friday_0dte": false, "label": "Weekly+ only"},
      "META":  {"daily_0dte": false, "weekly_friday_0dte": false, "label": "Weekly+ only"},
      "TSLA":  {"daily_0dte": false, "weekly_friday_0dte": false, "label": "Weekly+ only"}
   }'::jsonb,
   'Per-ticker 0DTE expiry availability — locks down false 0DTE alarms on tickers that do not have daily expiry',
   'watcher',
   '{
      "SPY":   {"daily_0dte": true,  "label": "Daily 0DTE"},
      "QQQ":   {"daily_0dte": true,  "label": "Daily 0DTE"},
      "IWM":   {"daily_0dte": true,  "label": "Daily 0DTE"},
      "NVDA":  {"daily_0dte": false, "weekly_friday_0dte": true, "label": "Friday 0DTE only"},
      "AAPL":  {"daily_0dte": false, "weekly_friday_0dte": false, "label": "Weekly+ only"},
      "MSFT":  {"daily_0dte": false, "weekly_friday_0dte": false, "label": "Weekly+ only"},
      "GOOGL": {"daily_0dte": false, "weekly_friday_0dte": false, "label": "Weekly+ only"},
      "AMZN":  {"daily_0dte": false, "weekly_friday_0dte": false, "label": "Weekly+ only"},
      "META":  {"daily_0dte": false, "weekly_friday_0dte": false, "label": "Weekly+ only"},
      "TSLA":  {"daily_0dte": false, "weekly_friday_0dte": false, "label": "Weekly+ only"}
   }'::jsonb)
ON CONFLICT (key) DO NOTHING;
