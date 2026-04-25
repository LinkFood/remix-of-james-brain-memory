-- Tiered alarm thresholds for ct-signature-watcher.
--
-- Replaces the single-threshold model (signature_alarm_min_peak_pct +
-- signature_alarm_min_n) with a three-tier system that combines BOTH the
-- forward-looking flow scorer (ct_scored_flow.score) AND the backward-looking
-- signature class history (ct_signature_magnitude_stats.median_peak_pct).
--
--   Gold   = both layers strong         → Slack push (priority) + ct_flags row
--   Silver = combined high-confidence   → Slack push (standard) + ct_flags row
--            OR signature-alone exceptional
--   Bronze = either layer alone clears  → ct_flags row only (no Slack)
--            a lower bar
--
-- Old keys (signature_alarm_min_peak_pct / signature_alarm_min_n) stay in
-- place — may be referenced by other tooling — but the watcher reads the
-- new tiered keys instead.

-- Mirror existing signature_alarm rows' shape: category + min/max/default
-- columns are required (NOT NULL on category specifically).
INSERT INTO public.ct_config (key, value, description, category, min_value, max_value, default_value) VALUES
  ('signature_alarm_gold_min_score',          '80'::jsonb,
    'Gold tier requires ct_scored_flow.score >= this',
    'signature_watcher', 0, 100, '80'::jsonb),
  ('signature_alarm_gold_min_peak_pct',       '1.0'::jsonb,
    'Gold tier requires signature class median peak >= this fraction (1.0 = +100%)',
    'signature_watcher', 0.0, 10.0, '1.0'::jsonb),
  ('signature_alarm_gold_min_n',              '10'::jsonb,
    'Gold tier minimum n in signature class',
    'signature_watcher', 1, 1000, '10'::jsonb),
  ('signature_alarm_silver_min_score',        '70'::jsonb,
    'Silver tier combined score floor',
    'signature_watcher', 0, 100, '70'::jsonb),
  ('signature_alarm_silver_min_peak_pct',     '0.50'::jsonb,
    'Silver tier combined signature median floor',
    'signature_watcher', 0.0, 10.0, '0.50'::jsonb),
  ('signature_alarm_silver_min_n',            '5'::jsonb,
    'Silver tier combined signature n floor',
    'signature_watcher', 1, 1000, '5'::jsonb),
  ('signature_alarm_silver_high_sig_peak_pct','2.0'::jsonb,
    'Silver tier signature-alone exceptional floor (+200%)',
    'signature_watcher', 0.0, 10.0, '2.0'::jsonb),
  ('signature_alarm_silver_high_sig_min_n',   '10'::jsonb,
    'Silver tier signature-alone n floor',
    'signature_watcher', 1, 1000, '10'::jsonb),
  ('signature_alarm_bronze_min_peak_pct',     '0.50'::jsonb,
    'Bronze tier signature floor — UI glow only, no Slack',
    'signature_watcher', 0.0, 10.0, '0.50'::jsonb),
  ('signature_alarm_bronze_min_n',            '3'::jsonb,
    'Bronze tier signature n floor',
    'signature_watcher', 1, 1000, '3'::jsonb),
  ('signature_alarm_bronze_min_score',        '80'::jsonb,
    'Bronze tier score-alone floor when signature is weak',
    'signature_watcher', 0, 100, '80'::jsonb)
ON CONFLICT (key) DO NOTHING;
