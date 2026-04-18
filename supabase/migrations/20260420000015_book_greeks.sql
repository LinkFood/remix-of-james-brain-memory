-- ct_book_greeks — book-level options Greeks aggregation, captured every 15min
-- by ct-book-manager (same tick as options live P&L, wave 23).
--
-- Why a separate table (vs. columns on ct_book):
--   ct_book is one row per session_date. Greeks move intraday as strikes,
--   expiries, and spot drift — we need a time-series, not a daily snapshot.
--   The standard quant tile is "how did my book delta move through the day,"
--   which requires per-capture rows.
--
-- Zero new UW calls: ct-book-manager already pulls /option-contracts per
-- ticker with open options (wave 23). Greeks ride along in the same chain
-- row — we aggregate here, don't re-fetch.
--
-- Aggregation formula (per greek):
--   position_greek = row.greeks.<greek> * contracts * 100 * side_sign
--     where side_sign = +1 for long, -1 for short
--   total_<greek>  = SUM(position_greek) across all open option trades
--
-- The 100 multiplier converts per-share greeks to per-contract ($-denominated
-- for delta/gamma in shares-equivalent, $/day for theta, etc. under standard
-- quant convention).
--
-- metadata holds the per-position breakdown so the UI can drill in
-- ("which trade contributes most delta?") without a second query.
--
-- No session aggregation/rollup — Book.tsx fetches the latest row + a 24h
-- history window for the chart. Index supports both (session_date DESC +
-- captured_at DESC).

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- Table
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_book_greeks (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  captured_at          timestamptz NOT NULL DEFAULT now(),
  session_date         date        NOT NULL,
  total_delta          numeric     NOT NULL DEFAULT 0,
  total_gamma          numeric     NOT NULL DEFAULT 0,
  total_vega           numeric     NOT NULL DEFAULT 0,
  total_theta          numeric     NOT NULL DEFAULT 0,
  total_rho            numeric     NOT NULL DEFAULT 0,
  open_options_count   int         NOT NULL DEFAULT 0,
  unique_tickers       text[]      NOT NULL DEFAULT ARRAY[]::text[],
  metadata             jsonb       NOT NULL DEFAULT '{}'::jsonb
);

-- Latest-first lookup: "give me the most recent row for today" AND
-- "give me the last 24h of captures ordered chronologically."
CREATE INDEX IF NOT EXISTS ct_book_greeks_session_captured_desc
  ON ct_book_greeks (session_date DESC, captured_at DESC);

-- -----------------------------------------------------------------------------
-- RLS — authenticated read, service role full
-- -----------------------------------------------------------------------------
ALTER TABLE ct_book_greeks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ct_book_greeks_read ON ct_book_greeks;
DROP POLICY IF EXISTS ct_book_greeks_svc  ON ct_book_greeks;

CREATE POLICY ct_book_greeks_read
  ON ct_book_greeks FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY ct_book_greeks_svc
  ON ct_book_greeks FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

GRANT SELECT ON ct_book_greeks TO authenticated;
GRANT ALL    ON ct_book_greeks TO service_role;

COMMENT ON TABLE ct_book_greeks IS
  'Book-level Greeks time series. Written every 15min by ct-book-manager during market hours when ≥1 open option position exists. Zero-options ticks are skipped to avoid row spam.';
COMMENT ON COLUMN ct_book_greeks.total_delta IS
  'Sum of (contract.delta * contracts * 100 * side_sign) across all open options. Shares-equivalent exposure.';
COMMENT ON COLUMN ct_book_greeks.total_theta IS
  'Sum of (contract.theta * contracts * 100 * side_sign). $/day decay (negative for net-long books).';
COMMENT ON COLUMN ct_book_greeks.metadata IS
  'jsonb per-position breakdown: { positions: [{ trade_id, instrument, type, strike, expiry, contracts, side, greeks: {...}, contributions: {delta, gamma, theta, vega, rho} }], missing_greeks_count, book_equity_snapshot }';
