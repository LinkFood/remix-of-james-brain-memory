-- extended_config_seeds — additional ct_config rows for wave 13 getConfig
-- rollout. Only adds clusters.iv.* thresholds used by ct-iv-shift-watch;
-- everything else from wave 12 is already seeded.
--
-- ON CONFLICT DO NOTHING so reruns are harmless and any operator-edited
-- values already in the table are never clobbered.
--
SET search_path = public, extensions;

INSERT INTO ct_config (key, value, description, category, min_value, max_value, default_value) VALUES
  ('clusters.iv.delta_warn', '10'::jsonb,
    'Minimum absolute IV rank delta (day-over-day) to emit a WARN-tier iv shift (attention 60).',
    'clusters', 1, 100, '10'::jsonb),
  ('clusters.iv.delta_urgent', '20'::jsonb,
    'Absolute IV rank delta that bumps the shift to URGENT (attention 75).',
    'clusters', 1, 100, '20'::jsonb),
  ('clusters.iv.delta_extreme', '30'::jsonb,
    'Absolute IV rank delta that bumps the shift to EXTREME (attention 85).',
    'clusters', 1, 100, '30'::jsonb)
ON CONFLICT (key) DO NOTHING;
