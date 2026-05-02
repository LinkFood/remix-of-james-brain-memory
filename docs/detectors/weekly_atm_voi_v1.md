# Weekly ATM V/OI (`weekly_atm_voi_v1`)

- **Status:** shadow (per `ct_detectors`)
- **Source file:** `supabase/functions/ct-detector-weekly-atm-voi/index.ts`
- **DTE class:** non_0dte
- **Live config row:** `SELECT * FROM ct_detectors WHERE id = 'weekly_atm_voi_v1';`

## What it sees

Walks `ct_flow_alerts` since the per-detector watermark in `ct_detector_state`. For every print on the watchlist, asks three questions: is the contract weekly (1-7 calendar DTE), is the strike inside ±0.5% of the spot in `underlying_price`, and is `volume / open_interest ≥ 1.0`? When all three hold, fires a `detector_alarm` row into `ct_flags` with the OCC option_symbol as the dedupe key. Both call (bullish) and put (bearish) sides are eligible — direction is read off the side, not inferred.

## Math

Config keys on the `ct_detectors.config` JSONB:
- `dte_min = 1`, `dte_max = 7` — weekly window in calendar days, inclusive
- `strike_band_pct = 0.005` — ATM band as `|strike - underlying| / underlying ≤ 0.5%`
- `min_voi_ratio = 1.0` — `volume / open_interest` floor
- `dedupe_min = 60` — minutes a given option_symbol stays muted after firing

DTE is computed from `ingested_at` normalized to UTC midnight against `expiry` at UTC midnight. Horizon 4h target = entry × 1.5, invalidation = entry × 0.7 on the contract axis — same grading shape as the other portfolio detectors.

## Regime fit

All-regime per the canonical-corpus thesis. The three discriminators (weekly DTE, ATM, V/OI ≥ 1) all held 5/5 days on the 2026-04-20 → 24 forensic week, with weekly-DTE alone delivering 2.2x-32x lift across the per-day breakdown. Combined backtest on that corpus: 33% hit rate vs 22% base = 1.49x lift over 673 fires / 224 catches. Last 30d live distribution is index-heavy: SPY 137, QQQ 83, TSLA 38, NVDA 34, MSFT 20, AAPL 16, GOOGL 15, AMZN 13, META 10, IWM 4 — all 10 watchlist tickers represented, but SPY+QQQ are 59% of fires, which makes index-vehicle behavior the dominant regime.

## False-positive shapes

- Friday-pin chop near close — weekly ATM V/OI inflates as 0DTE-adjacent behavior leaks into 1DTE prints on Thursdays
- Dealer rolls and gamma-hedge prints showing up as fresh V/OI when they're really delta-neutral
- Mid-prints — `directionInference` is not consulted; the call/put side is taken at face value
- High-OI ATM contracts on event days where V/OI ≥ 1 is the baseline state, not a signal

## Demote criteria

Per [lifecycle thresholds](../decisions/2026-05-02-detector-lifecycle-thresholds.md), composite `hr_v3 = (wins + 0.5*partials) / n`. Current grader read: **hr_v3 = 62.5% with n = 12** despite **370 lifetime fires** — most haven't graded yet, or the grader hasn't drained backlog on this detector. With 370 fires queued and Track A's grader-lifecycle work landing tonight, n should clear the shadow → trial gate (n ≥ 50 ∧ hr_v3 ≥ 0.30) within a week. Live → decay would trigger if `hr_v3_14d < 0.30` with `n_14d ≥ 30`.

## Calibration history

- `5141c31` (2026-04-26) — initial ship, 5-detector portfolio batch. Thresholds backfit from forensic on canonical week 2026-04-20 → 24.
- `3ce8be4` — pre-Monday hardening, lane stagger across the new detectors so they don't all trample the same minute.
- `7d80831` — `source_flow_ids` fix (UUID → bigint[] mismatch).
- `54224d1` — `target_price` + `invalidation_price` populated on every flag insert; precondition for contract-axis grading.
- Memory archeology: per-day lift table (2.2x-32x weekly-DTE discriminator across 5/5 days) lives in the thesis text of `~/.claude/projects/-Users-jameschellis/memory/project_co_trader_canonical_corpus_2026_04_20_to_24.md`, not in code or migrations.
- DTE-bucket grader (`d9cce72`): non_0dte detector; fires hit the 1-7 DTE bucket which had the 4-14d threshold pulled 50% → 40% (1-3d held at 50%). Re-grade verdict shifts expected on the 4-7 DTE subset of the 370-fire backlog.
