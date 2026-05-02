# 0DTE Put V/OI Extreme (`zerodte_put_voi_extreme_v1`)

- **Status:** shadow (per `ct_detectors`)
- **Source file:** `supabase/functions/ct-detector-zerodte-put-voi/index.ts`
- **DTE class:** 0dte
- **Live config row:** `SELECT * FROM ct_detectors WHERE id = 'zerodte_put_voi_extreme_v1'`
- **Calibration warning:** thesis text references "V/OI ≥ 20" but the live config row carries `min_voi_ratio = 5.0`. Config is truth (Q3 fire-rate audit confirmed 144 fires across 14d at 5.0 — actively firing, not idling). The "≥20" prose lingers from the original SPY 2026-04-23 anchor pattern and should be read as historical narrative, not threshold spec.

## What it sees

Per-print walk over `ct_flow_alerts` since the per-detector watermark, scoped to `ct_config.watcher.watchlist`. Filters to put-only on 0DTE expiries (calendar-day delta of `expiry` vs `ingested_at` UTC midnight = 0). For each surviving print computes `volume / open_interest` and fires a `ct_flags` alarm row (`source = 'detector_alarm'`, direction `bearish`) with 4-hour horizon, 1.5x contract target, 0.7x invalidation. Dedupes by OCC option symbol within `dedupe_min`.

## Math

- `min_voi_ratio` (live config) — V/OI ratio gate. Code default if config missing: 20.0. **Live value: 5.0.**
- `dedupe_min` — minutes of per-OCC-symbol dedupe. Live value: 60.
- 0DTE filter — calendar-day expiry delta = 0 against UTC-midnight-normalized ingest timestamp.
- Watchlist filter — `ct_config.watcher.watchlist` (Mag7 + QQQ + SPY + IWM).
- Page size 1000, scan limit 4000 per sweep (`PAGE_SIZE`, `SCAN_LIMIT` source-file constants — not in `ct_config`).

## Regime fit

Anchor pattern is the SPY-Thursday-massacre — 2026-04-23 SPY 0DTE puts hit V/OI 25-74x and paid 294-338%. 14d distribution is index-heavy: SPY 51% + QQQ 27% + TSLA 10% + IWM 6% = 78% of fires on indexes. ETF puts read structurally bearish but are the dominant hedging vehicle, so the detector is firing into a population where many puts are protective rather than directional. Likely fits real bearish conviction days (vol-expansion, breadth-flush) and mis-fires through hedge-flow chop.

## False-positive shapes

Directional unfiltered. Raw V/OI spike on its own is anti-signal without aggressor confirmation (per the source-file header comment: "raw V/OI alone is anti-signal"). Three classes seen in the n=39 grade pool:

1. **ETF hedge puts** — SPY/QQQ 0DTE puts bought as portfolio hedge against existing long book; underlying pins or rises while detector fires bearish.
2. **Late-tape liquidations** — 0DTE puts spiking V/OI from holders dumping into bid for theta exit; reads aggressive, isn't directional.
3. **Pin-magnet structural** — high-V/OI puts at known gamma walls magnet underlying instead of breaking it.

`directionInference` is not currently consulted (the detector hard-codes `direction: 'bearish'` from put-side). v2 should gate on aggressor confirmation.

## Demote criteria

**Composite hr_v3 = 29.5% on n=39 (7 win / 9 partial / 18 loss / 5 invalidated). Worst in portfolio. Strict win 17.9%.** Top of the spread (smart_money_repeat_v1) sits at 68.1% — this detector is ~38pp behind.

Per [`2026-05-02-detector-lifecycle-thresholds.md`](../decisions/2026-05-02-detector-lifecycle-thresholds.md): shadow → trial floor is `hr_v3 ≥ 0.30`. **At 0.295, this detector is 0.5pp below the promote threshold.** It is NOT cleared for trial. If it were live, it would be the only detector approaching demote-to-decay.

Recommendation: hold shadow indefinitely. If `hr_v3` stays below 0.30 over the next 30d (target n ≥ 60 for stability), retire — the loss-heavy outcome shape (18/39 = 46% loss) is a structural signal, not a sample-size artifact. v2 with aggressor filter is the only repair path; threshold-tweaking won't move a detector this far below the floor.

Phase D verify (commit `d9cce72`): the 0DTE-bucket regrade left 0DTE thresholds **unchanged** — this detector's labels did not shift. The 29.5% is its honest grade both pre- and post-rebucket.

## Calibration history

- `5141c31` 2026-04-26 — shipped as one of 5 shadow detectors for Monday open. Initial `min_voi_ratio = 20.0` (matches header doc).
- `3ce8be4` 2026-04-26 — cron stagger.
- `7d80831` — `source_flow_ids: null` fix (was passing UUID where `bigint[]` expected).
- `54224d1` — `target_price` + `invalidation_price` on every flag.
- Punch-list memory `1b1aad6` flagged "0DTE detectors miss money" — under-performance pre-dates the DTE-bucket regrade and is detector-class, not grading-class.
- Threshold drop from 20.0 → 5.0 happened in `ct_detectors` config row (not in source file — `min_voi_ratio` reads from JSONB at sweep time). Q3 fire-rate audit at 5.0 confirms current behavior.
