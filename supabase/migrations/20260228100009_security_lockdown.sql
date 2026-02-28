-- Security Lockdown: Single-user auth enforcement
-- Blocks all signups except the owner's Google account.
-- Fixes overly permissive RLS policies.

-- ============================================================
-- 1. Email allowlist trigger on auth.users
-- ============================================================
-- This is the strongest defense — even if someone bypasses the
-- frontend, the database itself rejects the signup.

CREATE OR REPLACE FUNCTION public.check_email_allowlist()
RETURNS trigger AS $$
BEGIN
  IF NEW.email NOT IN (
    'jayhillendalepress@gmail.com'
  ) THEN
    RAISE EXCEPTION 'Signup not allowed for this email';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Only fire on INSERT (new signups), not UPDATE (profile changes)
DROP TRIGGER IF EXISTS enforce_email_allowlist ON auth.users;
CREATE TRIGGER enforce_email_allowlist
  BEFORE INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.check_email_allowlist();

-- ============================================================
-- 2. Fix entry_relationships RLS — was USING(true) (universal allow)
-- ============================================================
DROP POLICY IF EXISTS "Service role full access" ON entry_relationships;
CREATE POLICY "Users manage own relationships"
  ON entry_relationships FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- 3. Fix agent_activity_log INSERT — was WITH CHECK(true)
-- ============================================================
DROP POLICY IF EXISTS "Users can create activity logs" ON agent_activity_log;
CREATE POLICY "Users can create own activity logs"
  ON agent_activity_log FOR INSERT
  WITH CHECK (auth.uid() = user_id);
