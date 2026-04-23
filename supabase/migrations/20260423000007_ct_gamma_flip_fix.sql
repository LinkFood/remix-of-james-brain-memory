-- Fix: build_ticker_quant_card's gamma_flip CTE uses ORDER BY abs(net_gex) ASC
-- to approximate the flip strike. Fails on thin OTM strikes with near-zero
-- net_gex — returned SPY gamma_flip=85 when spot=710. Structural hallucination
-- feeding Claude bogus levels.
--
-- True gamma flip = strike where net_gex changes sign between adjacent strikes,
-- preferably the one closest to spot. Falls back to the old min(|net_gex|) when
-- no sign change is detected (rare, but possible in fully-negative chains).
--
-- Implementation: new helper ct_compute_gamma_flip() with correct logic, plus
-- a decorator on build_ticker_quant_card that replaces the buggy value in the
-- returned JSON. This avoids restating the 580-line quant-card function body.

SET search_path = public, extensions;

-- ============================================================================
-- Helper: compute gamma flip via sign-change detection
-- ============================================================================

CREATE OR REPLACE FUNCTION public.ct_compute_gamma_flip(
  p_ticker TEXT,
  p_as_of  TIMESTAMPTZ DEFAULT now()
) RETURNS NUMERIC
LANGUAGE sql STABLE
AS $$
  WITH latest AS (
    SELECT max(snapshot_at) AS snap_at
    FROM public.ct_gex_timeseries
    WHERE ticker = upper(trim(p_ticker))
      AND snapshot_at <= p_as_of
      AND snapshot_at >= p_as_of - interval '24 hours'
  ),
  gex_rows AS (
    SELECT g.strike, g.net_gex, g.call_gex, g.put_gex, g.underlying_price
    FROM public.ct_gex_timeseries g, latest l
    WHERE g.ticker = upper(trim(p_ticker))
      AND g.snapshot_at = l.snap_at
  ),
  spot_r AS (
    SELECT underlying_price AS spot FROM gex_rows
    WHERE underlying_price IS NOT NULL LIMIT 1
  ),
  meaningful AS (
    -- Drop thin strikes (near-zero activity) so the sign-change scan isn't
    -- pulled to the OTM tails.
    SELECT strike, net_gex
    FROM gex_rows
    WHERE net_gex IS NOT NULL
      AND (abs(coalesce(call_gex, 0)) + abs(coalesce(put_gex, 0))) > 0
  ),
  ordered AS (
    SELECT strike, net_gex,
           LAG(net_gex)  OVER (ORDER BY strike) AS prev_net_gex,
           LAG(strike)   OVER (ORDER BY strike) AS prev_strike
    FROM meaningful
  ),
  crossings AS (
    SELECT
      -- Interpolate the zero-crossing between prev_strike and strike
      CASE
        WHEN (net_gex - prev_net_gex) <> 0
          THEN prev_strike - prev_net_gex * (strike - prev_strike) / (net_gex - prev_net_gex)
        ELSE (prev_strike + strike) / 2.0
      END AS flip_strike
    FROM ordered
    WHERE prev_net_gex IS NOT NULL
      AND sign(net_gex) <> sign(prev_net_gex)
      AND sign(net_gex) <> 0 AND sign(prev_net_gex) <> 0  -- both non-zero
  )
  SELECT COALESCE(
    -- Prefer the crossing nearest to spot
    (SELECT round(flip_strike::numeric, 2)
     FROM crossings, spot_r
     ORDER BY abs(flip_strike - spot_r.spot) ASC NULLS LAST
     LIMIT 1),
    -- Fallback: among MEANINGFUL strikes near spot, pick min|net_gex|
    (SELECT strike
     FROM meaningful, spot_r
     WHERE abs(strike - spot_r.spot) <= spot_r.spot * 0.10  -- within 10% of spot
     ORDER BY abs(net_gex) ASC NULLS LAST
     LIMIT 1),
    -- Last-resort fallback: the old logic (may still be wrong but matches prior behavior)
    (SELECT strike FROM meaningful
     ORDER BY abs(net_gex) ASC NULLS LAST LIMIT 1)
  );
$$;

GRANT EXECUTE ON FUNCTION public.ct_compute_gamma_flip(TEXT, TIMESTAMPTZ)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.ct_compute_gamma_flip IS
  'Correct gamma flip via sign-change + interpolation, filtered to meaningful strikes. Replaces build_ticker_quant_card''s buggy min(|net_gex|) logic.';

-- ============================================================================
-- Decorator: rename current build_ticker_quant_card → _orig, wrap with fix
-- ============================================================================

DO $$
BEGIN
  -- Only rename if the _orig version doesn't already exist (idempotent).
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'build_ticker_quant_card_orig'
  ) THEN
    ALTER FUNCTION public.build_ticker_quant_card(TEXT, TIMESTAMPTZ)
      RENAME TO build_ticker_quant_card_orig;
  END IF;
END $$;

-- New public wrapper: call _orig, patch gamma_flip in the returned JSON.
CREATE OR REPLACE FUNCTION public.build_ticker_quant_card(
  p_ticker TEXT,
  p_as_of  TIMESTAMPTZ DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_result jsonb;
  v_flip   numeric;
BEGIN
  v_result := public.build_ticker_quant_card_orig(p_ticker, p_as_of);
  v_flip   := public.ct_compute_gamma_flip(p_ticker, p_as_of);

  IF v_flip IS NOT NULL AND v_result IS NOT NULL THEN
    -- Patch both the root-level alias (legacy callers) and the nested path.
    IF v_result ? 'gamma_flip' THEN
      v_result := jsonb_set(v_result, '{gamma_flip}', to_jsonb(v_flip), false);
    END IF;
    IF v_result ? 'structural' AND (v_result->'structural') ? 'gamma_flip' THEN
      v_result := jsonb_set(v_result, '{structural,gamma_flip}', to_jsonb(v_flip), false);
    END IF;
  END IF;

  RETURN v_result;
END $$;

GRANT EXECUTE ON FUNCTION public.build_ticker_quant_card(TEXT, TIMESTAMPTZ)
  TO authenticated, service_role;
