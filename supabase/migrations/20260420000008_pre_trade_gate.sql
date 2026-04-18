-- ============================================================================
-- Pre-trade compliance gate.
--
-- Extends ct_trade_audit with the full checklist the gate produced at commit
-- time, and seeds the `gate.*` config keys used by _shared/preTradeGate.ts.
--
-- The pre_trade_checks column is a snapshot of every check that ran (not just
-- the blockers) — post-mortem answers like "was concentration yellow when we
-- committed?" or "did the bias check skip for null-severity?" require the
-- full list. Schema shape per check:
--   {
--     name:    string,       -- stable machine id: kill_switch | drawdown_tier | ...
--     status:  'pass'|'warn'|'block',
--     detail:  string,       -- human-readable why, includes threshold cited
--     threshold_key?: string -- ct_config key cited by a block, when applicable
--   }
--
-- Historical rows (pre-gate) backfill to empty array so downstream readers
-- can always assume jsonb_array_length(pre_trade_checks) works.
-- ============================================================================

SET search_path = public, extensions;

ALTER TABLE ct_trade_audit
  ADD COLUMN IF NOT EXISTS pre_trade_checks jsonb;

-- Backfill pre-gate rows so every row has a non-null value. New rows written
-- by the gate include the real checklist; rows written before this migration
-- get an empty array.
UPDATE ct_trade_audit
   SET pre_trade_checks = '[]'::jsonb
 WHERE pre_trade_checks IS NULL;

COMMENT ON COLUMN ct_trade_audit.pre_trade_checks IS
  'Full pre-trade gate checklist at commit time. Array of {name,status,detail,threshold_key}. Empty array for rows written before the gate existed.';

-- Hot query: "show me every trade blocked by the gate on this session."
CREATE INDEX IF NOT EXISTS ct_trade_audit_gate_blocked
  ON ct_trade_audit ((pre_trade_checks IS NOT NULL))
  WHERE pre_trade_checks IS NOT NULL;

-- ============================================================================
-- Config seeds — gate.* keys. Hard-coded defaults inside preTradeGate.ts
-- match these, so a missing row never silently changes behavior.
-- ============================================================================
INSERT INTO ct_config (key, value, description, category, min_value, max_value, default_value) VALUES
  ('gate.bias_block_severity', '4'::jsonb,
    'Minimum ct_biases severity that blocks a trade on direction/instrument match. Set to 5 to only block on severity-5 biases.',
    'gate', 1, 5, '4'::jsonb),
  ('gate.uw_warn_pct', '90'::jsonb,
    'UW daily quota percent at which the gate raises a warn (does not block).',
    'gate', 50, 100, '90'::jsonb),
  ('gate.alert_cooldown_min', '60'::jsonb,
    'Cooldown window (minutes) for alert-driven trades: no other alert-sourced trade within this window.',
    'gate', 5, 240, '60'::jsonb),
  ('gate.session_open_warn_min', '5'::jsonb,
    'First N minutes after 9:30 ET in which the gate raises a whipsaw warn.',
    'gate', 0, 30, '5'::jsonb),
  ('gate.session_close_warn_min', '15'::jsonb,
    'Last N minutes before 16:00 ET in which the gate raises an EOD-pin warn.',
    'gate', 0, 60, '15'::jsonb)
ON CONFLICT (key) DO NOTHING;
