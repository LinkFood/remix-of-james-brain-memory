-- ============================================================================
-- Co-Trader Trade Setups: concrete strike-level setups on every FLAG (conv ≥3)
-- and ALERT. Claude stops outputting pure directional bias and starts
-- committing to a specific play with entry/stop/target/size.
-- ============================================================================
-- Shape (documented here, validated nowhere — trust-pass from Claude):
-- {
--   instrument: string,                // "SPY"
--   strategy: "long_call" | "long_put" | "short_call" | "short_put"
--             | "spread" | "iron_condor" | "other",
--   strike: number,
--   expiry: string (YYYY-MM-DD),
--   dte: number,
--   type: "call" | "put",
--   entry_condition: string,           // "short on break of 541.00"
--   entry_level: number | null,        // 541.00
--   stop_condition: string,            // "above 543.00"
--   stop_level: number | null,         // 543.00
--   target_level: number | null,       // 537.00
--   target_rationale: string,          // "first put wall"
--   size_r: number,                    // 0.5 (units of R, conviction-weighted)
--   max_pain_anchor: number | null,    // reference strike from max pain if any
--   rationale: string,                 // 2-3 sentences why
--   caveats: string | null             // "low sample — first flag today"
-- }
-- ============================================================================

SET search_path = public, extensions;

ALTER TABLE ct_flags  ADD COLUMN IF NOT EXISTS trade_setup jsonb;
ALTER TABLE ct_alerts ADD COLUMN IF NOT EXISTS trade_setup jsonb;

COMMENT ON COLUMN ct_flags.trade_setup IS
  'Concrete trade setup Claude proposes alongside this flag: instrument, strategy, strike, expiry, dte, type, entry/stop/target levels + conditions, size_r, rationale, caveats. Nullable — pre-v23 rows + low-conviction flags stay null.';
COMMENT ON COLUMN ct_alerts.trade_setup IS
  'Concrete trade setup Claude proposes alongside this alert. Same shape as ct_flags.trade_setup.';

-- Partial indexes for "active setups" queries — horizon_end in the future,
-- ungraded, setup present. These are the rows the frontend pulls.
CREATE INDEX IF NOT EXISTS ct_flags_active_trade_setup_idx
  ON ct_flags (horizon_end DESC)
  WHERE grade_id IS NULL AND trade_setup IS NOT NULL;

CREATE INDEX IF NOT EXISTS ct_alerts_active_trade_setup_idx
  ON ct_alerts (horizon_end DESC)
  WHERE grade_id IS NULL AND trade_setup IS NOT NULL;
