-- =============================================================================
-- 20260422000005_ct_trade_engine_crons.sql
--
-- Wave C: autonomous trade engine. Cron schedules + manual-trigger RPCs for
-- the three edge functions shipped this wave, plus the two schema tweaks that
-- make Claude's autonomous book legal:
--
--   1) ct_grades.subject_type CHECK — add 'trade' so the exit-watcher can
--      grade a closed ct_trades row (existing check only allowed flag/alert/
--      james_view). The AFTER INSERT trigger on ct_grades (shipped in
--      20260422000002) already handles hypothesis_id → confidence update, so
--      extending the subject_type domain is the only change needed.
--
--   2) ct_book unique constraint — drop the bare UNIQUE on session_date and
--      replace with a composite UNIQUE on (trader, session_date). With two
--      traders (james + claude) each owning a book row per day, the old
--      constraint would collide as soon as both books had today's row.
--
-- Schedules (all UTC, weekdays only, during US equities RTH 13-20 UTC):
--   ct-trade-idea-generator     : */5 13-20 * * 1-5  (every 5 min)
--   ct-claude-book-writer       : */2 13-20 * * 1-5  (every 2 min)
--   ct-claude-book-exit-watcher : */2 13-20 * * 1-5  (every 2 min)
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- 1) Extend ct_grades.subject_type to allow 'trade'.
--
-- Drop the existing CHECK then re-add with the expanded domain. The constraint
-- name follows Postgres's auto-naming convention (table_column_check); we look
-- it up by information_schema to avoid hard-coding a name that could drift.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_name text;
BEGIN
  SELECT conname INTO v_name
    FROM pg_constraint
   WHERE conrelid = 'public.ct_grades'::regclass
     AND contype  = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%subject_type%';
  IF v_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.ct_grades DROP CONSTRAINT %I', v_name);
  END IF;
END $$;

ALTER TABLE public.ct_grades
  ADD CONSTRAINT ct_grades_subject_type_check
  CHECK (subject_type IN ('flag','alert','james_view','trade'));

-- -----------------------------------------------------------------------------
-- 2) ct_book: swap the UNIQUE(session_date) for UNIQUE(trader, session_date).
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_name text;
BEGIN
  -- Drop whichever name Postgres assigned to the bare UNIQUE on session_date.
  SELECT conname INTO v_name
    FROM pg_constraint
   WHERE conrelid = 'public.ct_book'::regclass
     AND contype  = 'u'
     AND array_length(conkey, 1) = 1
     AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                           WHERE attrelid = 'public.ct_book'::regclass
                             AND attname  = 'session_date')];
  IF v_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.ct_book DROP CONSTRAINT %I', v_name);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.ct_book'::regclass
       AND conname  = 'ct_book_trader_session_date_key'
  ) THEN
    ALTER TABLE public.ct_book
      ADD CONSTRAINT ct_book_trader_session_date_key UNIQUE (trader, session_date);
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Manual-trigger RPCs — each is a one-line wrapper around _ct_post. These let
-- the /crons UI "Run now" button fire each function ad-hoc via the Vault-
-- powered Authorization pattern (avoids the CLI-vs-runtime service_role key
-- mismatch documented in ~/.claude/agent-memory/.../service-role-key-rotation).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trigger_ct_trade_idea_generator()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-trade-idea-generator'); $fn$;
GRANT EXECUTE ON FUNCTION public.trigger_ct_trade_idea_generator() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.trigger_ct_claude_book_writer()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-claude-book-writer'); $fn$;
GRANT EXECUTE ON FUNCTION public.trigger_ct_claude_book_writer() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.trigger_ct_claude_book_exit_watcher()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-claude-book-exit-watcher'); $fn$;
GRANT EXECUTE ON FUNCTION public.trigger_ct_claude_book_exit_watcher() TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- pg_cron schedules. Standard Vault+net.http_post pattern with $cron$/$body$
-- nesting (never $$ inside $$).
-- -----------------------------------------------------------------------------

-- Unschedule any prior versions of these jobs (idempotent redeploy).
DO $$
DECLARE
  j record;
BEGIN
  FOR j IN SELECT jobname FROM cron.job
           WHERE jobname IN (
             'ct-trade-idea-generator',
             'ct-claude-book-writer',
             'ct-claude-book-exit-watcher'
           )
  LOOP
    PERFORM cron.unschedule(j.jobname);
  END LOOP;
END $$;

-- Trade idea generator: every 5 min, 13-20 UTC, weekdays.
SELECT cron.schedule(
  'ct-trade-idea-generator',
  '*/5 13-20 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-trade-idea-generator',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);

-- Book writer: every 2 min, 13-20 UTC, weekdays.
SELECT cron.schedule(
  'ct-claude-book-writer',
  '*/2 13-20 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-claude-book-writer',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);

-- Exit watcher: every 2 min, 13-20 UTC, weekdays.
SELECT cron.schedule(
  'ct-claude-book-exit-watcher',
  '*/2 13-20 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-claude-book-exit-watcher',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);
