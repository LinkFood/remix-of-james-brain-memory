-- Schedule the watch scheduler to run every 5 minutes
SELECT cron.schedule(
  'jac-watch-scheduler',
  '*/5 * * * *',
  $$SELECT public.invoke_edge_function('jac-watch-scheduler', '{}'::jsonb);$$
);
