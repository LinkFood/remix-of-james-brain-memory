-- One-shot validator: runs the exact three-in-one SELECT that the nightly
-- cron executes, so we can confirm the temp-table collision fix works
-- BEFORE waiting for the next 22:40 UTC schedule.
-- Safe to keep or drop after validation.

CREATE OR REPLACE FUNCTION public._test_attribute_cron_body()
RETURNS TABLE (rows_7d INT, rows_14d INT, rows_30d INT)
LANGUAGE sql
AS $$
  SELECT public.ct_attribute_signals(7),
         public.ct_attribute_signals(14),
         public.ct_attribute_signals(30);
$$;

GRANT EXECUTE ON FUNCTION public._test_attribute_cron_body() TO authenticated, service_role;
