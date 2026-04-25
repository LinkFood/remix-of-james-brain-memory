-- UW daily-budget tiered guard for ct-contract-poller.
--
-- Today the poller checks uwBudgetOk() per-call and bails completely once
-- exhausted — full polling → zero polling. This adds a tiered restriction so
-- at 70%/90% used we drop low-priority tracks instead of stopping cold:
--   <70%   → unrestricted
--   70-89% → tightened (≤30 DTE, last_quoted older than 30min)
--   90-99% → critical  (≤7  DTE, last_quoted older than 60min)
--   ≥100%  → exhausted (full halt — the existing safety net)
--
-- Thresholds live in ct_config so they can be tuned without redeploying the
-- poller. Tier transitions into critical/exhausted fire ONE Slack alarm per
-- day per tier; first-fire date is tracked in ct_uw_alarm_state.

SET search_path = public, extensions;

INSERT INTO ct_config (key, value, description, category, min_value, max_value, default_value) VALUES
  ('uw_budget_tighten_pct',   '0.70'::jsonb,
    'Tier: tighten poller to <=30 DTE tracks polled less recently than 30min at this fraction of UW daily cap.',
    'uw_budget', 0.10, 0.99, '0.70'::jsonb),
  ('uw_budget_critical_pct',  '0.90'::jsonb,
    'Tier: critical, restrict poller to <=7 DTE tracks polled less recently than 60min.',
    'uw_budget', 0.10, 0.99, '0.90'::jsonb),
  ('uw_budget_exhausted_pct', '1.00'::jsonb,
    'Tier: full halt, log Slack alarm. Default 1.00 means halt only at 100% — match existing uwBudgetOk safety net.',
    'uw_budget', 0.50, 1.00, '1.00'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Single-row state table for one-fire-per-day-per-tier alarm tracking.
CREATE TABLE IF NOT EXISTS public.ct_uw_alarm_state (
  id                          integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_tightened_alarm_date   date,
  last_critical_alarm_date    date,
  last_exhausted_alarm_date   date,
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.ct_uw_alarm_state (id) VALUES (1) ON CONFLICT DO NOTHING;

ALTER TABLE public.ct_uw_alarm_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ct_uw_alarm_state_read ON public.ct_uw_alarm_state;
CREATE POLICY ct_uw_alarm_state_read ON public.ct_uw_alarm_state
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS ct_uw_alarm_state_svc ON public.ct_uw_alarm_state;
CREATE POLICY ct_uw_alarm_state_svc ON public.ct_uw_alarm_state
  FOR ALL TO service_role USING (true) WITH CHECK (true);
