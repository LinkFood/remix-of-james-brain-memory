-- Add chop_neutral regime rule for per-ticker rows with weak momentum.
--
-- Tenet 25: structure evolves via INSERT, not code. Per-ticker rows with
-- momentum in [-0.3, +0.3] previously had no matching rule because:
--   - chop_low_dispersion requires dispersion_max:0.2 (null per-ticker → fail)
--   - chop_high_dispersion requires dispersion_min:0.4 (null per-ticker → fail)
--   - trending/breaking rules need stronger momentum
-- → fell through to `unknown` (P0).
--
-- chop_neutral fills the gap: same momentum band as chop_low_dispersion, no
-- dispersion threshold. Priority 35 — below both chop_dispersion variants
-- (40, 45) so MARKET still routes to the dispersion-aware rules first; only
-- per-ticker rows where dispersion is null reach this fallback.

INSERT INTO public.ct_regime_config (
  classification_name, signal_thresholds, priority, active, description
) VALUES (
  'chop_neutral',
  '{"momentum_max": 0.3, "momentum_min": -0.3}'::jsonb,
  35,
  true,
  'Weak momentum, no dispersion read available (per-ticker rows). Fallback below chop_low/high_dispersion.'
)
ON CONFLICT (classification_name) DO UPDATE SET
  signal_thresholds = EXCLUDED.signal_thresholds,
  priority = EXCLUDED.priority,
  active = EXCLUDED.active,
  description = EXCLUDED.description;
