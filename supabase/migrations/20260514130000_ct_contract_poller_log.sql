-- Ship 2 — ct_contract_poller_log telemetry table.
--
-- Closes the measurement gap discovered by the Phase 1 audit: ct-contract-poller
-- writes zero telemetry today. Phase 1 found 0 tracks in 14d have sweep_count >= 4
-- and 38.3% of tracks were never polled, but the WHY is invisible — the ephemeral
-- stats.skipped_reason blob dies with the HTTP response. This table makes every
-- poll attempt (or non-attempt) observable per-contract per-run.
--
-- One row per (contract attempted, attempt outcome). Fire-and-forget from the
-- poller — must never block the existing update path.
--
-- Column conventions mirror ct_brain_telemetry (id bigint identity, created_at
-- default now(), service-role insert RLS, authenticated select RLS).
--
-- sweep_reason enum derived from Phase A code-path map of supabase/functions/
-- ct-contract-poller/index.ts:
--   tightened_throttle   — tier-modulo skip on tightened budget (cron-fire-level)
--   critical_throttle    — tier-modulo skip on critical budget (cron-fire-level)
--   exhausted_full_halt  — full short-circuit on exhausted budget (cron-fire-level)
--   skipped_cadence      — track loaded but not yet due per cadence filter
--   skipped_cap          — track past cfg.maxPerRun slice (LRU tail dropped)
--   skipped_budget       — uwBudgetOk() flipped false mid-loop, in-flight only
--   quote_written        — successful UW pull, quote landed in ct_contract_quotes
--   quote_dropped        — UW returned q.ok=false or mid=null, applyMissToTrack path
--   uw_error             — UW call threw an exception
--
-- Cron-fire-level reasons (tightened/critical/exhausted) write ONE row per run
-- with option_symbol='__cron_skip__' so the run is still visible in aggregation
-- without inflating per-contract counts.

CREATE TABLE IF NOT EXISTS public.ct_contract_poller_log (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id          text NOT NULL,
  option_symbol   text NOT NULL,
  ticker          text,
  dte             integer,
  sweep_reason    text NOT NULL,
  latency_ms      integer,
  error_msg       text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ct_contract_poller_log_sweep_reason_chk
    CHECK (sweep_reason IN (
      'tightened_throttle',
      'critical_throttle',
      'exhausted_full_halt',
      'skipped_cadence',
      'skipped_cap',
      'skipped_budget',
      'quote_written',
      'quote_dropped',
      'uw_error'
    ))
);

COMMENT ON TABLE public.ct_contract_poller_log IS
  'Ship 2 — per-attempt telemetry for ct-contract-poller. One row per contract attempted (or one per run for cron-level skips). Fire-and-forget writes.';
COMMENT ON COLUMN public.ct_contract_poller_log.run_id IS
  'Per-invocation UUID generated at function entry. Lets you aggregate all attempts within one cron fire.';
COMMENT ON COLUMN public.ct_contract_poller_log.sweep_reason IS
  'Outcome bucket — see ct_contract_poller_log migration header for definitions.';
COMMENT ON COLUMN public.ct_contract_poller_log.option_symbol IS
  'OCC contract symbol attempted. "__cron_skip__" for cron-fire-level rows (tightened/critical/exhausted) that have no per-contract attempt.';

-- Hot indexes for warden + drilldown queries.
CREATE INDEX IF NOT EXISTS idx_ct_contract_poller_log_recent
  ON public.ct_contract_poller_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ct_contract_poller_log_run
  ON public.ct_contract_poller_log (run_id);
CREATE INDEX IF NOT EXISTS idx_ct_contract_poller_log_symbol_time
  ON public.ct_contract_poller_log (option_symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ct_contract_poller_log_reason_time
  ON public.ct_contract_poller_log (sweep_reason, created_at DESC);

-- RLS: authenticated read (for /alarms or future telemetry dashboards),
-- service role insert only. Mirrors ct_brain_telemetry policy shape.
ALTER TABLE public.ct_contract_poller_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ct_contract_poller_log_select_auth ON public.ct_contract_poller_log;
CREATE POLICY ct_contract_poller_log_select_auth
  ON public.ct_contract_poller_log
  FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS ct_contract_poller_log_insert_service ON public.ct_contract_poller_log;
CREATE POLICY ct_contract_poller_log_insert_service
  ON public.ct_contract_poller_log
  FOR INSERT
  TO service_role
  WITH CHECK (true);

GRANT SELECT ON public.ct_contract_poller_log TO authenticated;
GRANT INSERT, SELECT ON public.ct_contract_poller_log TO service_role;

-- Seed config tunables (retention + warden thresholds).
-- contract_poller_log_retention_days — used by rotation cron (sibling migration)
-- warden_poller_skipped_budget_max — fail if skipped_budget% > this in 4h RTH window
-- warden_poller_skipped_lru_max    — fail if skipped_cap% > this (LRU starvation)
-- warden_poller_quote_written_min  — fail if quote_written% < this (write-rate floor)
INSERT INTO public.ct_config (key, value, description, category, min_value, max_value, default_value) VALUES
  ('contract_poller_log_retention_days', '14'::jsonb,
    'Days of ct_contract_poller_log history to retain. Daily rotation cron deletes older rows.',
    'contract_poller', 1, 90, '14'::jsonb),
  ('warden_poller_skipped_budget_max', '0.30'::jsonb,
    'Warden threshold — fail invariant if skipped_budget share of 4h RTH window exceeds this.',
    'warden', 0, 1, '0.30'::jsonb),
  ('warden_poller_skipped_lru_max', '0.60'::jsonb,
    'Warden threshold — fail invariant if skipped_cap share of 4h RTH window exceeds this (LRU starvation).',
    'warden', 0, 1, '0.60'::jsonb),
  ('warden_poller_quote_written_min', '0.05'::jsonb,
    'Warden threshold — fail invariant if quote_written share of 4h RTH window falls below this.',
    'warden', 0, 1, '0.05'::jsonb)
ON CONFLICT (key) DO NOTHING;
