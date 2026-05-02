# Whale Detector (`whale_v1`)

- **Status:** shadow (per `ct_detectors`)
- **Source file:** `supabase/functions/ct-detector-whale/index.ts`
- **DTE class:** all
- **Live config row:** `SELECT * FROM ct_detectors WHERE id = 'whale_v1'`

## What it sees

Single rows in `ct_flow_alerts` since the per-detector watermark in `ct_detector_state`. Pure-data detector — no aggregation, no clustering, no regime context. Fires once per qualifying print whose `premium` clears the threshold and whose `option_symbol` hasn't already alarmed within `dedupe_min`. Direction is inferred crudely: call → bullish, put → bearish (refinement is the unusual_oi / cluster / signature jobs). Watermark is windowed by `ingested_at` (UW stopped emitting `executed_at`).

## Math

- `config.min_premium` (default `$250,000`) — single-print premium floor.
- `config.dedupe_min` (default `30 min`) — per `option_symbol` cooldown via `recentlyAlarmed()`.
- Watchlist gate: `ct_config.watcher.watchlist` (10-ticker universe).
- Flag horizon: 4 h. `target_price = entry × 1.5`, `invalidation_price = entry × 0.7`.

## Regime fit

TBD — needs calibration history. Thesis target: vol spikes and institutional one-shot directional bets where a single large premium beats the noise floor. Likely degrades in mechanical-hedging regimes (broad vol expansion → many large prints are non-directional).

## False-positive shapes

Dealer-side blocks misread as directional. Tail-risk insurance puts (large premium, low conviction). Earnings-week vol selling. Roll-driven prints where one leg of a multi-leg trade clears the threshold solo. No aggressor inference — direction is purely call/put.

## Demote criteria

Composite hit-rate `hr_v3 = 45.8%` at `n = 143` (per Phase A audit). Currently shadow. Per Q1 lifecycle thresholds: shadow → trial gate (`n ≥ 50 ∧ hr_v3 ≥ 0.30`) **qualifies**; trial → live gate (`n ≥ 150 ∧ hr_v3 ≥ 0.40`) **n is just below the 150 floor — sample-size buffer**. Demote rule once promoted: `live → decay` if `hr_v3_14d < 0.30 ∧ n_14d ≥ 30`.

## Calibration history

- `523eaf2` 2026-04-25 — initial ship as one of three pure-data detectors (whale, unusual-OI, QQQ-IWM pair). `min_premium=$250k`, `dedupe_min=30`. No subsequent threshold tuning.
- `7d80831` — `source_flow_ids` null fix (bigint[] vs UUID), no math change.
- `54224d1` — `target_price` / `invalidation_price` populated on every flag, no math change.
- Memory: `~/.claude/projects/-Users-jameschellis/memory/project_co_trader_detector_portfolio_shipped_2026_04_26.md`, `project_co_trader_intelligence_amplifier_2026_04_25.md`.
