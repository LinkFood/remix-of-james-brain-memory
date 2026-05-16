-- LinkJac / JAC OS decommission -- disable the 3 row-triggers that can
-- invoke a paid API (Claude / edge functions) on INSERT.
--
-- All 3 trigger tables (ct_grades, ct_flags, ct_breaking_news) are
-- JAC / Co-Trader tables -- zero Duck Countdown surface. The triggers are
-- already dormant (their tables are written only by now-unscheduled JAC
-- crons), but disabling them makes a stray manual/UI write unable to wake
-- a paid API.
--
-- REVERSIBLE: ENABLE TRIGGER restores each. Nothing dropped.
SET search_path = public, extensions;

ALTER TABLE public.ct_grades        DISABLE TRIGGER ct_grades_notify_hypothesis_trg;
ALTER TABLE public.ct_flags         DISABLE TRIGGER ct_flags_conviction_tape_reader;
ALTER TABLE public.ct_breaking_news DISABLE TRIGGER ct_breaking_news_sev4_tape_reader;
