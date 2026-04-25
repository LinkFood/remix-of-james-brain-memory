-- Pulse-as-context on every alarm (tenet 9, added 2026-04-25).
--
-- Pulse isn't just a chart — it's a regime state variable. Every alarm row
-- captures Pulse-at-fire-time so the same detector reads differently in
-- different regimes (steady positive slope = ride; sudden flip = fade).
--
-- Three columns added to ct_flags:
--   pulse_net_premium_at_fire — current premium_net when alarm fired (USD)
--   pulse_slope_5min_at_fire  — change in premium_net over last ~5min (USD/min)
--   pulse_regime_at_fire      — classified regime label (text)
--
-- Regime classification lives in _shared/pulseContext.ts; threshold is
-- tunable via ct_config.pulse_regime_trend_threshold.

SET search_path = public, extensions;

ALTER TABLE public.ct_flags
  ADD COLUMN IF NOT EXISTS pulse_net_premium_at_fire NUMERIC,
  ADD COLUMN IF NOT EXISTS pulse_slope_5min_at_fire  NUMERIC,
  ADD COLUMN IF NOT EXISTS pulse_regime_at_fire      TEXT;

-- Filter index — /alarms regime chip queries by this column.
CREATE INDEX IF NOT EXISTS idx_ct_flags_pulse_regime
  ON public.ct_flags (pulse_regime_at_fire);

-- Config seed — every threshold tunable per tenet 16.
-- ct_config.default_value is NOT NULL — pass same as value on first seed.
INSERT INTO public.ct_config (key, value, description, category, default_value) VALUES
  ('pulse_regime_trend_threshold', '100000'::jsonb,
   'Min |slope_5min| in $premium/min to classify Pulse as trending vs chop',
   'pulse', '100000'::jsonb)
ON CONFLICT (key) DO NOTHING;
