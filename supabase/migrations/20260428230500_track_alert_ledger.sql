-- ct_contract_track_alerts — append-only ledger of every alert_id that has
-- been folded into a ct_contract_tracks row.
--
-- Why this exists:
--   Per-symbol identity (2026-04-28 dedup migration) collapses N rows-per-
--   contract into one. A "re-print" is now a print_count increment instead
--   of a row insert. Each cron pass scans the same recent alerts repeatedly
--   — without an alert-level idempotency record, the same alert_id would
--   increment the counter on every pass. We need print_count to reflect
--   the count of DISTINCT alert_ids that hit this option_symbol, not the
--   number of cron passes that observed it.
--
-- Why not use ct_print_grades or another existing table:
--   ct_print_grades is per-horizon (4 rows per alert in the contract_v1
--   path). Keying off it would either over-count or require complex joins.
--   A purpose-built ledger keyed on alert_id is one row per UW print event
--   — exactly the granularity print_count is summing.
--
-- Backfill strategy:
--   Pre-dedup, every WORKING alert_id had its own row. The dedup migration
--   collapsed them and set print_count = COUNT(*). To replay this in the
--   ledger we'd need the original alert_ids — but the merge step DELETED
--   the non-canonical rows. We don't have them anymore. So the ledger
--   starts empty: any post-2026-04-28 cron pass that sees a re-print of a
--   pre-dedup contract will increment print_count further (effectively
--   double-counting that contract's history). This is acceptable because:
--     1. The signal we care about is RELATIVE — which contracts get hit
--        more, not absolute counts.
--     2. Pre-dedup contracts will eventually expire and be replaced by
--        post-migration contracts whose ledger is clean.
--     3. The structural commitment (one row per option_symbol) is what
--        matters; the counter calibration is a wash.
--   To prevent double-incrementing for alerts seen ONCE per row pre-dedup,
--   we seed the ledger with the canonical row's alert_id.
SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS public.ct_contract_track_alerts (
  alert_id      text PRIMARY KEY,
  option_symbol text NOT NULL,
  track_id      uuid NOT NULL,
  applied_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ct_contract_track_alerts_track_id
  ON public.ct_contract_track_alerts (track_id);

CREATE INDEX IF NOT EXISTS ct_contract_track_alerts_option_symbol
  ON public.ct_contract_track_alerts (option_symbol);

ALTER TABLE public.ct_contract_track_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY ct_contract_track_alerts_authread ON public.ct_contract_track_alerts
  FOR SELECT TO authenticated USING (true);

CREATE POLICY ct_contract_track_alerts_svcall ON public.ct_contract_track_alerts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ct_contract_track_alerts IS
  'Append-only ledger: every alert_id ever folded into a ct_contract_tracks row. Used by ct_upsert_contract_track to keep print_count idempotent across cron passes — without this ledger, scanning the same alert in N cron passes would increment the counter N times. PK on alert_id is the idempotency boundary.';

-- Seed from existing rows: every current ct_contract_tracks row has at
-- least one alert_id (the canonical / first-fired one). Insert it so the
-- next cron pass that sees this alert_id treats it as "already applied".
-- Skip on conflict in case this migration runs twice.
INSERT INTO public.ct_contract_track_alerts (alert_id, option_symbol, track_id, applied_at)
SELECT t.alert_id, t.option_symbol, t.id, t.first_tracked_at
FROM public.ct_contract_tracks t
WHERE t.alert_id IS NOT NULL
ON CONFLICT (alert_id) DO NOTHING;

-- Re-define ct_upsert_contract_track to consult the ledger.
CREATE OR REPLACE FUNCTION public.ct_upsert_contract_track(p_track jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_existing_id    uuid;
  v_option_symbol  text        := p_track->>'option_symbol';
  v_alert_id       text        := p_track->>'alert_id';
  v_print_time     timestamptz := (p_track->>'print_time')::timestamptz;
  v_id             uuid;
  v_already_applied boolean;
BEGIN
  -- Idempotency gate: if this alert_id was already folded into a track,
  -- return that track's id without doing anything. Cron passes that see
  -- the same alert repeatedly become no-ops.
  SELECT track_id INTO v_existing_id
  FROM public.ct_contract_track_alerts
  WHERE alert_id = v_alert_id
  LIMIT 1;
  IF v_existing_id IS NOT NULL THEN
    RETURN v_existing_id;
  END IF;

  -- Look up existing WORKING track for this option_symbol. The Phase 4
  -- partial UNIQUE INDEX guarantees at most one row matches.
  SELECT id INTO v_existing_id
  FROM public.ct_contract_tracks
  WHERE option_symbol = v_option_symbol
    AND track_status = 'WORKING'
  LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    -- Re-print of an existing WORKING contract. Increment counter + bump
    -- last_print_at. Do NOT touch entry_contract_price (first-fired wins),
    -- peak/drawdown (poller's responsibility), or any quote-derived field.
    UPDATE public.ct_contract_tracks
    SET print_count   = print_count + 1,
        last_print_at = GREATEST(COALESCE(last_print_at, print_time), v_print_time)
    WHERE id = v_existing_id;
    INSERT INTO public.ct_contract_track_alerts (alert_id, option_symbol, track_id)
    VALUES (v_alert_id, v_option_symbol, v_existing_id)
    ON CONFLICT (alert_id) DO NOTHING;
    RETURN v_existing_id;
  END IF;

  -- New track. Insert with print_count=1, last_print_at=print_time,
  -- first_alert_id=alert_id.
  INSERT INTO public.ct_contract_tracks (
    alert_id, option_symbol, ticker, side, strike, expiry, dte_at_print,
    print_time, predicted_direction, predicted_source,
    entry_contract_price, entry_source, current_contract_price,
    current_contract_pct, peak_contract_pct, max_drawdown_pct,
    track_status, tracking_until,
    sweep_count, grading_method,
    print_count, last_print_at, first_alert_id
  ) VALUES (
    v_alert_id, v_option_symbol, p_track->>'ticker', p_track->>'side',
    NULLIF(p_track->>'strike','')::numeric,
    NULLIF(p_track->>'expiry','')::date,
    NULLIF(p_track->>'dte_at_print','')::int,
    v_print_time,
    p_track->>'predicted_direction', p_track->>'predicted_source',
    NULLIF(p_track->>'entry_contract_price','')::numeric,
    p_track->>'entry_source',
    NULLIF(p_track->>'current_contract_price','')::numeric,
    NULLIF(p_track->>'current_contract_pct','')::numeric,
    COALESCE(NULLIF(p_track->>'peak_contract_pct','')::numeric, 0),
    COALESCE(NULLIF(p_track->>'max_drawdown_pct','')::numeric, 0),
    COALESCE(p_track->>'track_status', 'WORKING'),
    NULLIF(p_track->>'tracking_until','')::timestamptz,
    COALESCE(NULLIF(p_track->>'sweep_count','')::int, 0),
    COALESCE(p_track->>'grading_method', 'contract_v1'),
    1,
    v_print_time,
    v_alert_id
  )
  RETURNING id INTO v_id;
  INSERT INTO public.ct_contract_track_alerts (alert_id, option_symbol, track_id)
  VALUES (v_alert_id, v_option_symbol, v_id)
  ON CONFLICT (alert_id) DO NOTHING;
  RETURN v_id;
END;
$fn$;
