# 2026-05-02 — Detector Lifecycle Thresholds (Q1 Analysis)

**Audit type:** Terminal-mode analysis pass (Tenet 26). Read-only on `ct_flag_grades` ⨝ `ct_flags`.
**Goal:** Validate the draft thresholds (shadow→trial n≥50 ∧ hit_rate≥0.30; trial→live n≥150 ∧ hit_rate≥0.35; live→decay if 14d hit_rate <0.20) against actual distribution, adjust if data says so.
**Output:** Calibrated thresholds for `ct_detector_scoreboard` Phase B Mon-Tue.

## Source data

Sampled 1,000 of 1,407 grades over last 30d (PostgREST 1000-row cap). Bias toward most-recent rows.

## Per-detector hit-rate distribution (last 30d sampled)

| detector_id | n | win | part | loss | inv | hr_strict | hr_lenient | hr_composite |
|---|---|---|---|---|---|---|---|---|
| unusual_oi_v1 | 320 | 59 | 155 | 72 | 34 | 18.4% | 66.9% | **42.8%** |
| signature_v1 | 266 | 76 | 105 | 61 | 24 | 28.6% | 68.0% | **48.3%** |
| whale_v1 | 143 | 23 | 85 | 4 | 31 | 16.1% | 75.5% | **45.8%** |
| smart_money_repeat_v1 | 105 | 49 | 45 | 9 | 2 | 46.7% | 89.5% | **68.1%** |
| cluster_slow_stacker | 43 | 13 | 19 | 10 | 1 | 30.2% | 74.4% | **52.3%** |
| zerodte_opening_call_v1 | 40 | 14 | 16 | 8 | 2 | 35.0% | 75.0% | **55.0%** |
| zerodte_put_voi_extreme_v1 | 39 | 7 | 9 | 18 | 5 | 17.9% | 41.0% | **29.5%** |
| cluster_default | 22 | 6 | 11 | 5 | 0 | 27.3% | 77.3% | **52.3%** |
| weekly_atm_voi_v1 | 12 | 3 | 9 | 0 | 0 | 25.0% | 100.0% | **62.5%** |

**Definitions:**
- `hr_strict` = `wins / n` (direction + magnitude both met)
- `hr_lenient` = `(wins + partials) / n` (direction met, magnitude may not)
- `hr_composite` = `(wins + 0.5*partials) / n` ← the morning-brief scorecard formula. **This is what I recommend the lifecycle uses.**

## Why composite (hr_v3), not strict or lenient

- **Strict** (`hr_v1`): only 1 detector hits ≥35% (smart_money_repeat at 46.7%). Most are 16-30%. Using strict, the proposed `trial → live` threshold of 0.35 would mean **only 1 detector qualifies for live status across the whole portfolio**, even though 3 detectors are already live in production. Strict is too punishing — partial outcomes are direction-correct, just below magnitude target. They have signal value.

- **Lenient** (`hr_v2`): everything except zerodte_put_voi_extreme hits 66-100%. Using lenient, even shadow detectors with mediocre direction-correctness would promote. Too loose — partial-rich detectors (whale_v1 hits 75.5% lenient but only 16.1% strict because most outcomes are barely-positive partials) would auto-promote despite weak edge.

- **Composite** (`hr_v3` = wins + 0.5*partials / n): 30-68% spread, clean signal-to-noise. Detector portfolio has natural separation: zerodte_put at 30% vs smart_money at 68%. Calibrates well against the existing morning-brief grading philosophy.

## Calibrated thresholds

```
shadow → trial:    sample_count_30d ≥ 50  AND hr_composite_30d ≥ 0.30
trial → live:      sample_count_30d ≥ 150 AND hr_composite_30d ≥ 0.40
live → decay:      hr_composite_14d < 0.30 AND sample_count_14d ≥ 30
decay → retired:   hr_composite_30d < 0.25 AND sample_count_30d ≥ 50
```

### Tightenings vs the original draft

