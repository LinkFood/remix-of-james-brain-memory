-- ct_book + ct_trades — Claude's paper trading book.
-- Starts $10k. Daily goal: positive. Stretch: +0.5%/day.
-- No overnight holds v1. Max 3 positions. Max 40% book per position.
-- Underlying instruments only v1 (options sizing/Greeks are Phase 4).
--
-- The honest measurement: after 30 days, does Claude's equity curve
-- beat SPY buy-hold? Binary. No hindsight narration can dodge that.
SET search_path = public, extensions;

-- The running account — one row per session_date
CREATE TABLE IF NOT EXISTS ct_book (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_date        date NOT NULL UNIQUE,
  starting_balance    numeric NOT NULL,
  ending_balance      numeric,                   -- null until EOD close
  realized_pnl        numeric DEFAULT 0,         -- closed-trade P&L for the day
  unrealized_pnl      numeric DEFAULT 0,         -- live open-position P&L
  realized_pnl_pct    numeric GENERATED ALWAYS AS (
                        CASE WHEN starting_balance > 0 THEN (realized_pnl / starting_balance) * 100 ELSE 0 END
                      ) STORED,
  high_water_mark     numeric,                   -- best balance ever seen
  trades_count        int DEFAULT 0,
  wins                int DEFAULT 0,
  losses              int DEFAULT 0,
  max_drawdown_pct    numeric DEFAULT 0,
  daily_recap         text,                      -- Claude's 2-sentence EOD narration
  goal_hit            boolean,                   -- did we close positive?
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ct_book_date ON ct_book (session_date DESC);

-- The individual trades
CREATE TABLE IF NOT EXISTS ct_trades (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_date        date NOT NULL,
  instrument          text NOT NULL,
  side                text NOT NULL CHECK (side IN ('long', 'short')),
  size_pct            numeric NOT NULL CHECK (size_pct > 0 AND size_pct <= 40), -- % of book
  size_usd            numeric NOT NULL,          -- dollar notional at entry
  entry_price         numeric NOT NULL,
  stop_price          numeric,
  target_price        numeric,
  thesis              text NOT NULL,             -- why this trade
  horizon             text,                      -- 'intraday' | 'EOD' | etc
  conviction          int CHECK (conviction BETWEEN 1 AND 5),
  status              text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','open','closed','cancelled')),
  opened_at           timestamptz,
  close_price         numeric,
  closed_at           timestamptz,
  close_reason        text,                      -- 'target_hit' | 'stop_hit' | 'manual_cut' | 'eod_flat' | 'flipped'
  realized_pnl_pct    numeric,                   -- % return on this trade
  realized_pnl_usd    numeric,                   -- dollar P&L
  flag_id             uuid REFERENCES ct_flags(id) ON DELETE SET NULL,
  prompt_version      text DEFAULT 'v1',
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ct_trades_session ON ct_trades (session_date DESC);
CREATE INDEX IF NOT EXISTS ct_trades_status ON ct_trades (status, session_date DESC);
CREATE INDEX IF NOT EXISTS ct_trades_instrument ON ct_trades (instrument, session_date DESC);
CREATE INDEX IF NOT EXISTS ct_trades_open ON ct_trades (status) WHERE status = 'open';

-- Action log — every mgmt decision the book-manager makes on a live trade
CREATE TABLE IF NOT EXISTS ct_trade_actions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id            uuid REFERENCES ct_trades(id) ON DELETE CASCADE,
  action              text NOT NULL,             -- 'hold' | 'cut' | 'scale_in' | 'scale_out' | 'flip'
  price               numeric,
  delta_size_pct      numeric,                   -- +/- on size for scale ops
  rationale           text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ct_trade_actions_trade ON ct_trade_actions (trade_id, created_at);

-- Daily recaps — Claude's EOD narration. Embedded for memory.
CREATE TABLE IF NOT EXISTS ct_daily_recaps (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_date        date NOT NULL UNIQUE,
  recap               text NOT NULL,
  what_worked         text,
  what_didnt          text,
  tomorrow_posture    text,
  pnl_pct             numeric,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE ct_book            ENABLE ROW LEVEL SECURITY;
ALTER TABLE ct_trades          ENABLE ROW LEVEL SECURITY;
ALTER TABLE ct_trade_actions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE ct_daily_recaps    ENABLE ROW LEVEL SECURITY;

CREATE POLICY ct_book_read           ON ct_book          FOR SELECT TO authenticated USING (true);
CREATE POLICY ct_book_svc            ON ct_book          FOR ALL    TO service_role  USING (true) WITH CHECK (true);
CREATE POLICY ct_trades_read         ON ct_trades        FOR SELECT TO authenticated USING (true);
CREATE POLICY ct_trades_svc          ON ct_trades        FOR ALL    TO service_role  USING (true) WITH CHECK (true);
CREATE POLICY ct_trade_actions_read  ON ct_trade_actions FOR SELECT TO authenticated USING (true);
CREATE POLICY ct_trade_actions_svc   ON ct_trade_actions FOR ALL    TO service_role  USING (true) WITH CHECK (true);
CREATE POLICY ct_daily_recaps_read   ON ct_daily_recaps  FOR SELECT TO authenticated USING (true);
CREATE POLICY ct_daily_recaps_svc    ON ct_daily_recaps  FOR ALL    TO service_role  USING (true) WITH CHECK (true);

-- Trigger RPCs
CREATE OR REPLACE FUNCTION public.trigger_ct_claude_trade_open()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
AS $fn$ SELECT public._ct_post('ct-claude-trade-open'); $fn$;

CREATE OR REPLACE FUNCTION public.trigger_ct_book_manager()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
AS $fn$ SELECT public._ct_post('ct-book-manager'); $fn$;

CREATE OR REPLACE FUNCTION public.trigger_ct_book_eod_close()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
AS $fn$ SELECT public._ct_post('ct-book-eod-close'); $fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_claude_trade_open() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.trigger_ct_book_manager()      TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.trigger_ct_book_eod_close()    TO authenticated, service_role;

-- Crons:
--   26 13 * * 1-5           = 9:26 ET weekdays — open today's book + commit trades
--                             (1min after gauntlet so it sees the predictions)
--   */15 14-19 * * 1-5      = every 15min during market hours — book manager
--                             (starts 14:00 UTC = 10 AM ET, not at 13:30 to let
--                              the 9:26 open settle)
--   0 20 * * 1-5            = 4:00 PM ET — EOD close everything + recap
SELECT cron.schedule(
  'ct-claude-trade-open',
  '26 13 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-claude-trade-open',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);

SELECT cron.schedule(
  'ct-book-manager',
  '*/15 14-19 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-book-manager',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);

SELECT cron.schedule(
  'ct-book-eod-close',
  '0 20 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-book-eod-close',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);

-- Seed the book: first session starts $10k. ct-claude-trade-open will
-- insert future sessions with the prior day's ending_balance.
INSERT INTO ct_book (session_date, starting_balance, high_water_mark)
VALUES (CURRENT_DATE, 10000, 10000)
ON CONFLICT (session_date) DO NOTHING;
