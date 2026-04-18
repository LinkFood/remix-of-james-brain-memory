-- ct_vix_history — daily VIX close history.
--
-- Complements per-ticker ct_iv_rank_daily (which is instrument IV rank) with
-- a single-series macro vol read. VIX tier becomes an independent regime
-- dimension in useRegimeConditionalPerformance (wave 24) — in a stressed-VIX
-- tape, overall regime can differ even when a ticker's own iv_rank is 'mid'.
--
-- Source: UW spot-exposures/strike with fallback to VIXY (1x short-term VIX
-- ETF) when VIX itself returns no price. The `source` column preserves which
-- endpoint actually answered, so consumers can downweight VIXY rows when the
-- raw level isn't comparable to canonical VIX thresholds.
--
-- Forward-only by design (same philosophy as ct_spy_daily) — UW's wrapped
-- endpoints don't expose historical bars. An empty tail for the first ~10
-- trading days is the acceptable trade.
--
-- Tier thresholds live in code (_shared/ctStateCondense.ts::VIX_TIER_THRESHOLDS).
-- The `tier` column is a generated mirror so SQL consumers (slack digest,
-- morning brief) don't need to recompute.
SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- Table
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_vix_history (
  date             date PRIMARY KEY,
  level            numeric NOT NULL,
  prev_close       numeric,
  change_pct       numeric GENERATED ALWAYS AS (
                     CASE
                       WHEN prev_close IS NULL OR prev_close = 0 THEN NULL
                       ELSE (level - prev_close) / prev_close * 100
                     END
                   ) STORED,
  tier             text NOT NULL GENERATED ALWAYS AS (
                     CASE
                       WHEN level < 15 THEN 'low'
                       WHEN level < 25 THEN 'mid'
                       WHEN level < 40 THEN 'elevated'
                       ELSE 'stressed'
                     END
                   ) STORED,
  source           text NOT NULL DEFAULT 'VIX',
  endpoint         text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ct_vix_history_source_ck CHECK (source IN ('VIX', 'VIXY'))
);

CREATE INDEX IF NOT EXISTS ct_vix_history_date_desc ON ct_vix_history (date DESC);

-- -----------------------------------------------------------------------------
-- RLS — authenticated read, service role full. Matches ct_spy_daily.
-- -----------------------------------------------------------------------------
ALTER TABLE ct_vix_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ct_vix_history_read ON ct_vix_history;
DROP POLICY IF EXISTS ct_vix_history_svc  ON ct_vix_history;

CREATE POLICY ct_vix_history_read
  ON ct_vix_history FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY ct_vix_history_svc
  ON ct_vix_history FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- Trigger RPC — same pattern as trigger_ct_spy_capture.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trigger_ct_vix_capture()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-vix-capture'); $fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_vix_capture() TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Cron — 5 minutes after US cash close (21:05 UTC weekdays). Same window as
-- ct-spy-capture so both close-of-day marks land together; ct-watcher reads
-- yesterday's level as the prev_close anchor for next session's change_pct.
-- -----------------------------------------------------------------------------
SELECT cron.schedule(
  'ct-vix-capture',
  '5 21 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-vix-capture',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);
