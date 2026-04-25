-- ct-signature-watcher state + log + thresholds.
--
-- Companion to ct_signature_magnitude_stats RPC (20260426000040). The
-- watcher walks forward through new ct_flow_alerts, computes the signature
-- class (ticker, side, predicted_source, dte_bucket), and fires Slack when
-- the class has historical median peak >= threshold on n >= min_n.
--
-- Two tables:
--   ct_signature_alarm_state — single-row watermark of last processed alert
--   ct_signature_alarm_log   — every alarm we fire (or would have fired but
--                              were deduped by another), for audit + dedupe
--
-- Plus four config thresholds (idempotent INSERTs into ct_config).

SET search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- Watermark — singleton enforced by the id=1 CHECK.
-- Bootstraps to "5 minutes ago" so first run picks up the most recent batch
-- of prints rather than scanning the entire backlog.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ct_signature_alarm_state (
  id                          integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_processed_ingested_at  timestamptz NOT NULL DEFAULT (now() - interval '5 minutes'),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.ct_signature_alarm_state (id) VALUES (1) ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Alarm log — one row per fire (or skip-by-dedupe). Powers the dedupe check
-- (option_symbol within N min) and a future audit UI.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ct_signature_alarm_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id          text NOT NULL,
  option_symbol     text NOT NULL,
  ticker            text NOT NULL,
  signature_class   text NOT NULL,
  median_peak_pct   numeric NOT NULL,
  n                 integer NOT NULL,
  premium           numeric,
  score             numeric,
  slack_ts          text,
  fired_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alarm_log_option_symbol_fired
  ON public.ct_signature_alarm_log (option_symbol, fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_alarm_log_fired_at
  ON public.ct_signature_alarm_log (fired_at DESC);

-- RLS — read for authenticated, full for service_role (matches ct_config pattern)
ALTER TABLE public.ct_signature_alarm_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ct_signature_alarm_log   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ct_sig_alarm_state_read ON public.ct_signature_alarm_state;
CREATE POLICY ct_sig_alarm_state_read ON public.ct_signature_alarm_state
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS ct_sig_alarm_log_read ON public.ct_signature_alarm_log;
CREATE POLICY ct_sig_alarm_log_read ON public.ct_signature_alarm_log
  FOR SELECT TO authenticated USING (true);

-- ---------------------------------------------------------------------------
-- Config thresholds — seed defaults, idempotent.
-- median_peak >= 1.0 (+100%) on n >= 5 in the last 7d signature window,
-- with a 30-min dedupe per option_symbol.
-- ---------------------------------------------------------------------------
INSERT INTO public.ct_config (key, value, description, category, min_value, max_value, default_value) VALUES
  ('signature_alarm_min_peak_pct', '1.0'::jsonb,
    'Min median peak fraction for a signature class to fire a Slack alarm. 1.0 = +100% peak premium.',
    'signature_watcher', 0.0, 10.0, '1.0'::jsonb),
  ('signature_alarm_min_n', '5'::jsonb,
    'Min historical prints in the signature class before it can fire an alarm.',
    'signature_watcher', 1, 1000, '5'::jsonb),
  ('signature_alarm_lookback_days', '7'::jsonb,
    'Lookback window (days) for ct_signature_magnitude_stats when ranking signature classes.',
    'signature_watcher', 1, 90, '7'::jsonb),
  ('signature_alarm_dedupe_min', '30'::jsonb,
    'Suppress duplicate Slack alarms on the same option_symbol within N minutes.',
    'signature_watcher', 1, 1440, '30'::jsonb)
ON CONFLICT (key) DO NOTHING;
