-- Reset flags marked status='graded' that have no corresponding ct_flag_grades
-- row (orphans from the corrupt-grade wipe). They'll be re-graded by the next
-- grader cron run with the correct contract-axis logic.
UPDATE public.ct_flags AS f
SET status = 'active'
WHERE f.status = 'graded'
  AND NOT EXISTS (
    SELECT 1 FROM public.ct_flag_grades g WHERE g.flag_id = f.id
  );
