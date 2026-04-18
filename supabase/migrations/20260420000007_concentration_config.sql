-- Concentration limits — hedge-fund discipline on the $10k paper book.
--
-- Four tunable caps, all enforced at trade-commit time by the
-- _shared/concentration.ts helper:
--
--   concentration.max_ticker_pct            — no single ticker > X% of book
--   concentration.max_theme_pct             — no single thesis_theme > X%
--   concentration.max_direction_pct         — max X% long OR short at once
--   concentration.max_concurrent_options_trades — hard cap on open options
--
-- Breaching any limit REJECTS the new trade (commit is aborted, Slack
-- notifies). It does NOT force-close existing positions. The live book can
-- exceed a limit briefly if a limit is lowered — only NEW trades are gated.
--
-- Options sizing: options rows store size_pct=0 because the RPC accounts
-- on premium. For the ticker-cap check we use size_usd / book_equity * 100
-- so options still count against ticker concentration.
--
-- All defaults match the seeds in the new INSERT below. Changes via
-- /ct-settings propagate in 60s via configCache.ts.

SET search_path = public, extensions;

INSERT INTO ct_config (key, value, description, category, min_value, max_value, default_value) VALUES
  ('concentration.max_ticker_pct', '40'::jsonb,
    'Reject a new trade if it would push any single ticker above X% of book.',
    'concentration', 5, 100, '40'::jsonb),
  ('concentration.max_theme_pct', '60'::jsonb,
    'Reject a new trade if it would push any single thesis_theme above X% of book.',
    'concentration', 10, 100, '60'::jsonb),
  ('concentration.max_direction_pct', '80'::jsonb,
    'Reject a new trade if it would push total long OR total short exposure above X% of book.',
    'concentration', 20, 100, '80'::jsonb),
  ('concentration.max_concurrent_options_trades', '2'::jsonb,
    'Hard cap on the number of open options positions (call+put) at once.',
    'concentration', 0, 10, '2'::jsonb)
ON CONFLICT (key) DO NOTHING;
