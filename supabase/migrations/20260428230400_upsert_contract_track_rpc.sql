-- ct_upsert_contract_track — the single writer path for ct_contract_tracks.
--
-- Why an RPC and not a plain .upsert():
--   PostgREST .upsert() with onConflict supports either "do nothing" or
--   "replace the whole row". We need "if the option_symbol already has a
--   WORKING track, increment print_count + bump last_print_at; otherwise
--   insert a new track". That's a conditional EXCLUDED.* expression that
--   PostgREST can't express. SECURITY DEFINER + plpgsql gives us the
--   precise semantics with a single round-trip per call.
--
-- Contract:
--   - p_track is the same JSON shape ct-print-grader was building before:
--     { alert_id, option_symbol, ticker, side, strike, expiry, dte_at_print,
--       print_time, predicted_direction, predicted_source,
--       entry_contract_price, entry_source, current_contract_price,
--       current_contract_pct, peak_contract_pct, max_drawdown_pct,
--       track_status, tracking_until, sweep_count, grading_method }
--   - Returns the canonical row's id (UUID) — caller logs success on
--     non-null return. On re-print into an existing WORKING row, returns
--     the EXISTING id (caller can detect "already had a track" by row id
--     not being newly minted, but stats counter naming stays).
SET search_path = public, extensions;

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
BEGIN
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
  RETURN v_id;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.ct_upsert_contract_track(jsonb) TO service_role;

COMMENT ON FUNCTION public.ct_upsert_contract_track(jsonb) IS
  'Single writer path for ct_contract_tracks. On re-print of an existing WORKING track (same option_symbol) increments print_count + bumps last_print_at. Otherwise inserts a new track with print_count=1. Pairs with the partial UNIQUE INDEX ct_contract_tracks_option_symbol_working_uniq and structurally enforces per-symbol identity. Used by ct-print-grader.createMissingContractTracks.';
