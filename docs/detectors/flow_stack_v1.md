# Flow Stack — Heatmap Concentration (`flow_stack_v1`)

- **Status:** shadow (per `ct_detectors`)
- **Source file:** `supabase/functions/ct-detector-flow-stack-v1/index.ts`
- **DTE class:** all
- **Live config row:** `SELECT * FROM ct_detectors WHERE id = 'flow_stack_v1'`

## What it sees

Reads the latest `ct_flow_heatmap_snapshots` cell per `(ticker, expiry_bucket_week)` and compares its `aggressive_directional_premium_decay` against a trailing 7d distribution of that **same ticker's cells across all its expiry buckets**. Per-ticker cross-bucket baseline — not per-bucket. Universe = `ct_config.watcher.watchlist` (10 tickers). No UW runtime call; pure read off the heatmap snapshot table the ingester already maintains.

## Math

Config keys on `ct_detectors.config`: `std_dev_threshold` (2.5), `baseline_window_days` (7), `min_baseline_samples` (50), `evaluation_window_minutes` (5), `dedupe_min` (60). Per ticker: pull every snapshot's metric within 7d (paginated, capped 20k samples), compute `mean` + sample `std` (n−1). Skip if `n<50` or `std<=0`. For each latest cell within the 5-minute eval window, `z = (value − mean) / std`. Fires when `|z| ≥ 2.5`. Direction is `bullish` when `z>0`, `bearish` when `z<0` (sign of z, not of value). Score = `clamp(round(|z|·10), 0, 100)`. Dedupe key: `${ticker}::stack::${expiry_bucket_week}` — synthetic `option_symbol` consumed by `recentlyAlarmed`.

## Regime fit

Concentration repricing: when premium suddenly piles into a single ticker × expiry bucket relative to that ticker's own recent norm. Captures "the tape just shifted" early-warning class on long-DTE positioning, where most other detectors (0DTE, opening-call, smart-money-repeat) don't reach. Cross-bucket baseline means a ticker with chronically active near-week buckets won't spam — only an actual outlier bucket relative to that ticker's own cell distribution clears the bar.

## False-positive shapes

Cross-bucket baseline **mixes regimes** — a ticker's ATM weekly cells and 2027 LEAP cells share one baseline. Bullish skew already visible in production (52 bullish / 12 bearish over first 64 fires) — likely an artifact of the metric being signed and the trailing window capturing a directional trend, not detector bias per se. Concentration in TSLA / QQQ / SPY (38 of 64 fires). Long-DTE buckets (2027-01-15, 2028-01-21, 2028-12-15) appearing in fires deserve grader-side scrutiny — those are the regime-mix candidates.

## Demote criteria

Composite `hr_v3` = **TBD** — `n_graded = 0` as of 2026-05-02 (64 lifetime fires, none yet through `ct_flag_grades`). Per Q1 thresholds the floor for shadow→trial is `n≥50`. Hold shadow until grader builds sample. Promotion gate: shadow→trial when `hr_v3_14d ≥ 0.55 ∧ n_14d ≥ 50`. Demote: live→decay if `hr_v3_14d < 0.30 ∧ n_14d ≥ 30`.

## Calibration history

- `87bebd6` 2026-04-30 — initial ship. Default thresholds (2.5σ / 7d / n≥50) seeded in same migration.
- Heatmap math infra it depends on: `a272157` / `6b4a4f9` (Phase 4-5 brain organ wiring), `d8b1eb8` (rewrite of `ct_flow_heatmap_history` RPC to scan `ct_flow_alerts` directly), `7844f86` (live RPC math + cell evolution chart). All 2026-04-30.
- `d9cce72` 2026-05-02 — DTE-bucketed contract-axis grader thresholds. Detector fires `dte_class=all`; verdict shifts expected on long-DTE subset (2027 / 2028 buckets observed in production).
- Memory: `~/.claude/projects/-Users-jameschellis/memory/project_co_trader_pickup_2026_05_01_session_watch.md` (lists this detector on the 5-min cadence watch).
