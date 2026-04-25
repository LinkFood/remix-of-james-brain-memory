-- ct_print_tracks — lifetime tracking ledger for raw UW flow prints.
--
-- Why this exists (and why it sits next to ct_print_grades, not inside it):
--   ct_print_grades captures FROZEN snapshots at fixed horizons (30m / 2h /
--   eod / plus1d). That gives fast feedback on short-horizon signals.
--
--   Long-dated contracts break the snapshot model. A 30DTE call that sits flat
--   for 3 weeks and then 5x's in the final days is REAL edge — but every fixed
--   horizon would grade FLAT or LOSS. To capture slow-burn winners we need a
--   second ledger that updates IN PLACE, tracking peak favorable / adverse
--   moves continuously until contract expiry (or a 30-day cap).
--
-- Tenet 3 (built to evolve): tracking continues, the signal grows with age.
-- Tenet 4 (ground-up): grading_method column lets contract-price tracking
--   layer in alongside underlying_v1 without re-grading.
-- Tenet 5 (progress independent of P&L): every print gets tracked regardless
--   of whether Claude flagged it — the dataset compounds.
-- Tenet 7 (every number tunable): DTE-bucket WIN thresholds + max-tracking
--   window live in ct_config.
--
-- Schema notes
--   - One row per alert_id (UNIQUE). Updated in place every grader sweep.
--   - peak_favorable_pct / peak_adverse_pct stored as ABSOLUTE magnitudes.
--     "Favorable" = move in predicted_direction; "adverse" = against it.
--   - first_cross_threshold_at = first sweep where peak_favorable_pct crossed
--     the DTE-bucket threshold. Lets us answer "when did this print pay off?"
--   - track_status flips to REALIZED / FAILING / FLAT / EXPIRED based on
--     evolving peaks — see ct-print-grader Pass 2 for state machine.
--   - tracking_until = LEAST(expiry, print_time + grade_tracking_max_days).

SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS public.ct_print_tracks (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id                 text NOT NULL UNIQUE,
  ticker                   text NOT NULL,
  side                     text NOT NULL,                                  -- 'call' | 'put'
  strike                   numeric,
  expiry                   date,
  dte_at_print             integer,
  print_time               timestamptz NOT NULL,
  predicted_direction      text NOT NULL,                                  -- 'up' | 'down'
  predicted_source         text NOT NULL,
  underlying_at_print      numeric,
  current_underlying       numeric,
  current_move_pct         numeric,                                        -- signed, latest observation
  peak_favorable_pct       numeric NOT NULL DEFAULT 0,                     -- max in predicted direction over lifetime (magnitude)
  peak_favorable_at        timestamptz,
  peak_adverse_pct         numeric NOT NULL DEFAULT 0,                     -- max against predicted (magnitude)
  peak_adverse_at          timestamptz,
  first_cross_threshold_at timestamptz,                                    -- first time favorable peak crossed WIN threshold
  track_status             text NOT NULL DEFAULT 'WORKING',                -- 'WORKING' | 'REALIZED' | 'FAILING' | 'FLAT' | 'EXPIRED'
  tracking_until           timestamptz NOT NULL,
  sweep_count              integer NOT NULL DEFAULT 0,
  first_tracked_at         timestamptz NOT NULL DEFAULT now(),
  last_tracked_at          timestamptz NOT NULL DEFAULT now(),
  grading_method           text NOT NULL DEFAULT 'underlying_v1'
);

CREATE INDEX IF NOT EXISTS ct_print_tracks_status_until
  ON public.ct_print_tracks (track_status, tracking_until);

CREATE INDEX IF NOT EXISTS ct_print_tracks_ticker_peak
  ON public.ct_print_tracks (ticker, peak_favorable_pct DESC);

CREATE INDEX IF NOT EXISTS ct_print_tracks_peak_at
  ON public.ct_print_tracks (peak_favorable_at DESC);

ALTER TABLE public.ct_print_tracks ENABLE ROW LEVEL SECURITY;

