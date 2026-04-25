-- ============================================================================
-- Co-Trader — ct_signatures + ct_edge_daily schema morph (Layer 2 spec)
-- ============================================================================
-- 20260425000011 landed an older shape (single-horizon win/loss/flat counts,
-- minimal ct_edge_daily). The Layer-2 build needs the snapshot_* / lifetime_*
-- split (snapshot from ct_print_grades, lifetime from ct_print_tracks) so we
-- can distinguish quick-hit edge from slow-burn edge, plus
-- slow_burn_pays_today / track-update counters / by_dte_bucket on
-- ct_edge_daily.
--
-- Both tables are empty in the remote DB at morph time, so column adds with
-- defaults are safe.
--
-- Tenet 4 (ground-up): we ADD the new columns rather than rename/drop the
-- old ones — keeps the door open for parallel work that may have written to
-- horizon/win_count/etc., and the miner picks the new columns explicitly.
-- ============================================================================

SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- ct_signatures — add snapshot_* / lifetime_* split + median_days +
-- promotion_notes. Old (horizon, win_count, loss_count, flat_count, hit_rate)
-- columns left in place; the miner does not touch them.
-- ----------------------------------------------------------------------------
ALTER TABLE public.ct_signatures
  ADD COLUMN IF NOT EXISTS snapshot_horizon            TEXT,
  ADD COLUMN IF NOT EXISTS snapshot_win                INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS snapshot_loss               INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS snapshot_flat               INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS snapshot_hit_rate           NUMERIC,
  ADD COLUMN IF NOT EXISTS lifetime_realized           INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lifetime_failing            INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lifetime_flat               INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lifetime_expired_unrealized INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lifetime_hit_rate           NUMERIC,
  ADD COLUMN IF NOT EXISTS median_days_to_realization  NUMERIC,
  ADD COLUMN IF NOT EXISTS promotion_notes             TEXT;

-- The 20260425000011 build made horizon NOT NULL — drop the constraint so
-- the miner (which doesn't write to that column) can upsert without it.
ALTER TABLE public.ct_signatures
  ALTER COLUMN horizon DROP NOT NULL;
ALTER TABLE public.ct_signatures
  ALTER COLUMN side DROP NOT NULL;
ALTER TABLE public.ct_signatures
  ALTER COLUMN ticker DROP NOT NULL;
ALTER TABLE public.ct_signatures
  ALTER COLUMN dte_bucket DROP NOT NULL;
ALTER TABLE public.ct_signatures
  ALTER COLUMN aggression DROP NOT NULL;
ALTER TABLE public.ct_signatures
  ALTER COLUMN time_bucket DROP NOT NULL;

CREATE INDEX IF NOT EXISTS ct_signatures_ticker_edge
  ON public.ct_signatures (ticker, edge_score DESC NULLS LAST);

-- ----------------------------------------------------------------------------
-- ct_edge_daily — add snapshot_* + tracks_* + slow_burn_pays_today +
-- by_dte_bucket. Old (top_winning_signatures, top_losing_signatures,
-- by_ticker, by_time_bucket, regime_tag, total_graded, total_wins,
-- total_losses, overall_hit_rate) columns left in place.
-- ----------------------------------------------------------------------------
ALTER TABLE public.ct_edge_daily
  ADD COLUMN IF NOT EXISTS snapshot_total_graded   INT,
  ADD COLUMN IF NOT EXISTS snapshot_wins           INT,
  ADD COLUMN IF NOT EXISTS snapshot_losses         INT,
  ADD COLUMN IF NOT EXISTS snapshot_flats          INT,
  ADD COLUMN IF NOT EXISTS snapshot_hit_rate       NUMERIC,
  ADD COLUMN IF NOT EXISTS tracks_realized_today   INT,
  ADD COLUMN IF NOT EXISTS tracks_new_peaks_today  INT,
  ADD COLUMN IF NOT EXISTS tracks_expired_today    INT,
  ADD COLUMN IF NOT EXISTS slow_burn_pays_today    JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS by_dte_bucket           JSONB DEFAULT '{}'::jsonb;

-- ----------------------------------------------------------------------------
-- Refresh promotion-config seeds (idempotent ON CONFLICT DO NOTHING). The
-- 20260425000011 build seeded older values; we now own the canonical set.
-- ----------------------------------------------------------------------------
INSERT INTO ct_config (key, value, description, category, min_value, max_value, default_value) VALUES
  ('signature_slow_burn_days', '3'::jsonb,
    'A REALIZED track counts as a "slow burn pay" if its print_time was >= this many days before the realization day.',
    'signatures', 1, 30, '3'::jsonb)
ON CONFLICT (key) DO NOTHING;
