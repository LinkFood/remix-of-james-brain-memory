-- ============================================================================
-- ct_ui_errors — per-route UI crash log.
--
-- Populated by <RouteBoundary> in the frontend when a component crashes. The
-- boundary catches errors BEFORE they bubble up to the top-level
-- ErrorBoundary, isolating one broken route from the rest of the shell.
--
-- Single-user app, so RLS is simple: authenticated INSERT (user logs their
-- own crashes) and authenticated SELECT + UPDATE (for marking resolved).
-- Service role has full access (edge functions / future auto-triage).
-- ============================================================================

SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS ct_ui_errors (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  route          text NOT NULL,
  error_name     text,
  error_message  text,
  error_stack    text,
  user_agent     text,
  session_id     text,
  resolved       boolean NOT NULL DEFAULT false
);

-- Primary lookup: "give me the most recent unresolved crashes"
CREATE INDEX IF NOT EXISTS ct_ui_errors_created_resolved_idx
  ON ct_ui_errors (created_at DESC, resolved);

ALTER TABLE ct_ui_errors ENABLE ROW LEVEL SECURITY;

-- Single-user: anyone authenticated can log + read + update.
CREATE POLICY ct_ui_errors_insert ON ct_ui_errors
  FOR INSERT TO authenticated
  WITH CHECK (true);

CREATE POLICY ct_ui_errors_read ON ct_ui_errors
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY ct_ui_errors_update ON ct_ui_errors
  FOR UPDATE TO authenticated
  USING (true) WITH CHECK (true);

CREATE POLICY ct_ui_errors_svc ON ct_ui_errors
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON TABLE ct_ui_errors IS
  'Per-route UI crash log populated by <RouteBoundary>. Catches render errors before they bubble to the top-level ErrorBoundary so one broken route does not nuke the shell. resolved=true means the crash has been triaged/fixed.';
