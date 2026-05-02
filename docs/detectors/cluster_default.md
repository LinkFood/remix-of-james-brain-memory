# Cluster Default (`cluster_default`)

- **Status:** live (per `ct_detectors`)
- **Source file:** `supabase/functions/ct-signature-watcher/index.ts` (config-driven via `ct_detectors` row — not a standalone function)
- **DTE class:** all
- **Live config row:** `SELECT * FROM ct_detectors WHERE id = 'cluster_default'`

> **Architectural note.** `cluster_default` is **not** its own edge function. It is a row in `ct_detectors`. The cluster loop in `ct-signature-watcher/index.ts` (~L390 + L709-720, `toClusterDetector` + `loadActiveDetectors('cluster_')`) reads every non-retired `cluster_*` row and runs each one as its own detector with its own config. **Adding a new cluster variant is a DB `INSERT`, not a deploy** (Tenet 25). Each match writes its own `ct_flags` row stamped with the detector id.

## What it sees

Pages forward through `ct_flow_alerts` since the shared signature-watcher watermark, oldest-first, gated by `ct_config.watcher.watchlist` (10-ticker universe). Per-alert: same-ticker / same-direction prints inside the cluster window, near the print's strike, with shared aggressor inference (`inferPredictedSource`, never raw `is_ask`/`is_bid`). Direction comes from `_shared/directionInference`. Pulse-at-fire-time is stamped on the `ct_flags` row alongside the detector id. The fast-burst near-money accumulation pattern — institutional intent landing in a tight 5-minute window with dominant directional unanimity.

## Math

Live config (`ct_detectors.config` JSONB):

- `window_min = 5` — cluster width in minutes.
- `min_prints = 3` — minimum cluster size.
- `strike_band_pct = 0.02` — strikes within ±2% of the seed strike count toward the cluster.
- `min_unanimity_pct = 0.80` — ≥80% of cluster prints must share the same inferred aggressor direction.

Shared with the rest of the watcher: watchlist gate via `ct_config.watcher.watchlist`, dedupe via `thresholds.dedupeMin`, watermark on `ingested_at`. Tight window catches fast institutional bursts before the heatmap finishes redrawing.

## Regime fit

Moderate windows. The original cluster detector — live for 6+ months across the watcher's regime span. Performs across regimes when strike-band activity concentrates inside the 5-min cell. Degrades when the same conviction stretches across 10–20 minutes of layered prints — that's the reason `cluster_slow_stacker` (15-min / 5-prints / 3% / 75%) was added as the wider-window sibling.

## False-positive shapes

- Mid-prints clustering near a round strike with no real aggressor edge.
- 0DTE chop where 80% unanimity is a coin flip on small-N clusters.
- Dealer hedging bursts that mimic directional aggressor footprint when delta-band re-balancing concentrates.
- Single-name expiry-day lottery prints stacking inside 5 min on weak conviction.

## Demote criteria

Composite `hr_v3 = 52.3%` at `n = 22` (Q1 analysis, **pre-DTE-bucket re-grade**). Live status grandfathered — `n` is thin under the bucketed Q1 thresholds. Per [`2026-05-02-detector-lifecycle-thresholds`](../decisions/2026-05-02-detector-lifecycle-thresholds.md): `live → decay` if `hr_v3_14d < 0.30 ∧ n_14d ≥ 30`. Watch signal: if `cluster_default` 14d hit-rate trails `cluster_slow_stacker` 14d, the wider-window variant is doing better and the default tightness is the problem — promote slow_stacker, demote default.

Last 30d ticker mix (n=65): QQQ 27, NVDA 14, SPY 9, AMZN 5, GOOGL 5, TSLA 4, MSFT 1 — index/Mag7 weighted, as expected.

## Calibration history

- `5ddd86a` 2026-04-25 — detector portfolio framework lands. `cluster_default` row created with current config (`5 / 3 / 0.02 / 0.80`); cluster loop reads `ct_detectors` rows instead of hardcoded constants. Realizes Tenets 8 + 25.
- `5141c31` 2026-04-26 — 5-detector ship for Monday open. `cluster_default` co-shipped with `cluster_slow_stacker` and 4 shadow detectors; no math change to default, but the slow_stacker sibling exists from this point as the wider-window comparator.
- No threshold tuning since. Pre-DTE-bucket grader (flat 50% peak threshold) was the calibration target until 2026-05-02. Under the new DTE-bucket grading (4-14d / 15-45d / 46+d) the verdict surface shifts most on long-DTE fires; `cluster_default` fires across all DTE classes, so a verdict-shift on long-DTE fires is **expected** on re-grade — read the next composite report on its own merits, not against the 52.3% / n=22 baseline above.
- Memory: `~/.claude/projects/-Users-jameschellis/memory/project_co_trader_detector_portfolio_shipped_2026_04_26.md`.
