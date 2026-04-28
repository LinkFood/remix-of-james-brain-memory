-- Kill the off-RTH per-ticker ingester lane.
--
-- Rationale: US options markets are closed outside 9:30-16:00 ET (13:30-20:00 UTC).
-- The off-RTH lane (`*/15 10-12,21-22 * * 1-5`) was designed to catch overnight
-- positioning, but UW returns no new options-flow rows when the underlying market
-- is closed. We were burning ~5% of the daily UW budget (~17 calls × 30 = ~500
-- calls/morning) on empty pulls.
--
-- Keep the RTH per-ticker lane (`*/5 13-20 * * 1-5`) and the market-wide lane
-- (`0,30 13-20 * * 1-5`) — those are the real freshness paths.
--
-- If we ever need pre-market positioning context (futures, dark-pool, news), that
-- lives in different ingesters, not this one.
SET search_path = public, extensions;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-flow-ingester-perticker-offrth') THEN
    PERFORM cron.unschedule('ct-flow-ingester-perticker-offrth');
  END IF;
END
$cron$;
