-- Helper RPC to find tables without RLS — needed to triage the Supabase
-- security alert. Read-only, idempotent, safe to keep around for audits.

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.list_tables_rls_status()
RETURNS TABLE(table_name TEXT, rls_enabled BOOLEAN)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT
    c.relname::TEXT AS table_name,
    c.relrowsecurity AS rls_enabled
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r'
    AND n.nspname = 'public'
  ORDER BY c.relname;
$$;

GRANT EXECUTE ON FUNCTION public.list_tables_rls_status() TO authenticated, service_role;
