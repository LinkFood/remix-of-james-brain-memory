-- ct_contract_tracks — lifetime tracking ledger for contract-PRICE evolution.
--
-- Why this exists (and why it sits next to ct_print_tracks, not inside it):
--   ct_print_tracks tracks UNDERLYING price after a flow print. That answers
--   "did SPX move where the print implied?" but says nothing about whether
--   the option contract itself paid off. A $0.50 0DTE call going to $50
--   (100x return) and a 30-strike-OTM call going from $0.05 to $0.10 (also
--   100% on-paper) are categorically different trades — only contract-axis
--   grading separates them.
--
--   Long-dated lottery tickets break the underlying-axis model entirely:
--   a 30DTE call can have the underlying drift sideways while the contract
--   loses 80% of premium to theta — underlying grading shows FLAT, the
--   reality is a LOSS. Conversely, a tiny underlying move in the right
--   direction can 5x a near-the-money short-DTE contract — underlying
--   grading shows FLAT, the reality is a WIN of an order of magnitude.
--
--   Mirror of ct_print_tracks but the price axis is the contract mid, not
--   the underlying close. Updated in place every poller sweep until the
--   contract expires (+1d so we capture final settlement).
--
-- The OCC-symbol-synthesis problem
--   ct_flow_alerts.option_symbol is NULL on every row today (UW shape
--   change — they stopped emitting it). The grader synthesizes the OCC
--   symbol from ticker + expiry + side + strike at track-creation time.
--   Format: {TICKER}{YYMMDD}{C|P}{strike*1000 padded to 8 digits}.
--   No `O:` prefix — UW REST endpoints accept the bare OCC string.
--   Synthesis lives in ct-print-grader (see buildOccSymbol). Rows where
--   strike or expiry are missing get skipped (counted as
--   skipped_no_symbol) — partial-data prints just don't get tracked, no
--   harm done.
--
-- Tenet 4 (ground-up, no band-aids): grading_method='contract_v1' lives
--   alongside underlying_v1 instead of replacing it — both axes coexist
--   and the dataset compounds. Wrapping a "use mid if available else
--   underlying" hack into the existing tracker would be the band-aid we
--   are explicitly avoiding.
-- Tenet 5 (progress independent of P&L): every print with synthesizable
--   symbol gets tracked regardless of Claude's flag — we want raw ground
--   truth on the option chain, not a curated subset.
-- Tenet 7 (every number tunable): DTE-bucket WIN thresholds, the loss
--   threshold, the spread/mid liquidity rails — all in ct_config.
--
-- Schema notes
--   - One row per alert_id (UNIQUE). Updated in place every poller sweep.
--   - option_symbol NOT NULL — Phase A guarantees synthesis-or-skip.
--   - peak_contract_pct / max_drawdown_pct stored as ABSOLUTE magnitudes
--     (decimal fractions: 1.00 = +100% / 2x; 50.0 = +5000% / 51x).
--   - time_to_50pct / 100pct / 200pct = elapsed time from print_time to
--     the first sweep where peak_contract_pct crossed each threshold.
--     Lets us answer "how fast did the lottery ticket pay?".
--   - track_status state machine extends ct_print_tracks with explicit
--     EXPIRED_WIN / EXPIRED_LOSS / EXPIRED_FLAT (final settlement matters
--     more on contract grading than on underlying grading).
--   - tracking_until = LEAST(expiry+1d at 21:00 UTC, print_time +
--     grade_tracking_max_days). The +1d on expiry is INTENTIONAL — for
--     contract tracking we want the final settlement quote, which posts
--     after the close on expiry day. For underlying tracking we stop AT
--     expiry because the underlying keeps trading regardless.
--   - last_quoted_at = last successful UW quote pull. Phase B poller
--     orders by this NULLS FIRST so brand-new tracks get hit first.
--   - grading_method='contract_v1' so a future contract_v2 (e.g. with
--     bid/ask spread normalization) can coexist without a backfill.

SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS public.ct_contract_tracks (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id                 text NOT NULL UNIQUE,
  option_symbol            text NOT NULL,
  ticker                   text NOT NULL,
  side                     text NOT NULL,                                  -- 'call' | 'put'
  strike                   numeric,
  expiry                   date,
  dte_at_print             integer,
  print_time               timestamptz NOT NULL,
  predicted_direction      text NOT NULL,                                  -- 'up' | 'down' (mirrors ct_print_tracks)
  predicted_source         text NOT NULL,
  entry_contract_price     numeric,                                        -- per-share at print
  entry_source             text NOT NULL DEFAULT 'flow_alert_price',       -- 'flow_alert_price' | 'chain_lookup_at_print' | 'estimated_mid'
  current_contract_price   numeric,
  current_contract_pct     numeric,                                        -- signed (current - entry) / entry
  peak_contract_price      numeric,
  peak_contract_at         timestamptz,
  peak_contract_pct        numeric NOT NULL DEFAULT 0,                     -- absolute magnitude e.g. 1.00 = +100%, 50.0 = +5000%
  trough_contract_price    numeric,
  trough_contract_at       timestamptz,
  max_drawdown_pct         numeric NOT NULL DEFAULT 0,                     -- absolute magnitude of worst loss
  time_to_50pct            interval,
  time_to_100pct           interval,
  time_to_200pct           interval,
  track_status             text NOT NULL DEFAULT 'WORKING',                -- 'WORKING' | 'WIN' | 'LOSS' | 'EXPIRED_WIN' | 'EXPIRED_LOSS' | 'EXPIRED_FLAT' | 'STALE'
  tracking_until           timestamptz NOT NULL,
  last_quoted_at           timestamptz,
  sweep_count              integer NOT NULL DEFAULT 0,
  first_tracked_at         timestamptz NOT NULL DEFAULT now(),
  last_tracked_at          timestamptz NOT NULL DEFAULT now(),
  grading_method           text NOT NULL DEFAULT 'contract_v1'
);

