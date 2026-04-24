-- Regime context columns for ct_scored_flow.
--
-- Tonight's MFE calibration proved the scorer detects VOLATILITY, not
-- DIRECTION (MFE ≈ MAE across every band, 4300+ events). The missing
-- discriminator: identical flow means different things depending on what
-- the underlying is doing at the time. "Opening-buy puts" when SPY is
-- +0.5% = fade (bearish conviction). Same flow when SPY is flat = hedging.
-- Same flow when SPY is -0.5% = momentum-piling.
--
-- These two columns tag every scored flow event with the regime context
-- at event_ts so Tier 3 scoring can eventually read them. THIS MIGRATION
-- ADDS COLUMNS ONLY. Scorer wiring lives in 20260424000024, and Tier 3
-- weighting lives in a later migration after tonight's calibration run.
--
-- Nullable, no default, no migration-time backfill. Rescore via
-- ct_rescore_flow_since() populates historical rows; new inserts from
-- ct_score_existing_flow populate on write.

SET search_path = public, extensions;

ALTER TABLE public.ct_scored_flow
  ADD COLUMN IF NOT EXISTS spot_pct_from_prev_close NUMERIC,
  ADD COLUMN IF NOT EXISTS spot_pct_from_today_open NUMERIC;

COMMENT ON COLUMN public.ct_scored_flow.spot_pct_from_prev_close IS
  'Percent change of underlying spot at event_ts vs previous trading day close. +0.53 = +0.53%. NULL when bars unavailable (pre-market, gaps).';
COMMENT ON COLUMN public.ct_scored_flow.spot_pct_from_today_open IS
  'Percent change of underlying spot at event_ts vs today''s open. +0.53 = +0.53%. NULL when bars unavailable (pre-market before first bar, gaps).';