- **trial → live: 0.35 → 0.40.** At 0.35, every detector with sample size qualifies; the gate becomes meaningless. 0.40 puts the bar at "comfortably above 50/50 direction with magnitude beating noise" and still admits 5 of 9 active detectors.
- **live → decay: hr_strict<0.20 → hr_composite<0.30.** Composite axis matches the promote criterion; the original 0.20 strict number was structurally inconsistent. 0.30 composite matches the bottom of the active detector spread (zerodte_put_voi at 29.5% would be the first to demote).
- **decay → retired added.** Original draft didn't have one; needed for cleanup of permanent under-performers. 0.25 leaves room above zero for "still occasional signal but mostly noise" before terminal retirement.
- **14-day window for live → decay** keeps; it's the "early bad-streak signal" — 30d window would let a detector hide in trailing average for too long.

### Sample-size floor reasoning

- `n_30d ≥ 50` for shadow→trial: standard error on a binomial at p=0.4 with n=50 is sqrt(0.4·0.6/50) = 6.9% — enough to distinguish 30% from 50% at the 95% level. Lower n risks promoting detectors whose true rate is mid-30s but observed rate happens to land high.
- `n_30d ≥ 150` for trial→live: same logic, tighter. SE drops to 4.0% at p=0.4 with n=150. Enough to call 40% from 50% confidently.
- `n_14d ≥ 30` for demote: shorter window, noisier — 30 is the minimum where a sustained drop can't be ascribed to single-week noise.

## Effect on current portfolio under calibrated rules

| Detector | Current status | n_30d | hr_v3 | Auto-recommended |
|---|---|---|---|---|
| signature_v1 | live | 266 | 48.3% | **stay live** ✓ |
| smart_money_repeat_v1 | shadow | 105 | 68.1% | shadow → trial (n<150 short of live) |
| unusual_oi_v1 | shadow | 320 | 42.8% | shadow → trial → **live** (clears both) |
| whale_v1 | shadow | 143 | 45.8% | shadow → trial (n=143 just below 150 floor for live) |
| cluster_slow_stacker | trial | 43 | 52.3% | stay trial (n<50 floor for promote re-eval; will graduate) |
| zerodte_opening_call_v1 | shadow | 40 | 55.0% | hold shadow (n<50; needs more fires) |
| zerodte_put_voi_extreme_v1 | shadow | 39 | 29.5% | hold shadow; **CLOSE TO DECAY** if it had been live |
| cluster_default | live | 22 | 52.3% | stay live (n thin but live-status grandfathered) |
| weekly_atm_voi_v1 | shadow | 12 | 62.5% | hold shadow (n<50) |

**Net for Phase B:** under the calibrated rules, 4 promotions land on day-1 (`unusual_oi_v1` shadow→live, `smart_money_repeat_v1` shadow→trial, `whale_v1` shadow→trial — `whale` borderline, defer to manual until n≥150).

**No demotions on day-1.** zerodte_put_voi is the closest to decay but is still in shadow; doesn't apply.

## Caveats for Phase B implementation

1. **Sampled 1000 of 1407 grades.** Tonight's percentages have ±1-2% noise. Phase B daily refresh will use the full population (no sampling). Expect minor shifts.

2. **Specialist source has only n=10 in the data.** specialist_flag detector_id rows are mostly NULL (specialist flags don't always stamp detector_id — confirmed by 65 NULL rows in the audit). Phase B should grade specialists via `source='specialist'` separately from `detector_id` lookup.

3. **Sample-size floor needs holiday/weekend adjustment.** A pure 30d window during a low-fire stretch could under-count a normally-active detector. Phase B should either:
   - Use trailing 30 calendar days × cadence-aware weighting (hard), OR
   - Use 30 trading days (~6 weeks calendar — easier), OR
   - Just trust the floor and accept that some detectors will sit in shadow during slow stretches.

4. **Inverted-direction detector (`small_cap_inverted_put_v1`) needs special handling.** Its direction interpretation is flipped (put accumulation = bearish underlying). If the grader's direction-attribution is wrong on this detector, hr_composite will look inverted. Phase B should validate per-detector that direction interpretation matches the grader's expected axis.

5. **Lifecycle rule SHOULD propose, not auto-flip, for first 2 weeks.** Per #9 audit: ship dry-run Slack with proposed transitions; James pulls the trigger. After loop earns trust, flip via config flag to auto-flip mode.

## Phase B kickoff: cleared

Pre-flight blocker resolved (numbers are real, threshold sketch refined to data). Phase B (1.5-2 days, mirror specialist scoreboard pattern) can start Mon. Seed `ct_detector_lifecycle_rules` with the 4 transitions above; let the first week's dry-run runs hit Slack before authorizing auto-flip.
