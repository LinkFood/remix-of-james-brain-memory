-- Slack-push master toggle for ct-signature-watcher.
-- Default OFF so the next round of detector calibration writes ct_flags +
-- ct_signature_alarm_log without spamming the channel. Flip true via REST
-- once the detector is trusted.
SET search_path = public, extensions;

INSERT INTO public.ct_config (key, value, description, category, default_value) VALUES
  ('signature_alarm_slack_enabled', 'false'::jsonb,
    'Master toggle for ct-signature-watcher Slack pushes. Off during calibration; flip true when detector is trusted.',
    'slack', 'false'::jsonb),
  ('signature_alarm_slack_min_tier', '"gold"'::jsonb,
    'When slack is enabled, only push tiers >= this severity. "gold" / "silver" / "bronze". Bronze rarely worth pinging.',
    'slack', '"gold"'::jsonb)
ON CONFLICT (key) DO NOTHING;
