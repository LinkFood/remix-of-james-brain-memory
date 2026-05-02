# 0DTE Opening Hour Ask-Call (`zerodte_opening_call_v1`)

- **Status:** shadow (per ct_detectors)
- **Source file:** `supabase/functions/ct-detector-zerodte-opening-call/index.ts`
- **DTE class:** 0dte
- **Live config row:** `SELECT * FROM ct_detectors WHERE id = 'zerodte_opening_call_v1'`

## What it sees

Same-day-expiry call prints in `ct_flow_alerts` since the per-detector watermark, filtered to the configured opening-hour ET window and aggressive-ask classification. Walks paged scans (1k page / 4k cap) on the watchlist universe; dedupes per OCC option symbol. Direction is derived via canonical `inferDirection` — never trusts raw `is_ask`/`is_bid` (`feedback_uw_is_ask_bid_never_set.md`). Only `source === 'aggressive_ask_call'` survives.

## Math

Three live config keys: `hour_et_min`, `hour_et_max`, `dedupe_min`. Code defaults are `9` / `10` / `60`; current live row admits **`hour_et_min=9`, `hour_et_max=12`, `dedupe_min=60`**. Note: thesis text says 9-10am ET, config admits up through noon — config is truth. Hour-of-day derives from ingest UTC minus 4 (EDT through 2026-11-01). DTE = floor((expiry UTC midnight − ingest UTC midnight) / 86400000); requires `dte === 0`. Fires bullish flag with 4h horizon, contract target `entry × 1.5`, invalidation `entry × 0.7`.

## Regime fit

Friday-dominant, Wednesday-secondary (65% Wed hit per detector thesis row). Opening-hour momentum into close — built for the 2026-04-25 9:32am NVDA 0DTE bonanza class. 54% baseline hit rate, 129 fires / 5d, avg winner peak +154%, 2.43x lift on canonical corpus 2026-04-20→24 (`project_co_trader_canonical_corpus_2026_04_20_to_24.md`).

## False-positive shapes

Late-morning chop drift once the opening impulse fails (bigger risk now that `hour_et_max=12` admits noon prints). Dealer rolling on the 9 names with Mon/Wed expiries. RepeatedHits prints landing without aggressor flag get filtered by `inferDirection` — but mis-mapped RepeatedHits remains the systemic risk class (`feedback_direction_inference_repeatedhits_put_inverted.md`, calls side).

## Demote criteria

Composite `hr_v3 = 55.0%` with `n=40` (Q1 analysis, under shadow→trial floor of n≥50). Per Q1 thresholds, hold shadow until `n≥50`. Shadow→trial requires `n≥50 ∧ hr_v3≥0.50`; trial→live requires `n≥150 ∧ hr_v3≥0.40`. Phase D verify (commit `d9cce72`): under new contract-axis bucketing, **0DTE thresholds UNCHANGED at 50%/30%** — labels did not shift for this detector.

## Calibration history

- `5141c31` (2026-04-26) — initial ship, 5-detector portfolio for Monday open.
- `7d80831` — `source_flow_ids` null fix (bigint[] schema mismatch).
- `54224d1` — universal `target_price` + `invalidation_price` on every flag.
- `3ce8be4` — cron stagger.
- Calibration baseline: corpus 2026-04-20→24. Pre-DTE-bucket grader applied until 2026-05-02; under new contract-axis bucketing 0DTE keeps 50%/30% — no label shift.
