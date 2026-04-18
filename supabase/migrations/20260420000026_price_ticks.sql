-- =============================================================================
-- 20260420000026_price_ticks.sql
--
-- ct_price_ticks — 1-minute-resolution intraday spot prices for watchlist
-- tickers + SPX + VIX. Feeds TickerChartWithAlerts (wave 28) and Monte Carlo
-- actual-vs-projected visualizations that need finer than 15-min heartbeat
-- granularity.
--
-- Capture cadence: EVERY 2 MIN during RTH (not every minute). Math:
--   14 tickers × 30 ticks/hr × 6.5 hr × 5 days = 2,730 UW calls/day
--   = ~13.7% of the 20k/day UW budget.
-- Going to 1-min = 5,460/day = 27% — rejected as too expensive for a
-- single feature. If James wants true 1-min later, flip the cron to
-- `* 13-20 * * 1-5`. (See cron schedule below.)
--
-- Retention: 7 days rolling. Cheap — at 2-min cadence, 14 tickers,
-- ~30 ticks/hr × 6.5hr × 5 days × 7 weeks ≈ 60k rows (peak). pg_cron
-- deletes anything older than 7 days nightly.
--
-- Fallback in the UI: if no tick data exists for a session (first deploy
-- day, or outside RTH), TickerChartWithAlerts falls back to ct_heartbeats
-- prices (15-min resolution) automatically.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- Table
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ct_price_ticks (
  id           bigserial PRIMARY KEY,
  ticker       text        NOT NULL,
  tick_time    timestamptz NOT NULL,
  price        numeric     NOT NULL,
  captured_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ct_price_ticks_ticker_tick_time_unique UNIQUE (ticker, tick_time)
);

COMMENT ON TABLE  public.ct_price_ticks IS
  '2-minute-resolution intraday spot prices. 7-day retention. Populated by ct-price-tick-capture during RTH. Consumed by TickerChartWithAlerts.';
COMMENT ON COLUMN public.ct_price_ticks.tick_time IS
  'Capture-time timestamp rounded to the capture window start. Unique with ticker to prevent cron-retry dupes.';

-- -----------------------------------------------------------------------------
-- Index for "recent ticks for ticker T" lookups (the chart query)
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_ct_price_ticks_ticker_time_desc
  ON public.ct_price_ticks (ticker, tick_time DESC);

-- -----------------------------------------------------------------------------
-- RLS — read-only for authenticated users. service_role bypasses.
-- -----------------------------------------------------------------------------
ALTER TABLE public.ct_price_ticks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ct_price_ticks_select_authed ON public.ct_price_ticks;
CREATE POLICY ct_price_ticks_select_authed
  ON public.ct_price_ticks
  FOR SELECT
  TO authenticated
  USING (true);

-- -----------------------------------------------------------------------------
-- Capture cron — every 2 min, Mon–Fri, 13:00–20:59 UTC (9:00–16:59 ET RTH).
--
-- `*/2 13-20 * * 1-5` fires at :00, :02, :04 ... through the RTH window.
-- Kill switch is respected INSIDE the edge function — cron fires regardless,
-- function skips if active (and writes a kill-switch heartbeat row).
-- -----------------------------------------------------------------------------
SELECT cron.schedule(
  'ct-price-tick-capture',
  '*/2 13-20 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-price-tick-capture',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    )
  $cron$
);

-- -----------------------------------------------------------------------------
-- Retention cron — daily at 06:00 UTC, purge ticks older than 7 days.
--
-- Runs before the US market opens so any deletion pressure lands when no
-- writes are happening. One statement, no edge function needed.
-- -----------------------------------------------------------------------------
SELECT cron.schedule(
  'ct-price-ticks-retention',
  '0 6 * * *',
  $cron$
    DELETE FROM public.ct_price_ticks
    WHERE tick_time < now() - INTERVAL '7 days'
  $cron$
);
