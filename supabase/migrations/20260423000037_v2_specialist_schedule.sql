-- =============================================================================
-- 20260423000037_v2_specialist_schedule.sql
--
-- Co-Trader v2 — Phase 3b: wire the 10 specialists to pg_cron.
--
-- Two wakeup paths land here:
--
--   1. HOURLY SAFETY-NET — every specialist fires once per hour during RTH
--      (13-20 UTC Mon-Fri). Staggered at :00, :06, :12 ... :54 so we don't
--      cold-start 10 Deno isolates at the top of the hour. Ensures nobody
--      sleeps through a whole session if the event-driven path misses.
--
--   2. EVENT-DRIVEN DISPATCHER — `ct-specialist-dispatcher` runs every 5 min
--      during RTH, scans ct_scored_flow for HIGH-score events in the last
--      5 min, and fires only the relevant specialists with reason='event_driven'.
--      Cooldown enforced in the edge function (15 min default via ct_config).
--
-- Both paths call `_ct_post_with_body` directly rather than the
-- trigger_ct_specialist_* wrapper RPCs, so this migration has no dependency
-- on Phase 3a having landed its wrappers.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- 1. Hourly safety-net crons, one per ticker, staggered by 6 minutes.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_ticker  TEXT;
  v_idx     INT;
  v_tickers TEXT[] := ARRAY['spy','qqq','iwm','aapl','msft','googl','amzn','meta','nvda','tsla'];
  v_minute  INT;
  v_job     TEXT;
BEGIN
  FOREACH v_ticker IN ARRAY v_tickers LOOP
    v_idx    := array_position(v_tickers, v_ticker);
    v_minute := (v_idx - 1) * 6;          -- :00, :06, :12, :18, :24, :30, :36, :42, :48, :54
    v_job    := 'ct-specialist-' || v_ticker;

    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = v_job) THEN
      PERFORM cron.unschedule(v_job);
    END IF;

    PERFORM cron.schedule(
      v_job,
      format('%s 13-20 * * 1-5', v_minute),
      format(
        $sql$ SELECT public._ct_post_with_body('ct-specialist-%s', jsonb_build_object('reason','scheduled')); $sql$,
        v_ticker
      )
    );
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- 2. Dispatcher cron — every 5 min during RTH.
--    Uses zero-arg _ct_post because the dispatcher derives its own body.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-specialist-dispatcher') THEN
    PERFORM cron.unschedule('ct-specialist-dispatcher');
  END IF;

  PERFORM cron.schedule(
    'ct-specialist-dispatcher',
    '*/5 13-20 * * 1-5',
    $body$ SELECT public._ct_post('ct-specialist-dispatcher'); $body$
  );
END $$;

-- -----------------------------------------------------------------------------
-- 3. Seed dispatcher config keys (tunable via /ct-settings UI).
-- -----------------------------------------------------------------------------
INSERT INTO public.ct_config (key, value, default_value, description, category, min_value, max_value) VALUES
  ('specialist.dispatcher.score_trigger',
    '70'::jsonb,
    '70'::jsonb,
    'Score threshold in ct_scored_flow that triggers a specialist wakeup via the dispatcher.',
    'specialist', 40, 100)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.ct_config (key, value, default_value, description, category, min_value, max_value) VALUES
  ('specialist.dispatcher.lookback_minutes',
    '5'::jsonb,
    '5'::jsonb,
    'How many minutes back the dispatcher scans ct_scored_flow for hot events each tick.',
    'specialist', 1, 30)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.ct_config (key, value, default_value, description, category, min_value, max_value) VALUES
  ('specialist.cooldown_minutes',
    '15'::jsonb,
    '15'::jsonb,
    'Minimum minutes between event-driven wakeups for the same specialist. Scheduled wakeups ignore this.',
    'specialist', 1, 120)
ON CONFLICT (key) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 4. Manual-trigger RPC for the dispatcher — mirrors the ct-* pattern used by
--    /crons "Run now" buttons. Wrapper stays intentionally slim.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trigger_ct_specialist_dispatcher()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
BEGIN
  RETURN public._ct_post('ct-specialist-dispatcher');
END
$fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_specialist_dispatcher() TO authenticated, service_role;
