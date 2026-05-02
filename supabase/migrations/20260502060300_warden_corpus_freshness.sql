-- Warden invariant: ct_flag_analysis_corpus must stay in sync with ct_flags.
-- Metric = lag in hours between max(ct_flags.created_at) and max(corpus.fire_ts).
-- Expected max: 26 hours (nightly refresh at 04:00 UTC + grace).
-- Catches: refresh cron stopped firing, refresh function silently broken, MV stuck.

INSERT INTO public.ct_invariants
  (name, category, description, query_sql, expected_min, expected_max, severity, runbook_path, enabled)
VALUES (
  'flag_analysis_corpus_freshness',
  'data_freshness',
  'ct_flag_analysis_corpus refresh lag vs ct_flags. Lag in hours between latest flag and latest corpus row. Nightly cron at 04:00 UTC keeps this near 0; >26h means refresh stopped.',
  $invariant$
    WITH src AS (
      SELECT (SELECT max(created_at) FROM public.ct_flags) AS flag_max,
             (SELECT COALESCE(max(fire_ts), '1970-01-01'::timestamptz)
                FROM public.ct_flag_analysis_corpus) AS corpus_max
    )
    SELECT
      CASE
        WHEN flag_max IS NULL THEN 0
        WHEN corpus_max >= flag_max THEN 0
        ELSE ROUND(EXTRACT(EPOCH FROM (flag_max - corpus_max))/3600.0, 2)
      END::numeric AS metric_value,
      '[corpus_freshness] lag = ' ||
        CASE
          WHEN flag_max IS NULL THEN '0h (no flags)'
          WHEN corpus_max >= flag_max THEN '0h (in sync)'
          ELSE ROUND(EXTRACT(EPOCH FROM (flag_max - corpus_max))/3600.0, 2)::text || 'h'
        END AS message
    FROM src
  $invariant$,
  0,
  26,
  'warn',
  'docs/runbooks/silent_failures.md',
  true
)
ON CONFLICT (name) DO UPDATE SET
  description       = EXCLUDED.description,
  query_sql         = EXCLUDED.query_sql,
  expected_min      = EXCLUDED.expected_min,
  expected_max      = EXCLUDED.expected_max,
  severity          = EXCLUDED.severity,
  runbook_path      = EXCLUDED.runbook_path,
  enabled           = EXCLUDED.enabled,
  updated_at        = now();
