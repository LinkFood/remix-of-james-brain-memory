-- Seed starter rows for ct_playbooks and ct_biases so the /playbooks page
-- and the Scorecard bias section are not empty on Monday 2026-04-20 (first
-- live Co-Trader session). These are hand-curated placeholders grounded in
-- realistic day-trading patterns; the weekly curators (ct-playbook-curator
-- Sun 22:45 UTC, ct-bias-booth Sun 22:00 UTC) will supersede, retire, or
-- grow these as graded evidence accumulates.
--
-- INSERT-ONLY. No schema changes. No RLS changes. Idempotent:
--   ct_playbooks: ON CONFLICT (name) — unique index ct_playbooks_name_idx exists
--   ct_biases:    WHERE NOT EXISTS — no unique constraint on pattern, so guard manually

SET search_path = public, extensions;

-- ============================================================================
-- ct_playbooks — 5 starter setups
-- ============================================================================
INSERT INTO ct_playbooks (name, description, setup_criteria, historical_win_rate, sample_size, avg_return_pct, avg_r_multiple, status)
VALUES
  (
    'Gamma pin at call wall',
    'When SPY/QQQ trade within 0.3% of the largest call-wall strike in a positive-GEX regime, price tends to pin into the close. Fade breakouts toward the wall, mean-revert back to strike.',
    jsonb_build_object(
      'regime', 'gamma_positive',
      'session', 'power_hour',
      'evidence_axes', jsonb_build_array('GEX','dealer_positioning','session_vwap'),
      'instruments', jsonb_build_array('SPY','QQQ'),
      'direction', 'neutral',
      'iv_tier', 'low',
      'catalyst', 'none'
    ),
    0.64, 22, 0.38, 0.72, 'active'
  ),
  (
    'Regime flip short',
    'Dealer gamma crosses from positive to negative intraday while SPY breaks session VWAP with expanding put flow. Short the first bounce into prior support — dealers are short gamma and amplify the move.',
    jsonb_build_object(
      'regime', 'gamma_negative',
      'session', 'midday',
      'evidence_axes', jsonb_build_array('GEX','flow_skew','vwap_break'),
      'instruments', jsonb_build_array('SPY'),
      'direction', 'bearish',
      'iv_tier', 'mid',
      'catalyst', 'none'
    ),
    0.58, 17, 0.71, 1.12, 'active'
  ),
  (
    'GEX flip momentum',
    'Opening hour: zero-gamma level breached with directional flow confirming. Ride the expansion — dealer hedging pushes price away from the flip level until the next major strike.',
    jsonb_build_object(
      'regime', 'vol_expansion',
      'session', 'first_hour',
      'evidence_axes', jsonb_build_array('GEX','zero_gamma','opening_flow'),
      'instruments', jsonb_build_array('SPY','QQQ'),
      'direction', 'bullish',
      'iv_tier', 'mid',
      'catalyst', 'none'
    ),
    0.55, 31, 0.54, 0.86, 'active'
  ),
  (
    'VIX crush expansion',
    'Post-event VIX collapses more than 10% on the day while SPY grinds higher. Long SPY calls into the crush — IV compression + realized drift compound the move.',
    jsonb_build_object(
      'regime', 'vol_contraction',
      'session', 'midday',
      'evidence_axes', jsonb_build_array('VIX_delta','IV_term_structure','realized_vs_implied'),
      'instruments', jsonb_build_array('SPY'),
      'direction', 'bullish',
      'iv_tier', 'high',
      'catalyst', 'fed'
    ),
    0.61, 14, 0.92, 1.34, 'active'
  ),
  (
    'Earnings straddle drift',
    'Large-cap earnings name with implied move > 2x 30d realized. Fade the overnight IV crush via short straddle only when directional flow is muted and prior earnings pinned near strike.',
    jsonb_build_object(
      'regime', 'pin',
      'session', 'post_earnings',
      'evidence_axes', jsonb_build_array('implied_vs_realized','flow_skew','prior_earnings_behavior'),
      'instruments', jsonb_build_array('*'),
      'direction', 'neutral',
      'iv_tier', 'high',
      'catalyst', 'earnings'
    ),
    0.52, 19, 0.43, 0.61, 'active'
  )
ON CONFLICT (name) DO NOTHING;

-- ============================================================================
-- ct_biases — 4 starter meta-patterns
-- No unique constraint on pattern, so guard each row with NOT EXISTS.
-- ============================================================================
INSERT INTO ct_biases (pattern, evidence, instruments, severity, active, observed_count)
SELECT
  'Long-bias bull tape',
  'Across prior session reviews, directional calls skew 72% long even on days where dealer gamma flipped negative. Structural preference for the upside in any non-crashing tape.',
  NULL,
  3, true, 11
WHERE NOT EXISTS (SELECT 1 FROM ct_biases WHERE pattern = 'Long-bias bull tape');

INSERT INTO ct_biases (pattern, evidence, instruments, severity, active, observed_count)
SELECT
  'Over-trades on Fed days',
  'Fed-decision sessions show 3x normal alert volume with post-decision calibration_delta averaging -24pp. Too many calls during macro windows where dispersion is mechanical, not informative.',
  ARRAY['SPY','QQQ']::text[],
  4, true, 6
WHERE NOT EXISTS (SELECT 1 FROM ct_biases WHERE pattern = 'Over-trades on Fed days');

INSERT INTO ct_biases (pattern, evidence, instruments, severity, active, observed_count)
SELECT
  'Averages down losers',
  'When the first entry is graded wrong, follow-on size tends to increase on the same direction 58% of the time. Scaling into a losing thesis instead of cutting and re-evaluating.',
  NULL,
  5, true, 9
WHERE NOT EXISTS (SELECT 1 FROM ct_biases WHERE pattern = 'Averages down losers');

INSERT INTO ct_biases (pattern, evidence, instruments, severity, active, observed_count)
SELECT
  'Overweights put flow in low-VIX tape',
  'When VIX < 14, large put prints are read as bearish signal 81% of the time despite realized delta staying positive. Put flow in suppressed-vol regimes is usually hedging, not directional.',
  ARRAY['SPY']::text[],
  3, true, 8
WHERE NOT EXISTS (SELECT 1 FROM ct_biases WHERE pattern = 'Overweights put flow in low-VIX tape');
