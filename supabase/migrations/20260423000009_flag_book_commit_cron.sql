-- Schedule ct-flag-book-commit every 15 min during RTH (14:00-20:00 UTC
-- = 10am-4pm ET). Paired with ct-watcher's */15 cadence so a fresh FLAG
-- can convert to an exploratory trade within the same 15-min window.
--
-- Also seed the three config keys ct-flag-book-commit reads.

-- Config seeds were applied via REST upsert at migration time — keeping
-- this migration focused on the cron schedule. Seeded values:
--   flag_commit.size_pct = 5
--   flag_commit.cooldown_min = 15
--   flag_commit.max_concurrent = 5

-- Trigger RPC wrapper
CREATE OR REPLACE FUNCTION public.trigger_ct_flag_book_commit()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
AS $fn$ SELECT public._ct_post('ct-flag-book-commit'); $fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_flag_book_commit() TO authenticated, service_role;

-- Cron: every 15 min during RTH weekdays
DO $$
BEGIN
  PERFORM cron.unschedule('ct-flag-book-commit')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-flag-book-commit');

  PERFORM cron.schedule(
    'ct-flag-book-commit',
    '*/15 14-20 * * 1-5',
    $body$ SELECT public.trigger_ct_flag_book_commit(); $body$
  );
END $$;
