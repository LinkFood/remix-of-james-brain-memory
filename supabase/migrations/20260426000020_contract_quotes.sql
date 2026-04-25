-- ct_contract_quotes — append-only time series of per-contract quotes.
--
-- Why this exists (and why it sits next to ct_contract_tracks, not inside it):
--   ct_contract_tracks holds the LATEST snapshot per alert (current_*, peak_*,
--   max_drawdown). Excellent for "which lottery tickets paid?" but throws away
--   the path. The drill chart in Phase D needs the full intraday curve of
--   mid/bid/ask so we can replay how a contract evolved tick-by-tick.
--
--   Append-only by design — every poller sweep writes one row per
--   option_symbol it touched. No updates, no deletes (until a future
--   retention sweep — explicitly deferred for the first week so we can
--   measure growth before deciding the cutoff).
--
-- Tenet 4 (ground-up, no band-aids): contract truth lives in its own table
--   instead of being shoved into ct_contract_tracks as a JSONB blob. Future
--   queries (chart range, % drawdown over rolling N min, signal-to-noise on
--   bid/ask spread) can hit a clean time-series.
-- Tenet 5 (progress independent of P&L): every quote pull writes here even
--   when we suppress the track-level update (penny floor / wide spread).
--   Truth in, decisions out.
-- Tenet 7 (every number tunable): all poller cadence + spread/mid liquidity
--   rails are ct_config keys (seeded below), no hardcoded magic.
--
-- Schema notes
--   - ts = quote timestamp from UW (executed_at on the underlying flow row).
--     Not necessarily the moment we polled — the wrapper returns the most
--     recent print's executed_at. inserted_at = wall-clock for write debug.
--   - source distinguishes flow-latest (poller default), intraday-bar
--     (chart prefill), and historic-eod (for daily close backfills). Phase B
--     only writes 'uw_flow_latest'; the other two are reserved for future
--     producers.
--   - spread_pct mirrors the wrapper's `(ask - bid) / mid` — duplicating
--     here means chart queries don't need to recompute on every read.
--
-- Indexes
--   - (option_symbol, ts DESC) — "latest quote per symbol" hot path.
--   - (ts DESC) — chart range queries by absolute time.

SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS public.ct_contract_quotes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  option_symbol   text NOT NULL,
  ts              timestamptz NOT NULL,
  bid             numeric,
  ask             numeric,
  mid             numeric,
  last            numeric,
  volume          numeric,
  open_interest   numeric,
  iv              numeric,
  spread_pct      numeric,
  source          text NOT NULL DEFAULT 'uw_flow_latest',                  -- 'uw_flow_latest' | 'uw_intraday' | 'uw_historic_eod'
  inserted_at     timestamptz NOT NULL DEFAULT now()
);

-- Hot index for "latest quote per symbol" queries.
CREATE INDEX IF NOT EXISTS ct_contract_quotes_symbol_ts
  ON public.ct_contract_quotes (option_symbol, ts DESC);

-- Time-window queries for charts.
CREATE INDEX IF NOT EXISTS ct_contract_quotes_ts
  ON public.ct_contract_quotes (ts DESC);

ALTER TABLE public.ct_contract_quotes ENABLE ROW LEVEL SECURITY;

CREATE POLICY ct_contract_quotes_authread ON public.ct_contract_quotes
  FOR SELECT TO authenticated USING (true);

CREATE POLICY ct_contract_quotes_svcall ON public.ct_contract_quotes
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ct_contract_quotes IS
  'Append-only time series of per-contract bid/ask/mid/last quotes. Written by ct-contract-poller every sweep (Phase B). Backs the contract drill chart in Phase D. Source distinguishes uw_flow_latest (default), uw_intraday (bar fill), uw_historic_eod (daily close).';

-- ---------------------------------------------------------------------------
-- ct_config seeds — Phase B poller cadence + concurrency rails. ON CONFLICT
-- DO NOTHING so re-runs and operator-edited values are never clobbered.
--
-- Cadence design
--   - High-conviction tracks (low DTE — theta-sensitive) poll every 5 min.
--   - Low-conviction tracks poll every 30 min.
--   - Off-hours mode (the second cron schedule below) relaxes BOTH to 4h to
--     capture the EOD settlement quote without burning UW budget overnight.
--
-- Concurrency
--   - UW caps at 3 concurrent requests; we leave headroom and run at 2.
--   - max_per_run bounds total UW calls per sweep — at 60 unique symbols
--     each cron tick uses ≤60 calls = ≤720/h = far below the 120/min and
--     20k/day budgets.
-- ---------------------------------------------------------------------------
INSERT INTO public.ct_config (key, value, description, category, min_value, max_value, default_value) VALUES
  ('contract_poller_high_conviction_score', '70'::jsonb,
    'Specialist score threshold above which a contract track is polled at the fast cadence. v1 fallback (no specialist join): use dte_at_print<=7 as the high-conviction proxy.',
    'contract_poller', 0, 100, '70'::jsonb),
  ('contract_poller_high_conv_cadence_min', '5'::jsonb,
    'Polling cadence (minutes) for high-conviction contract tracks during RTH.',
    'contract_poller', 1, 240, '5'::jsonb),
  ('contract_poller_low_cadence_min', '30'::jsonb,
    'Polling cadence (minutes) for low-conviction contract tracks during RTH.',
    'contract_poller', 1, 1440, '30'::jsonb),
  ('contract_poller_max_per_run', '60'::jsonb,
    'Hard cap on unique option_symbols polled per cron tick. Bounds UW spend per run.',
    'contract_poller', 1, 500, '60'::jsonb),
  ('contract_poller_uw_concurrency', '2'::jsonb,
    'Concurrent UW requests. UW cap is 3 — leave headroom at 2.',
    'contract_poller', 1, 3, '2'::jsonb),
  ('contract_poller_post_close_cadence_min', '240'::jsonb,
    'Off-hours cadence (minutes). Used by the offhours cron to capture EOD/post-close settlement without burning UW budget overnight.',
    'contract_poller', 30, 1440, '240'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- pg_cron schedules — RTH every 5min, off-hours 4 picks/day. $cron$ outer +
-- $body$ inner, never $$ inside $$ (project gotcha). Re-runnable.
--
-- RTH window: 13:00-20:00 UTC covers 9:00-16:00 ET (the */5 13-20 hour-of-day
-- spec runs minutes 0,5,10,...55 of hours 13,14,...20 — 9:00 ET premarket
-- through 16:00 ET close, weekdays only).
-- ---------------------------------------------------------------------------
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-contract-poller') THEN
    PERFORM cron.unschedule('ct-contract-poller');
  END IF;

  PERFORM cron.schedule(
    'ct-contract-poller',
    '*/5 13-20 * * 1-5',                        -- every 5min during RTH UTC, weekdays
    $body$SELECT public.invoke_edge_function('ct-contract-poller', '{}'::jsonb);$body$
  );
END
$cron$;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-contract-poller-offhours') THEN
    PERFORM cron.unschedule('ct-contract-poller-offhours');
  END IF;

  PERFORM cron.schedule(
    'ct-contract-poller-offhours',
    '0 0,4,8,21 * * *',                         -- 4 picks/day off-RTH (00,04,08,21 UTC)
    $body$SELECT public.invoke_edge_function('ct-contract-poller', '{"mode":"offhours"}'::jsonb);$body$
  );
END
$cron$;
