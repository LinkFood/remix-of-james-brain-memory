-- MCP verification runner cron — every 30 min all day. Captain bridge
-- correctness signal isn't RTH-gated; tools are read-only and queryable
-- 24/7 so verification runs continuously.
--
-- Uses _ct_post() helper (apikey header included per 9ca5af5 fix).

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-mcp-verification-runner') THEN
    PERFORM cron.unschedule('ct-mcp-verification-runner');
  END IF;

  PERFORM cron.schedule(
    'ct-mcp-verification-runner',
    '*/30 * * * *',
    $cron$ SELECT public._ct_post('ct-mcp-verification-runner'); $cron$
  );
END
$migration$;
