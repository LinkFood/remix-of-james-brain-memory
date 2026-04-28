-- =============================================================================
-- 20260428223000 — Drop the global-min last-resort fallback in
-- ct_compute_gamma_flip.
--
-- Problem (caught 2026-04-28):
--   NVDA snapshot returned gamma_flip = 1.5 (with spot ~$213).
--   QQQ snapshot returned gamma_flip = 451 (with spot ~$658).
--   Both are far-OTM tail strikes, not gamma flips.
--
-- Cause:
--   The previous helper (from 20260423000007) had three COALESCE branches:
--     1. Sign-change scan within meaningful strikes (correct primary)
--     2. Min |net_gex| within ±10% of spot (correct secondary fallback)
--     3. Min |net_gex| across ALL strikes (BROKEN last-resort — picks
--        near-zero far-OTM tails on sparse gex chains)
--   When (1) and (2) both miss, branch (3) silently returns garbage that
--   feeds the structural view + Claude specialists as a "real" level.
--
-- Fix:
--   Drop branch (3) entirely. Keep (1) and (2). Return NULL when both
--   fail — callers already handle null gamma_flip (it's a documented
--   return value), and a missing level is far better than a fabricated one.
--
-- Tenets honored:
--   13 — structural prevention beats validators (NULL is structural truth)
--   15 — class-of-failure fix, not patch the instance
-- =============================================================================

SET search_path = public, extensions;

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
    -- Primary: the crossing nearest to spot
    (SELECT round(flip_strike::numeric, 2)
     FROM crossings, spot_r
     ORDER BY abs(flip_strike - spot_r.spot) ASC NULLS LAST
     LIMIT 1),
    -- Secondary fallback: among MEANINGFUL strikes within ±10% of spot,
    -- pick min |net_gex|. Keeps us anchored to the underlying.
    (SELECT strike
     FROM meaningful, spot_r
     WHERE abs(strike - spot_r.spot) <= spot_r.spot * 0.10
     ORDER BY abs(net_gex) ASC NULLS LAST
     LIMIT 1)
    -- NOTE: the global min-|net_gex| last-resort fallback was removed
    -- 2026-04-28. NULL is the correct return when no near-spot flip
    -- exists; a far-OTM tail strike is structural lying.
  );
$$;

GRANT EXECUTE ON FUNCTION public.ct_compute_gamma_flip(TEXT, TIMESTAMPTZ)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.ct_compute_gamma_flip IS
  'Gamma flip via sign-change + interpolation, filtered to meaningful strikes near spot. Returns NULL when no flip exists in the meaningful window — better than fabricating a far-OTM tail strike. Updated 2026-04-28 to drop global-min last-resort.';
