-- ============================================================================
-- Co-Trader — Signature Mining + Edge Attribution (Layer 2)
-- ============================================================================
-- Layer 1 (ct_print_grades, migration 20260425000010) gives every UW print a
-- directional grade at 30m / 2h / eod / plus1d. The parallel agent's
-- ct_print_tracks layer adds *lifetime* tracking (peak_favorable_pct,
-- track_status WORKING/REALIZED/FAILING/FLAT/EXPIRED) so we can detect
-- slow-burn patterns where the snapshot horizon misses but the print
-- eventually pays off weeks later.
--
-- This migration mines BOTH layers into a *signature library* keyed by
-- (ticker, side, dte_bucket, moneyness, aggression, time_bucket). Each row
-- carries snapshot_* counts (fast feedback) AND lifetime_* counts (slow
-- burn). edge_score uses lifetime when sample is rich, snapshot otherwise.
--
-- ct_edge_daily is the per-session attribution ledger — what fired today,
-- what worked, what failed, AND retroactive payoffs (slow_burn_pays_today:
-- prints from 3+ days ago that REALIZED today). The proof-of-learning
-- artifact future reflectors mine.
--
-- Tenets:
--   3  (built to evolve)        — library grows daily, no hand curation,
--                                 promotion is automatic.
--   13 (ungated signal access)  — every dimension is first-class in the
--                                 signature key, equal weight.
--   7  (every number tunable)   — promotion thresholds + slow-burn cutoff
--                                 in ct_config.
--   17 (meta-layer eats outputs)— ct_edge_daily becomes input to future
--                                 reflectors and the EOD narrative.
-- ============================================================================

SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- ct_signatures — the growing library
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ct_signatures (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signature_key               TEXT UNIQUE NOT NULL,
  ticker                      TEXT,
  side                        TEXT,                       -- call | put
  dte_bucket                  TEXT,                       -- '0dte' | '0-7' | '8-30' | '30+'
  moneyness                   TEXT,                       -- 'ITM' | 'ATM' | 'OTM-near' | 'OTM-far'
  aggression                  TEXT,                       -- 'ask' | 'bid' | 'mid'
  time_bucket                 TEXT,                       -- 'open' | 'midday' | 'close' | 'afterhours'
  -- Snapshot stats (frozen 30m/2h/eod horizons from ct_print_grades)
  snapshot_horizon            TEXT,                       -- '30m' | '2h' | 'eod' (which horizon these counts came from); NULL = lifetime-only
  snapshot_win                INT NOT NULL DEFAULT 0,
  snapshot_loss               INT NOT NULL DEFAULT 0,
  snapshot_flat               INT NOT NULL DEFAULT 0,
  snapshot_hit_rate           NUMERIC,
  -- Lifetime stats (slow-burn from ct_print_tracks)
  lifetime_realized           INT NOT NULL DEFAULT 0,
  lifetime_failing            INT NOT NULL DEFAULT 0,
  lifetime_flat               INT NOT NULL DEFAULT 0,
  lifetime_expired_unrealized INT NOT NULL DEFAULT 0,
  lifetime_hit_rate           NUMERIC,                    -- realized / (realized + failing)
  median_days_to_realization  NUMERIC,
  -- Combined
  sample_count                INT NOT NULL DEFAULT 0,
  edge_score                  NUMERIC,                    -- (hit_rate - 0.5) * sqrt(decisive_n); lifetime when realized+failing >= 20 else snapshot
  first_seen_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  promoted                    BOOLEAN NOT NULL DEFAULT FALSE,
  promotion_notes             TEXT
);

