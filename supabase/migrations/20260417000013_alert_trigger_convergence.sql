-- Allow 'convergence' as an alert_trigger value. Originally the check
-- constraint only permitted regime_shift | thesis_invalidation | news |
-- vol_event | other. The new deterministic convergence detector fires
-- ALERTs with trigger='convergence' so we need to allow it.
SET search_path = public, extensions;

ALTER TABLE ct_alerts DROP CONSTRAINT IF EXISTS ct_alerts_alert_trigger_check;
ALTER TABLE ct_alerts ADD CONSTRAINT ct_alerts_alert_trigger_check
  CHECK (alert_trigger IN ('regime_shift', 'thesis_invalidation', 'news', 'vol_event', 'convergence', 'other'));
