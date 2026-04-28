-- Resolve Supabase security alert: ct_detectors had RLS disabled, allowing
-- anon read/write via the publishable key (which is bundled into the Vite
-- frontend, effectively public). No frontend reads ct_detectors — it's
-- backend-only. Lock it down to service_role.
SET search_path = public, extensions;

ALTER TABLE public.ct_detectors ENABLE ROW LEVEL SECURITY;

CREATE POLICY ct_detectors_service_role_all ON public.ct_detectors
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
