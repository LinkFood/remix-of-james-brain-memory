-- Co-Trader v2 scrub — unschedule all paper-trader crons.
-- 2026-04-23: Paper-trader architecture retired. Specialist model replacing.
-- See docs/CO_TRADER_V2_SCOPE.md for full context.

DO $$
DECLARE
  v_cron TEXT;
  v_crons TEXT[] := ARRAY[
    'ct-bias-booth',
    'ct-book-eod-close',
    'ct-book-manager',
    'ct-claude-book-exit-watcher',
    'ct-claude-book-writer',
    'ct-claude-cash-decay',
    'ct-claude-cio-review',
    'ct-claude-circuit-breaker',
    'ct-claude-generation-manager',
    'ct-claude-generation-manager-weekend',
    'ct-claude-health-monitor',
    'ct-claude-open-trade-journal',
    'ct-claude-trade-open',
    'ct-claude-trade-reopen',
    'ct-dream',
    'ct-eod-recap',
    'ct-event-watcher',
    'ct-flag-book-commit',
    'ct-midday-recap',
    'ct-morning-brief',
    'ct-pre-bell-alert',
    'ct-pre-bell-gauntlet',
    'ct-pre-bell-grader',
    'ct-weekly-reflection'
  ];
BEGIN
  FOREACH v_cron IN ARRAY v_crons LOOP
    PERFORM cron.unschedule(v_cron)
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = v_cron);
  END LOOP;
END $$;
