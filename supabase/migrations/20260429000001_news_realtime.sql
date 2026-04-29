-- Add ct_breaking_news + ct_news_analyses to supabase_realtime publication so
-- the /tape NewsFeed sidebar receives live INSERT events. Wrapped in
-- exception-trapped DO blocks so re-runs succeed regardless of current state
-- (matches the pattern used for ct_flags realtime in 20260427000071).
--
-- Per `feedback_supabase_realtime_publication_caveat` memory: ALTER
-- PUBLICATION can succeed without immediately starting delivery for newly
-- added tables. The hook covers that with a bootstrap fetch + 60s
-- refetchInterval floor; realtime is the optimization, not the floor.
DO $body$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.ct_breaking_news;
  EXCEPTION
    WHEN duplicate_object THEN NULL;
    WHEN undefined_object THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.ct_news_analyses;
  EXCEPTION
    WHEN duplicate_object THEN NULL;
    WHEN undefined_object THEN NULL;
  END;
END
$body$;
