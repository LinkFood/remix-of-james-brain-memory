# Unusual OI (`unusual_oi_v1`)

- **Status:** shadow
- **Source file:** `supabase/functions/ct-detector-unusual-oi/index.ts`
- **DTE class:** all
- **Live config row:** `SELECT * FROM ct_detectors WHERE id = 'unusual_oi_v1'`

## What it sees

Walks `ct_flow_alerts` since the per-detector watermark (paged 1000 × 4, watchlist-filtered). Reads only `volume`, `open_interest`, `side`, `strike`, `expiry`, `price`. No price bars, no Pulse, no specialist context — pure per-print net-new-positioning math against the strike's standing OI.

## Math

For each alert: `ratio = volume / open_interest`. Fire if `oi > 0` AND `volume ≥ min_volume` AND `ratio ≥ min_ratio`. The `oi > 0` guard kills the "1 contract / 0 OI = infinity" trap on illiquid strikes (brand-new strike is structurally a different detector class). Per-`option_symbol` OCC dedupe via `recentlyAlarmed()` over `dedupe_min` minutes. Direction = `call → bullish`, `put → bearish` (no inference layer; raw side mapping). Horizon 4h, contract-axis target = entry × 1.5, invalidation = entry × 0.7. Tunable dials live on `ct_detectors.config`:

- `min_ratio` (default 5.0)
- `min_volume` (default 100)
- `dedupe_min` (default 30)

Code falls back to those defaults if the JSONB key is missing.

## Regime fit

TBD pending calibration archeology. Live data so far (1003 fires across 5 trading days, 2026-04-27 → 2026-05-01) shows the detector concentrating on index ETFs (SPY 371, QQQ 235, TSLA 153) with near-balanced direction (bullish 540 / bearish 463) and a 0–7 DTE bias (415 1-7DTE + 320 0DTE = 73% of fires). Trending_up Pulse regime tagging exists on flag rows for downstream stacking but isn't part of the trigger.

## False-positive shapes

Observed and structural:

- **Index OI churn at week-of-expiry.** SPY/QQQ 1-7DTE dominates the fire mix; many trips are dealer rebalancing into expiry, not directional conviction.
- **Repeated 5x trips on the same strike inside 30 min** — dedupe key is `option_symbol`, so cross-strike clusters on the same ticker don't dedupe each other.
- **Raw side → direction mapping** ignores aggressor (`is_ask`/`is_bid`). A heavy ask-side put hit and a heavy bid-side put hit both stamp `bearish`; no `inferDirection()` pass. Direction noise on puts is the structurally weakest seam (cf. `feedback_direction_inference_repeatedhits_put_inverted.md`).
- **Slack toggle is effectively off** in shadow status — only 3 of 1003 fires Slacked. Trust is graded silently by `ct_flag_grades`.

## Demote criteria

Per `docs/decisions/2026-05-02-detector-lifecycle-thresholds.md`. Composite hit-rate `hr_v3 = (wins + 0.5×partials)/n`. Current sample: **n=320, hr_v3 = 42.8%** (59W / 155P / 72L / 34inv). Lifecycle rules:

- **Demote to decay** if `hr_v3_14d < 0.30 ∧ n_14d ≥ 30`.
- **Demote to retire** if `hr_v3_30d < 0.25 ∧ n_30d ≥ 50`.
- Promotion path under the same doc: shadow → trial → **live** is auto-recommended (n=320 ≥ 150, hr_v3 ≥ 0.40), pending James's pull-the-trigger after the dry-run window.

## Calibration history

- commit `523eaf2` 2026-04-25 — initial ship as one of three pure-data detectors (whale, unusual-OI, QQQ-IWM pair). Defaults `min_ratio=5.0 / min_volume=100 / dedupe_min=30` set in code and seeded into `ct_detectors.config`.
- commit `7d80831` 2026-04-26 — bigint fix: `source_flow_ids` was passing UUID into a `BIGINT[]` column, silently dropping every flag. Confirmed firing post-fix per `project_co_trader_morning_ops_checklist.md` (134 fires in first day after the fix landed).
- commit `54224d1` 2026-04-?? — added `target_price` + `invalidation_price` (contract-axis 1.5× / 0.7×) to every detector flag. Affects unusual_oi_v1 grading axis.
- No threshold tunings since ship. `min_ratio = 5.0` is the original-and-current dial.
