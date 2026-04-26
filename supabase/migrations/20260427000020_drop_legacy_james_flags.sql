-- Drop the legacy ct_james_flags + ct_james_flag_grades tables.
--
-- All consumers (Tape.tsx ⭐ button + state read, Flags.tsx tile, ct-flag-grader)
-- migrated to the unified ct_flags WHERE source='james_star' shape. Backfill
-- migration 20260427000010 already copied the 4 historical stars into ct_flags
-- so dropping these tables loses nothing.
SET search_path = public, extensions;

DROP TABLE IF EXISTS public.ct_james_flag_grades;
DROP TABLE IF EXISTS public.ct_james_flags;
