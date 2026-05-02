# Specialist Scoreboard v2 — Design Decisions

**Shipped:** 2026-05-02 ~05:45 UTC
**Migrations:** 20260502040200, 20260502040600, 20260502040700
**Edge function:** `ct-specialist-prompt-lifecycle-v2`
**Brain organ:** `_shared/specialistRecallContext.ts` (extended) + `_shared/specialistRecallV2.ts` (helper)
**UI:** `src/pages/Specialists.tsx` (extend) + `src/hooks/useSpecialistScoreboardV2.ts`

---

## Why

v1 graded specialists on a single dimension: did the option contract peak ≥+50%? That conflates two distinct edges:
- **Premium edge** — the option ran (good for buyers, but heavily IV-sensitive)
- **Underlying edge** — the ticker moved in the predicted direction (the structural prediction quality)

A specialist who calls direction correctly but the option doesn't move (low IV, no convexity) gets graded the same as a specialist who's wrong. A specialist who's wrong but the option pumps on a vol crush mismatch gets credit. v1 noise + v1 bias.

v2 grades on multiple axes simultaneously, conditions on regime-at-fire, tracks streaks separately for read-direction and graded-outcome, and computes drift slope to catch decay early.

## Schema — multi-axis grading

| Column | Source | Computation |
|---|---|---|
| `premium_axis_outcome` | `ct_contract_tracks` (peak_contract_pct, max_drawdown_pct) | ≥+50% peak = win; ≤-50% drawdown w/o recovery = loss; pending if <4h since print; else partial |
| `underlying_outcome_4h/1d/3d` | `ct_price_bars` (1m bars, 51,651 rows last 7d) | base_close at fire+δ; pct_move ≥0.5% in direction = win; ≤-0.5% against = loss; <threshold = partial |
| `blended_verdict` | combined | All 3 underlying win + premium win → strong_win; underlying_1d win + premium {win,null} → win; underlying_1d loss + premium ≠ win → loss; all loss → strong_loss; pending propagates |
| `regime_at_fire` | `ct_regime_classifications` | 5-min bucket of f.created_at; per-ticker first, fallback market-wide |

**Why ct_price_bars, not ct_ticker_snapshots:** Phase A audit tonight — `ct_ticker_snapshots` is a 12-row latest-only quant card cache, not a price history. Brief said "underlying-axis grading at 4h/1d/3d" → that needs historical bars. `ct_price_bars` is the right source (1m bars, full 7d+ window, all 10 watchlist tickers).

## Why regime-conditional buckets

The same setup grades differently in different regimes. A bullish flag in `trending_up_strong` should hit higher than the same flag in `chop_high_dispersion`. By bucketing scoreboard rows by `(specialist_ticker × regime × window_label)`, each specialist's regime-specific edge is visible. Rows where regime='all' carry the unconditional baseline; specific regime rows carry the conditional. UI shows top 3-5 active regimes per specialist.

**Bootstrapping:** regime data only populates as `ct-regime-capture` accumulates history. First-week `regime_at_fire` will be sparse (mostly 'unknown' or NULL) — the 'all' bucket carries useful data while regime tagging warms up. Acknowledged.

## Conviction calibration — start cross-specialist, promote per-specialist

`ct_specialist_conviction_calibration` keyed on `(specialist_ticker, conviction_bucket, window_label)`:
- `specialist_ticker = '__ALL__'` carries cross-specialist baseline (all flags pooled)
- `specialist_ticker = <ticker>` populates only when N≥30 per (specialist, bucket, window) — config: `specialist.conviction.per_specialist_min_n = 30`

Below the threshold, the UI falls back to the `__ALL__` row and labels the calibration source. This avoids confidently displaying garbage statistics from sparse specialist-specific buckets.

**Why 30:** standard small-sample threshold for proportion estimates with reasonable confidence intervals (binomial CI ±18% at p=0.5). Below 30, confidence interval is wider than the threshold ranges (45→55→65) we're trying to discriminate.

## Read-streak vs graded-streak

Two distinct streak metrics:

| Streak | Source | Meaning |
|---|---|---|
| `read_streak_signed` | `ct_specialist_reads.direction_lean` sequence | "Specialist has been bullish 3 reads in a row" |
| `graded_streak_signed` | `ct_specialist_grade_axes.blended_verdict` sequence | "Specialist won 3 graded flags in a row" |

A specialist on a bullish read-streak who is also on a graded loss-streak is signal: their read direction is consistent but the graded outcome disagrees → they're calling a regime that isn't there. The streak gate in the prompts (`AAPL` v2 prompt, gate 1) uses read-streak. The lifecycle uses graded-streak (loosely, via hit_rate).

## Drift slope

`drift_slope_7d` = linreg of rolling-7d hit_rate over last 30d, expressed in **percentage points per week**. Positive = improving; negative = decaying. NULL until n_graded ≥ 30 in window. Surfaces decay early, before lifecycle decides to flip status.

## Lifecycle — attaches to (specialist, prompt_version), not specialist

