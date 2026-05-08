-- Phase 1.5 — extended-hours spot price coverage via UW spot-exposures.
--
-- Closes the 17.5-hour-off-RTH-blindness gap surfaced by the 2026-05-07
-- substrate audit. Yahoo cron (`ct-price-live-poll *\/2 13-20 * * 1-5`)
-- covers RTH only; from 20:58 UTC Friday through 13:00 UTC Monday +
-- the daily pre-market 8-13 UTC + after-hours 21-00 UTC windows,
-- ct_ticker_snapshots.spot is frozen at last RTH close.
--
-- This migration adds:
--   1. uw_spot / uw_snapshot_at / uw_source labeled columns on
--      ct_ticker_snapshots — new columns alongside existing `spot` so
--      Yahoo and UW writers operate independently (no race, no
--      backwards-compat risk for current consumers).
--   2. ct-uw-spot-poll cron — fires `*\/5 8-12,21-23 * * 1-5` to
--      cover pre-market 8-12:55 UTC + after-hours 21-23:55 UTC. Hands
--      off cleanly to/from Yahoo (Yahoo's first RTH fire is 13:00 UTC,
--      last RTH fire is 20:58 UTC; this cron's last pre-market fire is
--      12:55 UTC, first after-hours fire is 21:00 UTC).
--
-- UW BUDGET PROJECTION
--   96 fires/day × 10 watchlist tickers = 960 calls/day = ~4.8% of
--   20k/day cap. Empirical 7-day weekday baseline (post-2026-05-01) is
--   ~12k/day (60% used), leaving ~8k/day headroom — comfortable.
--
-- NON-DISPLACEMENT
--   Yahoo cron continues unchanged. Both writers update the same row
--   per ticker but on different columns, so no conflict. Consumer
--   migration to read uw_spot is a separate ship (Phase 2A vendor
--   abstraction or per-consumer follow-ups).
--
-- Cross-references:
--   Substrate audit: cowork-cotrader/cotrader_price_integrity_audit.md
--   Engine-room companion: 2026-05-08 runtime verification report
--   _ct_post helper apikey-fix: 20260507160000_apikey_in_ct_post_helpers.sql

SET search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. Schema additions to ct_ticker_snapshots
-- ---------------------------------------------------------------------------

ALTER TABLE public.ct_ticker_snapshots
  ADD COLUMN IF NOT EXISTS uw_spot numeric,
  ADD COLUMN IF NOT EXISTS uw_snapshot_at timestamptz,
  ADD COLUMN IF NOT EXISTS uw_source text;

COMMENT ON COLUMN public.ct_ticker_snapshots.uw_spot IS
  'UW spot-exposures price (extended-hours coverage via ct-uw-spot-poll). Independent of Yahoo-fed `spot` column. Null if last UW poll could not extract a price from the payload.';

COMMENT ON COLUMN public.ct_ticker_snapshots.uw_snapshot_at IS
  'Timestamp of last successful uw_spot write. NULL until first ct-uw-spot-poll fire lands.';

COMMENT ON COLUMN public.ct_ticker_snapshots.uw_source IS
  'Source label for uw_spot — currently always "unusualwhales:spot-exposures/strike". Per organMetadata pattern from Bundle Phase 2 — explicit source label so consumers can attribute.';

-- ---------------------------------------------------------------------------
-- 2. Cron schedule for ct-uw-spot-poll
-- ---------------------------------------------------------------------------
-- Pre-market 8-12:55 UTC (4-8:55 AM ET) + after-hours 21-23:55 UTC (5-7:55 PM ET).
-- Weekdays only. 5-min cadence. Total fires/day = (5 + 3) × 12 = 96.
-- Yahoo handoff: Yahoo's first RTH fire is 13:00 UTC, last is 20:58 UTC;
-- this cron's last pre-market fire is 12:55 UTC, first after-hours fire is 21:00 UTC.
-- No overlap minutes, no race, no double-write concerns.
--
-- Uses _ct_post() helper which sends apikey header per 20260507160000 fix
-- (Supabase gateway rewrites Authorization to ES256 JWT post-key-migration;
-- isServiceRoleRequest checks apikey).

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-uw-spot-poll') THEN
    PERFORM cron.unschedule('ct-uw-spot-poll');
  END IF;
  PERFORM cron.schedule(
    'ct-uw-spot-poll',
    '*/5 8-12,21-23 * * 1-5',
    $body$SELECT public._ct_post('ct-uw-spot-poll');$body$
  );
END
$cron$;
