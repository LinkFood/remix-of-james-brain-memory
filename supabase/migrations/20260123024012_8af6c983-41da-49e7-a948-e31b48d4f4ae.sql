-- Drop deprecated tables from the old multi-provider chat architecture
-- These tables are no longer used after the Brain Dump pivot

DROP TABLE IF EXISTS messages CASCADE;
DROP TABLE IF EXISTS conversations CASCADE;
DROP TABLE IF EXISTS user_api_keys CASCADE;

-- Enable realtime on entries table for live updates
ALTER PUBLICATION supabase_realtime ADD TABLE public.entries;