CREATE INDEX IF NOT EXISTS ct_contract_tracks_status_until
  ON public.ct_contract_tracks (track_status, tracking_until);

CREATE INDEX IF NOT EXISTS ct_contract_tracks_ticker_peak
  ON public.ct_contract_tracks (ticker, peak_contract_pct DESC);

CREATE INDEX IF NOT EXISTS ct_contract_tracks_option_symbol
  ON public.ct_contract_tracks (option_symbol);

-- Phase B poller scan order: never-quoted first, then oldest-quoted.
CREATE INDEX IF NOT EXISTS ct_contract_tracks_last_quoted
  ON public.ct_contract_tracks (last_quoted_at NULLS FIRST, track_status);

ALTER TABLE public.ct_contract_tracks ENABLE ROW LEVEL SECURITY;

CREATE POLICY ct_contract_tracks_authread ON public.ct_contract_tracks
  FOR SELECT TO authenticated USING (true);

CREATE POLICY ct_contract_tracks_svcall ON public.ct_contract_tracks
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ct_contract_tracks IS
  'Lifetime tracking ledger for option-CONTRACT price evolution (mirror of ct_print_tracks but on the contract axis, not the underlying axis). Captures lottery-ticket multibaggers and theta-decay losers that underlying-axis grading misses. option_symbol synthesized at track creation from ticker+expiry+side+strike (UW stopped emitting it). Phase A: ct-print-grader populates entries. Phase B: ct-contract-poller updates current/peak/trough. Phase C: ct-contract-grader flips track_status.';

-- ---------------------------------------------------------------------------
-- ct_config seeds — DTE-bucket WIN thresholds (decimal fractions on the
-- contract axis: 0.50 = +50% peak premium move = WIN, 1.00 = +100% / 2x,
-- 2.00 = +200% / 3x), the loss threshold, and liquidity rails for the
-- Phase B poller (don't trust mids below a penny floor or with absurd
-- spreads). ON CONFLICT DO NOTHING so re-runs and operator-edited values
-- are never clobbered.
--
-- Naming convention mirrors print_grader keys (grade_threshold_<bucket>)
-- but namespaced under contract_grader category and prefixed
-- contract_grade_threshold_* / contract_loss_threshold_* /
-- contract_min_* / contract_max_* so a future config UI can list them
-- under one heading.
-- ---------------------------------------------------------------------------
INSERT INTO public.ct_config (key, value, description, category, min_value, max_value, default_value) VALUES
  ('contract_grade_threshold_0dte', '0.50'::jsonb,
    'Lifetime peak |contract-price move| threshold for WIN on 0DTE prints. Decimal fraction (0.50 = +50%).',
    'contract_grader', 0.0, 100.0, '0.50'::jsonb),
  ('contract_grade_threshold_short', '0.50'::jsonb,
    'Lifetime peak |contract-price move| threshold for WIN on short prints (1-7 DTE). Decimal fraction (0.50 = +50%).',
    'contract_grader', 0.0, 100.0, '0.50'::jsonb),
  ('contract_grade_threshold_mid', '1.00'::jsonb,
    'Lifetime peak |contract-price move| threshold for WIN on mid prints (8-30 DTE). Decimal fraction (1.00 = +100% / 2x).',
    'contract_grader', 0.0, 100.0, '1.00'::jsonb),
  ('contract_grade_threshold_long', '2.00'::jsonb,
    'Lifetime peak |contract-price move| threshold for WIN on long prints (30+ DTE). Decimal fraction (2.00 = +200% / 3x).',
    'contract_grader', 0.0, 100.0, '2.00'::jsonb),
  ('contract_loss_threshold_pct', '0.50'::jsonb,
    'Drawdown magnitude threshold for LOSS on any DTE bucket. Decimal fraction (0.50 = -50% from entry).',
    'contract_grader', 0.0, 1.0, '0.50'::jsonb),
  ('contract_min_mid_for_quote', '0.05'::jsonb,
    'Minimum acceptable contract mid (per-share) before a quote is considered usable. Quotes below this are dropped as penny noise.',
    'contract_grader', 0.0, 10.0, '0.05'::jsonb),
  ('contract_max_spread_pct', '0.30'::jsonb,
    'Maximum acceptable (ask-bid)/mid spread before a quote is considered too illiquid to trust. Decimal fraction (0.30 = 30%).',
    'contract_grader', 0.0, 10.0, '0.30'::jsonb)
ON CONFLICT (key) DO NOTHING;
