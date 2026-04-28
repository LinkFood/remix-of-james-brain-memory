-- Crank contract-poller throughput + fix grader peak-lookup.
--
-- Diagnosis (2026-04-28 ~12:50 ET):
--   * 6,990 WORKING tracks. Poller maxPerRun=60, cron */5 13-20.
--     Throughput: 60 * 84 fires/RTH-day = 5,040 polls/day.
--     Required for 5-min cadence on all WORKING: ~370k/day.
--     We were at 1.4% of needed throughput.
--   * 47% of WORKING tracks had sweep_count <= 1 — only ever polled once.
--   * Result: peak_contract_pct stuck at 0 → flag-grader mints "invalidated_early"
--     even when contracts hit big peaks. 0 'win' outcomes in 7 days.
--   * P/L chips on /tape read current_contract_pct from same source — stale.
--   * Per-symbol track duplication: print-grader creates a new track per print,
--     so QQQ650C has 4+ tracks. Grader picks closest-by-print_time, often grabs
--     a fresh track that hasn't been polled yet (peak=0).
--
-- Fixes:
--   1. Bump maxPerRun 60 → 100 in ct_config.
--   2. Tighten ct-contract-poller cron */5 → */3 (140 fires/RTH-day).
--      New throughput: 100 * 140 = 14,000 polls/day. Fits UW budget alongside
--      flow-ingester (~3,700/day) and other consumers.
--   3. Replace ct-flag-grader's pickBestTrack semantics in SQL: when grading
--      a flag, take MAX(peak_contract_pct) across ALL tracks for the same
--      option_symbol within the flag window. One bad-luck closest-print track
--      no longer hides a real win that another print captured.
--      (Done via new RPC ct_max_peak_for_flag — grader will call it.)

SET search_path = public, extensions;

-- ---- 1. Bump poller per-run cap ----
-- (ct_config has no unique constraint on key, so use UPDATE not UPSERT.)
UPDATE public.ct_config
SET value = '100'::jsonb,
    updated_at = now()
WHERE key = 'contract_poller_max_per_run';

-- ---- 2. Tighten poller cron ----
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-contract-poller') THEN
    PERFORM cron.unschedule('ct-contract-poller');
  END IF;
  PERFORM cron.schedule(
    'ct-contract-poller',
    '*/3 13-20 * * 1-5',
    $body$SELECT public.invoke_edge_function('ct-contract-poller', '{}'::jsonb);$body$
  );
END
$cron$;

-- ---- 3. RPC for grader: max peak across same-symbol tracks in window ----
CREATE OR REPLACE FUNCTION public.ct_max_peak_for_flag(
  p_option_symbol  TEXT,
  p_flag_created   TIMESTAMPTZ
)
RETURNS TABLE(
  peak_contract_pct NUMERIC,
  max_drawdown_pct  NUMERIC,
  track_count       INTEGER
)
LANGUAGE sql STABLE
SET search_path = public, extensions
AS $$
  -- Look at all tracks for this option_symbol whose print_time falls within
  -- the flag's actionable window (1h before to 6h after — same window the
  -- grader's pickBestTrack uses, just aggregated instead of "closest"). Take
  -- the MAX peak we observed and the MAX drawdown.
  SELECT
    MAX(peak_contract_pct)::NUMERIC AS peak_contract_pct,
    MAX(max_drawdown_pct)::NUMERIC  AS max_drawdown_pct,
    COUNT(*)::INTEGER               AS track_count
  FROM public.ct_contract_tracks
  WHERE option_symbol = p_option_symbol
    AND print_time >= (p_flag_created - INTERVAL '1 hour')
    AND print_time <= (p_flag_created + INTERVAL '6 hours');
$$;

GRANT EXECUTE ON FUNCTION public.ct_max_peak_for_flag(TEXT, TIMESTAMPTZ)
  TO authenticated, service_role;
