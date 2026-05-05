-- ct_specialist_wakeup_log — diagnostic ledger for every specialist wakeup.
--
-- Born from 2026-05-05 NVDA silent freeze (last write 2026-05-01T18:48:32,
-- 4 days dark). Root cause unknown for days because:
--   1. writeSpecialistRead() only console.warn'd on error (invisible)
--   2. runSpecialistWakeup() returned ok:true even when current_read parse
--      failed (skip_reason='passed' but no row written)
--   3. Function logs not queryable from production state without dashboard
--      or Management PAT (gated)
--
-- This table closes the loop. Every wakeup writes one row with full
-- diagnostic data. Per-ticker silent-failure becomes visible in PostgREST
-- without dashboard access. Warden gets a real-time invariant
-- (specialist_wakeups_with_no_read_24h) that catches single-ticker freezes.
--
-- Tenet 15 — class-killer for the silent-failure-then-only-passive-monitoring
-- pattern (see feedback_silent_failure_detection_pattern.md).

CREATE TABLE IF NOT EXISTS public.ct_specialist_wakeup_log (
  id BIGSERIAL PRIMARY KEY,
  ticker TEXT NOT NULL,
  wakeup_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason TEXT,                              -- scheduled / event_driven / manual
  skip_reason TEXT,                         -- kill_switch / cooldown / no_events / daily_cap / passed / flagged / parse_fail
  events_considered INT,
  flags_written INT DEFAULT 0,
  parse_ok BOOLEAN,                         -- did the JSON parse cleanly?
  current_read_present BOOLEAN,             -- did parsed.current_read survive guards?
  current_read_failure TEXT,                -- which guard failed (if any)
  claude_output_preview TEXT,               -- first 500 chars of raw Claude output
  cost_usd NUMERIC(10, 6),
  elapsed_ms INT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_ct_specialist_wakeup_log_ticker_time
  ON public.ct_specialist_wakeup_log(ticker, wakeup_at DESC);

CREATE INDEX IF NOT EXISTS idx_ct_specialist_wakeup_log_recent_failures
  ON public.ct_specialist_wakeup_log(wakeup_at DESC)
  WHERE current_read_present = false;

COMMENT ON TABLE public.ct_specialist_wakeup_log IS
  'Per-wakeup diagnostic ledger for the 10 ticker specialists. Closes the silent-failure observability gap exposed by 2026-05-05 NVDA freeze (4 days dark, no warden alert because count(DISTINCT ticker) only catches >=4 frozen specialists). Read in tandem with ct_specialist_reads (the actual read output) — log row written for every wakeup, read row only when current_read parse succeeds.';

COMMENT ON COLUMN public.ct_specialist_wakeup_log.current_read_failure IS
  'Specific reason current_read was rejected: invalid_lean / invalid_conviction / empty_text / missing / not_object. NULL if current_read_present=true.';
