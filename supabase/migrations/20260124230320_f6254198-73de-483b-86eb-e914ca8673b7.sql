-- Create extensions schema if not exists
CREATE SCHEMA IF NOT EXISTS extensions;

-- Grant usage on extensions schema
GRANT USAGE ON SCHEMA extensions TO postgres, anon, authenticated, service_role;

-- Move pgvector extension to dedicated schema (best practice for security)
ALTER EXTENSION vector SET SCHEMA extensions;