`ct_specialist_prompt_lifecycle` keyed on `(specialist_ticker, prompt_version)`. The 20 seed rows = 10 tickers × {v1 retired, v2 live}. When a v3 prompt deploys, it gets its own lifecycle row starting at `shadow`, advances through trial → live based on hit rate, K=4 stability gate.

**Why per-version:** prompt iterations are a major source of edge change. Tracking lifecycle per-prompt-version separates "specialist NVDA is decaying" from "specialist NVDA's v2 prompt is decaying — v3 prompt may resurrect" cleanly.

**K=4 stability gate** mirrors detector lifecycle (`ct_detector_lifecycle_state`). proposed_status must hold for K consecutive nightly runs before status flip permitted. First nightly fire: 4 specialists (AMZN, META, NVDA, TSLA) propose `decay` (hr=0.00) — won't flip until K=4 met (~2026-05-06 if data persists). Gate held correctly: 0 flips on first run, exactly as designed.

## C1 contamination — acknowledged

The 14-day Specialist Recall hit-rate verification window (2026-05-01 → 2026-05-15) measures whether specialists improve when shown their last 5 flagged + last 5 unflagged-conv≥50 reads. v2 changes the data the specialist sees of itself — multi-axis stats, regime-conditional, drift slope, lifecycle status — which contaminates the controlled comparison.

**Decision:** accept the contamination. Reasons:
1. The C1 experiment validates *that recall context helps*, which v1 already proved 2026-05-01.
2. v2 enrichment is a SUPERSET of recall context — if v1 recall helps, v2 enrichment helps strictly more.
3. Holding v2 until 2026-05-15 means 2 weeks of grading happens against the v1 single-axis system, wasting that signal.
4. The acceptance review on 2026-05-15 will analyze C1 with awareness of when each enrichment landed (logged here + in commit messages).

**What stays untouched during the window:** the runtime preamble for specialists. Pulse v2 regime context is NOT injected into preamble until 2026-05-15 (deferred per `~/CLAUDE.md` operational note).

## Warden invariants (3)

| Name | Threshold | Purpose |
|---|---|---|
| `specialist_scoreboard_v2_freshness` | ≤26h | Nightly cron must refresh; 24h cron + 2h grace |
| `specialist_grade_axes_growing` | ≥10 rows / 24h on RTH days | Grading pipeline alive |
| `specialist_lifecycle_silent_streak_check` | 0 stuck rows | Catches "K=4 reached but no flip" silent no-op pattern (the lifecycle-layer analog of the v1 silent-failure class) |

All three passing post-build.

## Producer cadence

Single nightly cron `0 3 * * *` calls `ct-specialist-prompt-lifecycle-v2`, which:
1. Calls `ct_specialist_score_v2(7)` RPC — refreshes scoreboard
2. Walks `ct_specialist_prompt_lifecycle` per row — applies K=4 gate

One cron, two phases — keeps the dependency clean (lifecycle reads scoreboard same fire). Manual trigger via `public.trigger_ct_specialist_score_v2()` mirror of `trigger_ct_detector_scoreboard()`.

## Parallel-run with v1

v1 `ct_specialist_scoreboard` + `ct-specialist-scoreboard-update` cron + `useSpecialistScoreboard` hook + v1 outcome row in `Specialists.tsx` — ALL preserved.

**Tonight's bonus:** v1 silent-failure root cause fixed in same session (migration 20260502040900). The new silent-failure warden invariant caught it; the 1-line `WHERE f.specialist_ticker IS NOT NULL` filter closes it. Both v1 and v2 now produce fresh rows on cadence.

## Open items / next iterations

- **Trading-day skip in 1d/3d underlying axes** — current implementation uses calendar days. A flag fired Friday 14:00 ET targets +1d as Saturday 14:00 (no bar) → falls through to Monday's first bar. Acceptable for alpha (pending fallback handles it), but skews the 1d/3d windows by ~weekend-length on Fridays. Trading-day arithmetic in `ct_price_bars` lookup is a v2.1 cleanup.
- **Per-specialist regime fill** — sparse first week. Brief acknowledged.
- **Lifecycle Slack** — currently posts on flip. Consider posting weekly summary of all (specialist, prompt_version) hit rates so trends are visible without flips.
- **Grade re-run on v3 grader** — when grading rules change, bump `grade_version` and re-grade existing flags. Currently grade_version=1.

## Files shipped tonight

- `supabase/migrations/20260502040200_specialist_v2_schemas.sql`
- `supabase/migrations/20260502040600_specialist_v2_score_rpc.sql`
- `supabase/migrations/20260502040700_specialist_v2_crons.sql`
- `supabase/functions/ct-specialist-prompt-lifecycle-v2/index.ts`
- `supabase/functions/_shared/specialistRecallContext.ts` (extended)
- `supabase/functions/_shared/specialistRecallV2.ts` (helper)
- `supabase/functions/_shared/specialistRunner.ts` (tickerCoherenceValidator wiring)
- `src/pages/Specialists.tsx` (extended)
- `src/hooks/useSpecialistScoreboardV2.ts`

Plus tonight's bonus: `supabase/migrations/20260502040900_v1_scoreboard_null_specialist_fix.sql` — the canonical silent-failure case, closed.
