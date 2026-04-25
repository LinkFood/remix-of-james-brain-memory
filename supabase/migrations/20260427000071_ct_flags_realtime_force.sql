-- Force-add ct_flags to supabase_realtime publication. The earlier
-- 20260427000070 migration wrapped the ALTER in conditionals; this one runs
-- it unconditionally inside a BEGIN/EXCEPTION so the migration succeeds
-- whether the table is already published or the publication doesn't exist.
DO $body$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.ct_flags;
  EXCEPTION
    WHEN duplicate_object THEN NULL;
    WHEN undefined_object THEN NULL;
  END;
END
$body$;
