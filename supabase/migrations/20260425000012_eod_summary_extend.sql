-- ============================================================================
-- Co-Trader v2 — ct_eod_summaries: hedge-fund attribution columns
-- ============================================================================
-- Additive-only. Existing ct-eod-summary writes (specialist_stats / ticker_stats
-- / market_stats / summary_text) keep working unchanged. New columns capture
-- the hedge-fund-grade attribution pulled in from ct_edge_daily, ct_print_grades,
-- and ct_print_tracks (parallel agents own those tables).
--
-- Why these columns and not just a fatter market_stats blob:
--   - top-level columns let the /eod page render specific surfaces without
--     parsing nested JSON,
--   - the per-day attribution snapshot (regime, slow-burn, tracks realized) is
--     the single most important historical artefact — promote it from a JSONB
--     leaf to a queryable column so future analytics can SELECT … WHERE.
--
-- All columns nullable. Code that doesn't populate them (older revisions,
-- backfills) still upserts cleanly.
-- ============================================================================

SET search_path = public, extensions;

ALTER TABLE public.ct_eod_summaries
  ADD COLUMN IF NOT EXISTS edge_attribution     JSONB,
  ADD COLUMN IF NOT EXISTS slow_burn_pays_today JSONB,
  ADD COLUMN IF NOT EXISTS top_print_grades     JSONB,
  ADD COLUMN IF NOT EXISTS top_realized_tracks  JSONB,
  ADD COLUMN IF NOT EXISTS specialist_scorecard JSONB,
  ADD COLUMN IF NOT EXISTS regime_tag           TEXT,
  ADD COLUMN IF NOT EXISTS snapshot_hit_rate    NUMERIC,
  ADD COLUMN IF NOT EXISTS tracks_realized_today INT;

COMMENT ON COLUMN public.ct_eod_summaries.edge_attribution IS
  'Today''s ct_edge_daily slice: top_winning_signatures, top_losing_signatures, by_ticker, by_time_bucket, by_dte_bucket. Empty {} if ct_edge_daily not populated yet for session_date.';
COMMENT ON COLUMN public.ct_eod_summaries.slow_burn_pays_today IS
  'Retroactive wins — prints from 3+ days ago that REALIZED today (track_status flipped). [] if ct_print_tracks not present.';
COMMENT ON COLUMN public.ct_eod_summaries.top_print_grades IS
  'Top 10 graded prints today by absolute move, joined with ct_flow_alerts context (ticker, side, strike, signature_key). [] if grader hasn''t landed.';
COMMENT ON COLUMN public.ct_eod_summaries.top_realized_tracks IS
  'Top 10 prints whose track REALIZED today (regardless of print_time). Days-to-realization, peak_pct, signature_key. [] if ct_print_tracks empty.';
COMMENT ON COLUMN public.ct_eod_summaries.specialist_scorecard IS
  'Per-specialist daily attribution: { ticker: { flags, wins, losses, realized_tracks, best_call, worst_call } } across the 10 watchlist specialists.';
COMMENT ON COLUMN public.ct_eod_summaries.regime_tag IS
  'Day''s regime classification copied from ct_edge_daily.regime_tag for fast filter ("low-vol-trend", "high-vol-chop", etc.).';
COMMENT ON COLUMN public.ct_eod_summaries.snapshot_hit_rate IS
  'Today''s overall snapshot hit rate from ct_edge_daily.overall_hit_rate (wins / wins+losses).';
COMMENT ON COLUMN public.ct_eod_summaries.tracks_realized_today IS
  'Count of ct_print_tracks rows whose track_status flipped to REALIZED today. NULL if tracks table empty.';
