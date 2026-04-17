-- Manual commit should insert as status='planned' so the next book-manager
-- tick (every 15min during market hours) fills the entry at actual fill
-- price — same flow the pre-bell trades use. Prevents null entry_price
-- on open trades that can't be priced.
SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.commit_manual_trade(
  p_instrument     text,
  p_side           text,
  p_size_pct       numeric,
  p_contract_type  text DEFAULT 'underlying',
  p_strike         numeric DEFAULT NULL,
  p_expiry         date DEFAULT NULL,
  p_contracts      int DEFAULT NULL,
  p_entry_premium  numeric DEFAULT NULL,
  p_entry_price    numeric DEFAULT NULL,
  p_stop_price     numeric DEFAULT NULL,
  p_target_price   numeric DEFAULT NULL,
  p_thesis         text DEFAULT NULL,
  p_horizon        text DEFAULT 'intraday',
  p_conviction     int DEFAULT 3
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE
  v_id       uuid;
  v_session  date := CURRENT_DATE;
  v_balance  numeric;
  v_size_usd numeric;
  v_status   text;
BEGIN
  IF p_side NOT IN ('long','short') THEN RAISE EXCEPTION 'side must be long or short'; END IF;
  IF p_contract_type NOT IN ('underlying','call','put') THEN RAISE EXCEPTION 'contract_type must be underlying, call, or put'; END IF;
  IF p_contract_type <> 'underlying' AND (p_strike IS NULL OR p_expiry IS NULL OR p_contracts IS NULL OR p_entry_premium IS NULL) THEN
    RAISE EXCEPTION 'option trades require strike, expiry, contracts, and entry_premium';
  END IF;

  SELECT starting_balance INTO v_balance FROM ct_book WHERE session_date = v_session;
  IF v_balance IS NULL THEN v_balance := 10000; END IF;

  IF p_contract_type = 'underlying' THEN
    v_size_usd := v_balance * (LEAST(40, GREATEST(1, p_size_pct)) / 100);
  ELSE
    v_size_usd := p_contracts * p_entry_premium * 100;
  END IF;

  -- If entry_price provided, open immediately. Otherwise plan and let
  -- book-manager fill on next tick.
  v_status := CASE WHEN p_entry_price IS NOT NULL OR p_contract_type <> 'underlying' THEN 'open' ELSE 'planned' END;

  INSERT INTO ct_trades (
    session_date, instrument, side, size_pct, size_usd,
    contract_type, strike, expiry, contracts, entry_premium,
    entry_price, stop_price, target_price,
    thesis, horizon, conviction, status,
    opened_at, source
  ) VALUES (
    v_session, upper(p_instrument), p_side,
    COALESCE(p_size_pct, 0),
    v_size_usd,
    p_contract_type, p_strike, p_expiry, p_contracts, p_entry_premium,
    p_entry_price, p_stop_price, p_target_price,
    p_thesis, p_horizon, LEAST(5, GREATEST(1, p_conviction)),
    v_status,
    CASE WHEN v_status = 'open' THEN now() ELSE NULL END,
    'james_manual'
  ) RETURNING id INTO v_id;

  INSERT INTO ct_trade_actions (trade_id, action, price, rationale)
  VALUES (v_id, 'manual_open', COALESCE(p_entry_price, p_entry_premium), 'james manual commit: ' || COALESCE(p_thesis, 'no thesis'));

  RETURN v_id;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.commit_manual_trade(text,text,numeric,text,numeric,date,int,numeric,numeric,numeric,numeric,text,text,int) TO authenticated, service_role;