CREATE INDEX IF NOT EXISTS ct_signatures_ticker_edge
  ON public.ct_signatures (ticker, edge_score DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS ct_signatures_promoted_edge
  ON public.ct_signatures (promoted, edge_score DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS ct_signatures_signature_key
  ON public.ct_signatures (signature_key);

ALTER TABLE public.ct_signatures ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ct_signatures_read ON public.ct_signatures;
CREATE POLICY ct_signatures_read ON public.ct_signatures
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS ct_signatures_service ON public.ct_signatures;
CREATE POLICY ct_signatures_service ON public.ct_signatures
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ct_signatures IS
  'Mined edge signatures keyed by ticker:side:dte:moneyness:aggression:time_bucket. Combines snapshot grades (fast feedback) + lifetime tracks (slow-burn). Auto-promoted when sample + edge thresholds met.';

COMMENT ON COLUMN public.ct_signatures.edge_score IS
  '(hit_rate - 0.5) * sqrt(decisive_count). Uses lifetime when realized+failing >= 20, snapshot otherwise.';

-- ----------------------------------------------------------------------------
-- ct_edge_daily — per-session attribution ledger
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ct_edge_daily (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_date             DATE UNIQUE NOT NULL,
  regime_tag               TEXT,
  -- Today's snapshot performance (from today's ct_print_grades inserts)
  snapshot_total_graded    INT,
  snapshot_wins            INT,
  snapshot_losses          INT,
  snapshot_flats           INT,
  snapshot_hit_rate        NUMERIC,
  -- Today's track updates (lifetime tracking activity)
  tracks_realized_today    INT,
  tracks_new_peaks_today   INT,
  tracks_expired_today     INT,
  -- Attribution JSON
  top_winning_signatures   JSONB DEFAULT '[]'::jsonb,
  top_losing_signatures    JSONB DEFAULT '[]'::jsonb,
  slow_burn_pays_today     JSONB DEFAULT '[]'::jsonb,
  by_ticker                JSONB DEFAULT '{}'::jsonb,
  by_time_bucket           JSONB DEFAULT '{}'::jsonb,
  by_dte_bucket            JSONB DEFAULT '{}'::jsonb,
  computed_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ct_edge_daily_session_date
  ON public.ct_edge_daily (session_date DESC);

ALTER TABLE public.ct_edge_daily ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ct_edge_daily_read ON public.ct_edge_daily;
CREATE POLICY ct_edge_daily_read ON public.ct_edge_daily
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS ct_edge_daily_service ON public.ct_edge_daily;
CREATE POLICY ct_edge_daily_service ON public.ct_edge_daily
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ct_edge_daily IS
  'Daily edge-attribution ledger. One row per trading day. Snapshot performance, track updates, top winning/losing signatures, slow-burn retroactive payoffs (prints from 3+ days ago that REALIZED today), and per-ticker / time-bucket / dte-bucket rollups.';

-- ----------------------------------------------------------------------------
-- ct_config seeds — promotion thresholds + slow-burn cutoff
-- ----------------------------------------------------------------------------
INSERT INTO ct_config (key, value, description, category, min_value, max_value, default_value) VALUES
  ('signature_promotion_min_sample', '20'::jsonb,
    'Minimum decisive sample (snapshot wins+losses, OR lifetime realized+failing) before a signature can be promoted.',
    'signatures', 1, 1000, '20'::jsonb),
  ('signature_promotion_min_edge', '0.15'::jsonb,
    'Minimum |edge_score| for a signature to flip promoted=TRUE. edge_score = (hit_rate - 0.5) * sqrt(N).',
    'signatures', 0.0, 5.0, '0.15'::jsonb),
  ('signature_slow_burn_days', '3'::jsonb,
    'A REALIZED track counts as a "slow burn pay" if its print_time was >= this many days before the realization day.',
    'signatures', 1, 30, '3'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Cron: 0 21 * * 1-5  (21:00 UTC weekdays = 5pm ET, after RTH close +
-- ct-eod-summary at 20:30 UTC + ct-print-grader catching up snapshot
-- horizons that matured today). Vault auth via $cron$/$body$.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM cron.unschedule('ct-edge-miner');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'ct-edge-miner',
  '0 21 * * 1-5',
  $cron$
    SELECT net.http_post(
      url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-edge-miner',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body := '{}'::jsonb
    ) AS request_id;
  $cron$
);