CREATE POLICY ct_print_tracks_authread ON public.ct_print_tracks
  FOR SELECT TO authenticated USING (true);

CREATE POLICY ct_print_tracks_svcall ON public.ct_print_tracks
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ct_print_tracks IS
  'Lifetime tracking ledger for UW flow prints. Updated in place every grader sweep until tracking_until. Captures slow-burn winners that fixed-horizon ct_print_grades would miss. Pairs with ct_print_grades — both populated by ct-print-grader.';

-- ---------------------------------------------------------------------------
-- ct_config seeds — DTE-bucket WIN thresholds + per-snapshot thresholds +
-- max tracking window. ON CONFLICT DO NOTHING so re-runs and
-- operator-edited values are never clobbered. Existing
-- print_grade_threshold_* rows from migration 20260425000010 stay untouched
-- — they're the snapshot thresholds today; grade_threshold_snapshot_*
-- below are the spec-aligned aliases for the same horizons. Pass 1 of the
-- grader continues to read print_grade_threshold_*; Pass 2 reads
-- grade_threshold_<dte-bucket>. Both naming schemes resolve to the same
-- semantic (decimal fraction, 0.005 = 0.5%).
-- ---------------------------------------------------------------------------
INSERT INTO public.ct_config (key, value, description, category, min_value, max_value, default_value) VALUES
  -- DTE-bucket lifetime thresholds (Pass 2)
  ('grade_threshold_0dte', '0.003'::jsonb,
    'Lifetime peak |move| threshold for REALIZED on 0DTE prints. Decimal fraction (0.003 = 0.3%).',
    'print_grader', 0.0, 0.05, '0.003'::jsonb),
  ('grade_threshold_short', '0.005'::jsonb,
    'Lifetime peak |move| threshold for REALIZED on short prints (1-7 DTE). Decimal fraction (0.005 = 0.5%).',
    'print_grader', 0.0, 0.05, '0.005'::jsonb),
  ('grade_threshold_mid', '0.010'::jsonb,
    'Lifetime peak |move| threshold for REALIZED on mid prints (8-30 DTE). Decimal fraction (0.010 = 1.0%).',
    'print_grader', 0.0, 0.05, '0.010'::jsonb),
  ('grade_threshold_long', '0.020'::jsonb,
    'Lifetime peak |move| threshold for REALIZED on long prints (30+ DTE). Decimal fraction (0.020 = 2.0%).',
    'print_grader', 0.0, 0.10, '0.020'::jsonb),

  -- Snapshot-horizon thresholds — spec-aligned aliases for
  -- print_grade_threshold_30m / _2h / _eod (kept additive; Pass 1 still
  -- reads the original keys). Future cleanup can converge on a single
  -- naming scheme.
  ('grade_threshold_snapshot_30m', '0.001'::jsonb,
    'Snapshot |move| threshold at 30m horizon. Mirror of print_grade_threshold_30m.',
    'print_grader', 0.0, 0.05, '0.001'::jsonb),
  ('grade_threshold_snapshot_2h', '0.003'::jsonb,
    'Snapshot |move| threshold at 2h horizon. Mirror of print_grade_threshold_2h.',
    'print_grader', 0.0, 0.05, '0.003'::jsonb),
  ('grade_threshold_snapshot_eod', '0.005'::jsonb,
    'Snapshot |move| threshold at end-of-day horizon. Mirror of print_grade_threshold_eod.',
    'print_grader', 0.0, 0.05, '0.005'::jsonb),

  -- Max tracking window (days) — caps tracking_until at print_time + N days
  -- when the contract expiry is further out. Long-dated 90DTE prints don't
  -- need 90 days of tracking — most edge resolves inside 30.
  ('grade_tracking_max_days', '30'::jsonb,
    'Maximum days a print is tracked in ct_print_tracks before EXPIRED. tracking_until = LEAST(expiry, print_time + this).',
    'print_grader', 1, 365, '30'::jsonb)
ON CONFLICT (key) DO NOTHING;
