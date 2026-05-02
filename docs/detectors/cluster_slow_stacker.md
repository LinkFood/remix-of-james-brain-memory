# Slow Stacker (`cluster_slow_stacker`)

- **Status:** trial (per `ct_detectors`)
- **Source file:** `supabase/functions/ct-signature-watcher/index.ts` — config-driven via the `ct_detectors` row, not a standalone function. The cluster loop at ~line 390 calls `loadActiveDetectors(supabase, 'cluster_')` and runs every non-retired `cluster_*` row through `toClusterDetector` (lines 709-729), which reads `config.window_min`, `config.min_prints`, `config.strike_band_pct`, `config.min_unanimity_pct` off the row. Each match writes its own `ct_flags` row stamped with `detector_id`. Adding a new cluster variant is an `INSERT INTO ct_detectors`, not a code change (Tenet 25).
- **DTE class:** all
- **Live config row:** `SELECT * FROM ct_detectors WHERE id = 'cluster_slow_stacker'`

## What it sees

The same `ct_flow_alerts` page-walk as `signature_v1` (watermark + watchlist gated). Each alert is checked against a rolling window of prior prints on the **same option_symbol family** (within `strike_band_pct` of strike) within `window_min` minutes. If `≥ min_prints` aligned prints accumulate and ≥ `min_unanimity_pct` of them point the same direction (per `inferDirection`), the cluster fires. Pulse-at-fire-time captured per Tenet 9.

## Math

Live config (as of 2026-05-01): `window_min=15`, `min_prints=5`, `strike_band_pct=0.03`, `min_unanimity_pct=0.75`. Wider window than `cluster_default` (5min/3prints/2%/80%) — explicitly tuned for slow-burn institutional accumulation rather than fast burst. Higher print floor (5 vs 3) and looser unanimity floor (75% vs 80%) shift the detector toward longer accumulation patterns where one or two reverse prints are tolerable inside a dominant direction.

## Regime fit

Born from the Friday 2026-04-24 backtest forensic — 42 winners caught with **+160% avg cluster peak** ([thesis text in `ct_detectors.thesis`](#)). Best fit: grinding institutional accumulation on liquid tape. 30d distribution (n=181 fires since 2026-04-25): QQQ 63, NVDA 61, AMZN 20, SPY 17, GOOGL 10, TSLA 5, MSFT 4, IWM 1. **All 181 directions bullish** — open question whether the loosened unanimity is biasing toward call clusters or whether ask-call repeated-hits dominate the watchlist's slow-stack regime; flag for next forensic.

## False-positive shapes

- **Multi-day drift across earnings move** — 15min window can chain prints from morning impulse into post-earnings drift, triggering a "cluster" that's really two separate flows.
- **Stale-cluster re-trigger** — same option family ringing the bell repeatedly inside the dedupe window for prints that aren't fresh accumulation. Watch the (option_symbol, direction, minute) Slack-dedup (commit `e5c5f11`) which fires on top score, not first arrival.
- **Mid-prints inflating the count** — `inferDirection` on neutral mid-prints can map to either direction unpredictably; 5-print floor doesn't fully insulate against this when the underlying tape is choppy.
- **Bullish bias** (open) — see Regime fit. Possibly an inference asymmetry, possibly real regime shape, possibly small-n.

## Demote criteria

Composite `hr_v3 = wins + 0.5 × partials = 52.3%` on `n=43` graded flags ([Q1 lifecycle analysis](../decisions/2026-05-02-detector-lifecycle-thresholds.md)). Note: those grades are **pre-DTE-bucket re-grade** — the new bucketed thresholds shipped tonight (commit `d9cce72`) will shift labels when the next pass runs.

Per the Q1 thresholds:
- trial → live needs `n_30d ≥ 150 ∧ hr_v3_30d ≥ 0.40` — currently short on sample size (n=43); the live current-fire pace (181 fires since 2026-04-25) means the next graded-pool pass should clear the n floor.
- trial → decay (effective): `hr_v3_14d < 0.30 ∧ n_14d ≥ 30` once `n` accumulates.

## Calibration history

- `5ddd86a` (2026-04-25) — detector portfolio framework Wave 1; `cluster_slow_stacker` seeded as one of the 5 founding rows. Born from the Friday 2026-04-24 backtest forensic that identified +160% avg cluster peak as the slow-stack signature.
- `5141c31` (2026-04-26) — 5-detector portfolio ship for Monday open; cluster_slow_stacker was already in the original wave-1 seed but moved into trial alongside the 5 new shadow detectors.
- `3ce8be4` (2026-04-26) — pre-Monday hardening: stagger lanes for the 5 new detectors. cluster_* loop runs inside `ct-signature-watcher` cadence, no separate cron.
- `e5c5f11` — `(option_symbol, direction, minute)` cluster dedupe in Slack push so the same accumulation doesn't multi-fire.
- `f5f2c4e` + `e88cc79` — score-first cron + per-alert score recovery (shared with signature_v1, applies because cluster fires ride the same sweep).
- Pre-DTE-bucket grader (50% peak / 30% drawdown flat thresholds) was the calibration target through 2026-05-01. **Commit `d9cce72` shipped DTE-bucketed thresholds tonight** — first re-grade pass under the new buckets will give the trial → live decision its real read.
