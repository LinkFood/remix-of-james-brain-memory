# Signature class match (`signature_v1`)

- **Status:** live (per `ct_detectors`)
- **Source file:** `supabase/functions/ct-signature-watcher/index.ts`
- **DTE class:** all
- **Live config row:** `SELECT * FROM ct_detectors WHERE id = 'signature_v1'`
- **Tier evaluator config:** `SELECT * FROM ct_config WHERE key LIKE 'signature_alarm_%'`

## What it sees

`ct_flow_alerts` page-walked since the last watermark (`ct_signature_alarm_state.last_processed_ingested_at`), filtered to the `watcher.watchlist` universe. Each alert is keyed into a signature class — `<TICKER>:<side>:<dte_bucket>:<predicted_source>` — where `predicted_source` mirrors `ct-print-grader.inferDirection` (`aggressive_ask_call`, `aggressive_bid_put`, etc.) and `dte_bucket` is `0dte | short(≤7) | mid(≤30) | long`. Class-level n + median peak come from the `ct_signature_magnitude_stats(p_since, p_min_n)` RPC (lookback `signature_alarm_lookback_days`, default 7d). Per-alert score is read from `ct_scored_flow` via `loadScoreForAlert`. Pulse-at-fire-time is captured via `readPulseContext` per Tenet 9.

## Math

Three-tier ladder, evaluated by `_shared/alarmTiering.ts:evaluateTier(score, sigMedian, sigN, thresholds)` after dedupe (`signature_alarm_dedupe_min`, default 30 min on `option_symbol`) and the 0DTE eligibility skip (`ticker0DteEligibleOn`).

- **Gold:** `score ≥ signature_alarm_gold_min_score` (80) AND `sigMedian ≥ signature_alarm_gold_min_peak_pct` (1.0 = +100%) AND `sigN ≥ signature_alarm_gold_min_n` (10). Slack push (priority).
- **Silver:** combined floor — `score ≥ signature_alarm_silver_min_score` (70) AND `sigMedian ≥ signature_alarm_silver_min_peak_pct` (0.50) AND `sigN ≥ signature_alarm_silver_min_n` (5). Or signature-alone exceptional: `sigMedian ≥ signature_alarm_silver_high_sig_peak_pct` (2.0) AND `sigN ≥ signature_alarm_silver_high_sig_min_n` (10). Slack push (standard).
- **Bronze:** `sigMedian ≥ signature_alarm_bronze_min_peak_pct` (0.50) AND `sigN ≥ signature_alarm_bronze_min_n` (3), OR score-alone `score ≥ signature_alarm_bronze_min_score` (80) with no class match. UI glow only — no Slack.

Calibrated against the canonical 1,220-winner corpus locked 2026-04-24 (memory `project_co_trader_canonical_corpus_2026_04_20_to_24.md`); 18% detector catch baseline. Slack master toggle `signature_alarm_slack_enabled` (currently `false` — calibration mode), gated by `signature_alarm_slack_min_tier`.

## Regime fit

Live since corpus lock 2026-04-24. 30d distribution (1100 flags): 53 silver, 1047 bronze, 0 gold. Concentrated in liquid-tape names — QQQ (420), NVDA (283), AMZN (98), SPY (96), MSFT (61), TSLA (48), GOOGL (47); IWM/META/AAPL trail. Bronze-heavy distribution is by design — bronze is the visible-but-silent training set; gold is the trust gate. No gold fires in 30d means thresholds are still hunting the canonical-corpus tail.

## False-positive shapes

- **RepeatedHits put inversion** — fixed 2026-04-28 in `05792c0`. `RepeatedHits*` rules ARE accumulation by definition; `inferPredictedSource` now bear-tags `aggressive_bid_put` / bull-tags `aggressive_ask_call` on those rules instead of trusting premium-side flip. Bear-tagged a 9:33 NVDA 0DTE +475% print pre-fix.
- **Score race vs scorer** — fixed `f5f2c4e` (score-first cron) and `e88cc79` (inline per-alert recovery). Watcher used to fire flags with `score=0` when alerts ingested in the gap between `ct-score-flow-continuous` and the watcher cold-start. Memory: `feedback_signature_watcher_score_race.md`. Inline `ct_score_existing_flow` now runs at sweep entry + per-alert null recovery.
- **0DTE on ineligible expiry calendar** — fixed `f327fd9`. NVDA-on-Tuesday no longer alarms when its earliest expiry is Friday.

## Demote criteria

Composite `hr_v3 = wins + 0.5 × partials = 48.3%` on `n=266` graded flags (per `ct_flag_grades`). Lifecycle thresholds (per `docs/decisions/2026-05-02-detector-lifecycle-thresholds.md`):

- live → decay if `hr_v3_14d < 0.30 ∧ n_14d ≥ 30`
- decay → retire if `hr_v3_30d < 0.25 ∧ n_30d ≥ 50`

Track per-tier hit rate independently. Drop gold from Slack-push if gold precision falls below silver — the trust ladder must monotonically reflect calibration.

## Calibration history

- `43df66a` — original signature-class Slack alarm wired against `ct_signature_magnitude_stats`.
- `c8c1322` — mirror every alarm into unified `ct_flags` so /flags + /tape can render and the lifecycle scoreboard can grade.
- `f327fd9` — 0DTE ineligibility skip (`ticker0DteEligibleOn`); kills cross-calendar false alarms.
- `8f8663c` — gold/silver/bronze tier ladder introduced; bronze is silent UI glow.
- `9d09671` + `1fc795f` — `replay_mode` body flag + `ct-backtest-harness` pure-data calibration engine. Sunday weekly forensic cadence.
- `05792c0` — RepeatedHits premium-side fix (mirrors `ct-print-grader`); kills the system-wide bullish bias that bear-tagged accumulation prints.
- `88bb85c` — global Slack toggle (`signature_alarm_slack_enabled`) so calibration runs stay silent without disabling the detector.
- `5ddd86a` — detector portfolio framework (Wave 1); cluster_* detectors now ride the same sweep, each writing its own `detector_id` provenance.
- `f5f2c4e` (score-first cron) + `e88cc79` (inline per-alert score recovery) — kill the watcher-vs-scorer race; flags can no longer fire with `score=0` when an alert lands in the gap.
- `54224d1` — `target_price` + `invalidation_price` populated on every flag (signature median or +50% fallback; -30% buffer).
- `17f8544` — `executed_at` null-fallback to `ingested_at`; ~30% of `RepeatedHits*` rows had no `executed_at` and were dropping out of inline rescore.
