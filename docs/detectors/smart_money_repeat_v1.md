# Smart Money Repeat (`smart_money_repeat_v1`)

- **Status:** shadow (per `ct_detectors`)
- **Source file:** `supabase/functions/ct-detector-smart-money-repeat/index.ts`
- **DTE class:** non_0dte
- **Live config row:** `SELECT * FROM ct_detectors WHERE id = 'smart_money_repeat_v1';`

## What it sees

Walks `ct_flow_alerts` since the per-detector watermark in `ct_detector_state`. For every OTM **call** print on the watchlist, asks: how many prints landed on this exact `(ticker, expiry, side, strike)` tuple in the trailing window? When the count clears `min_prints`, fires a `detector_alarm` row into `ct_flags` with the OCC option_symbol as the dedupe key. Reads spot from `underlying_price` to enforce strict OTM, and skips same-day expiries to keep this detector clean of 0DTE chase patterns.

## Math

Config keys on the `ct_detectors.config` JSONB:
- `min_prints = 3` — count of prints on the same contract that triggers a fire
- `window_min = 180` — trailing minutes counted toward `min_prints`
- `side_filter = "call_otm_only"` — call side, strike strictly above spot
- `dedupe_min = 60` — minutes a given option_symbol stays muted after firing

Direction is hardcoded `bullish` (OTM call accumulation). Horizon is 4h, target = entry × 1.5, invalidation = entry × 0.7 — the scoring axis the grader uses to call win/partial/loss.

## Regime fit

Multi-day accumulation. Pattern is the AMZN $260C class — same exact contract stacked Tue → Wed → Thu by smart money plus paper chasers. `dte_class='non_0dte'` excludes the 0DTE chase regime explicitly, so this never overlaps with `zerodte_opening_call_v1`. Last 30d distribution is broad-based: NVDA 93, QQQ 54, TSLA 49, SPY 47, AMZN 39, MSFT 34, AAPL 30, GOOGL 29, META 14, IWM 3 — all 10 watchlist tickers fire, no single-name dependence.

## False-positive shapes

- Paper chasers stacking the same contract without a smart-money origin print
- HFT auto-pinging the same contract at sub-second cadence (currently no aggressor filter)
- Position rolls disguised as accumulation when the same desk closes one strike and opens another at the next expiry
- Mid-prints inflating the count (`directionInference` not consulted on this detector — count is raw)

## Demote criteria

Per [lifecycle thresholds](../decisions/2026-05-02-detector-lifecycle-thresholds.md), composite hr_v3 = `(wins + 0.5*partials) / n`. Live → decay would trigger if `hr_v3_14d < 0.30` with `n_14d ≥ 30`. Currently top of the entire portfolio at **hr_v3 = 68.1% with n = 105** (49 win / 45 partial / 9 loss / 2 invalidated_early), so demotion is not a near-term risk.

Shadow → trial qualifies today (n ≥ 50 ∧ hr_v3 ≥ 0.30). Trial → live still needs n ≥ 150 — currently ~45 fires short.

## Calibration history

- `5141c31` (2026-04-26) — initial ship, 5-detector portfolio batch. Backfit-corpus thresholds locked from forensic against canonical week 2026-04-20 → 24.
- `7d80831` — `source_flow_ids` fix (was passing UUID where bigint[] expected).
- `54224d1` — added `target_price` + `invalidation_price` to every flag insert; this is what makes the contract-axis grading legible.
- Memory archeology: corpus baseline lives in `~/.claude/projects/-Users-jameschellis/memory/project_co_trader_canonical_corpus_2026_04_20_to_24.md` and `project_co_trader_detector_portfolio_shipped_2026_04_26.md`. Pre-grading-axis-fix corpus reading was 39% hit rate / 320 catches / 26% of all winners — measured against print-track outcomes, NOT contract-axis. Current 68.1% hr_v3 reflects the post-fix grader running against contract-axis outcomes (commits in `ct-flag-grader/` that landed late April). The two numbers are not directly comparable; the 68% is the live source of truth for lifecycle decisions, the 39% is the pre-fix archeology baseline.
