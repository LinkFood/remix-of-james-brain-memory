-- =============================================================================
-- 20260502050000_warden_growth_cron_allow_empty.sql
--
-- Extend ct_growth_crons + check_growth_cron_silent_failures to handle
-- event-driven crons whose target tables are empty by default (e.g.,
-- ct-regime-watch — fires every 5 min RTH but only writes a row on
-- gamma regime flip; can sit at zero rows for weeks during stable regimes).
--
-- The original silent-failure invariant assumed every growth-cron must
-- write rows on cadence (scoreboards, ingest, snapshots). Event-driven
-- crons need slightly different semantics:
--
--   allow_empty = false (default — original behavior):
--     IS NULL → fail immediately. Catches "cron never fired."
--
--   allow_empty = true (new):
--     IS NULL → pass. Empty table is normal state.
--     Rows exist but stale beyond expected_window → fail. Catches
--     "rows used to land but stopped" (the regression case still
--     covered).
--
-- Tenet 25 — structure evolves. The manifest gains a column to express
-- a real semantic distinction the system uncovered.
-- =============================================================================
SET search_path = public, extensions;

ALTER TABLE public.ct_growth_crons
  ADD COLUMN IF NOT EXISTS allow_empty boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.ct_growth_crons.allow_empty IS
  'true for event-driven crons (e.g., ct-regime-watch — writes only on detection event). When true, an empty target table does NOT trip the silent-failure invariant; staleness checks still apply once any row exists.';

-- ----------------------------------------------------------------------------
-- Re-create check_growth_cron_silent_failures with allow_empty awareness.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_growth_cron_silent_failures()
RETURNS TABLE (
  cron_jobname           text,
  target_table           text,
  last_seen_minutes_ago  numeric,
  expected_window_minutes integer,
  scope                  text,
  message                text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  rec        public.ct_growth_crons%ROWTYPE;
  last_at    timestamptz;
  age_min    numeric;
  utc_dow    int;
  utc_hour   int;
  in_window  boolean;
BEGIN
  utc_dow  := EXTRACT(DOW  FROM now() AT TIME ZONE 'UTC')::int;
  utc_hour := EXTRACT(HOUR FROM now() AT TIME ZONE 'UTC')::int;

  FOR rec IN
    SELECT * FROM public.ct_growth_crons WHERE enabled = true
  LOOP
    in_window := CASE rec.scope
      WHEN 'always'  THEN true
      WHEN 'rth'     THEN (utc_dow BETWEEN 1 AND 5) AND (utc_hour BETWEEN 13 AND 20)
      WHEN 'weekday' THEN (utc_dow BETWEEN 1 AND 5)
      WHEN 'daily'   THEN true
      ELSE false
    END;

    IF NOT in_window THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'SELECT MAX(%I) FROM %s',
      rec.freshness_column,
      rec.target_table
    ) INTO last_at;

    IF last_at IS NULL THEN
      -- Empty target table.
      IF rec.allow_empty THEN
        -- Event-driven cron with no event yet — pass.
        CONTINUE;
      END IF;
      cron_jobname            := rec.cron_jobname;
      target_table            := rec.target_table;
      last_seen_minutes_ago   := NULL;
      expected_window_minutes := rec.expected_window_minutes;
      scope                   := rec.scope;
      message                 := format('[%s] no rows in %s yet — cron may have never fired',
                                  rec.cron_jobname, rec.target_table);
      RETURN NEXT;
      CONTINUE;
    END IF;

    age_min := EXTRACT(EPOCH FROM (now() - last_at)) / 60.0;

    IF age_min > (rec.expected_window_minutes + 5) THEN
      cron_jobname            := rec.cron_jobname;
      target_table            := rec.target_table;
      last_seen_minutes_ago   := ROUND(age_min, 1);
      expected_window_minutes := rec.expected_window_minutes;
      scope                   := rec.scope;
      message                 := format('[%s] last %s row %s min ago (expected ≤%s min)',
                                  rec.cron_jobname,
                                  rec.target_table,
                                  ROUND(age_min)::text,
                                  rec.expected_window_minutes::text);
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.check_growth_cron_silent_failures()
  TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Register ct-regime-watch — event-driven, RTH-only cron firing every 5 min,
-- writes ct_regime_inversions rows ONLY on gamma regime flip detection.
-- 30-day window: if rows ever land but then go silent for >30 days during
-- otherwise-active markets, that's a structural failure of either
-- ct_heartbeats source data or the inversion-detection logic.
-- ----------------------------------------------------------------------------
INSERT INTO public.ct_growth_crons
  (cron_jobname, target_table, freshness_column, scope,
   expected_window_minutes, allow_empty, description)
VALUES (
  'ct-regime-watch',
  'public.ct_regime_inversions',
  'created_at',
  'rth',
  43200,    -- 30 days × 24h × 60min — generous: regime flips are sparse but real
  true,     -- event-driven: zero rows is normal during stable regimes
  'Gamma regime inversion detector — RTH every 5 min. Writes ct_regime_inversions row only on dealer gamma regime flip (positive↔negative). Event-driven; allow_empty=true. 30-day staleness threshold catches structural failure where rows used to land but stopped.'
)
ON CONFLICT (cron_jobname) DO UPDATE SET
  target_table             = EXCLUDED.target_table,
  freshness_column         = EXCLUDED.freshness_column,
  scope                    = EXCLUDED.scope,
  expected_window_minutes  = EXCLUDED.expected_window_minutes,
  allow_empty              = EXCLUDED.allow_empty,
  description              = EXCLUDED.description;
