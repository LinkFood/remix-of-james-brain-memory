# regime_state_freshness_rth + cron_zero_row_upsert — Class B scoping

**Date:** 2026-05-09. **Status:** Phase A complete; Phase B fix scoped, NOT shipped today.

## Classification

Both fires are **Class B (off-hours threshold-vs-cron-schedule mismatch)** per the warden-fire decision tree introduced 2026-05-09. Pulse deploy `a242211` at 00:25:38 UTC **postdates** both first-fail events at 00:00:04 UTC — pulse is NOT the cause. Same root mechanism for both invariants.

## Mechanism

`ct-regime-capture-offhours` cron schedule: `0 10-12,21-22 * * 1-5` UTC weekdays.

Active windows: 10:00, 11:00, 12:00 UTC (morning ramp) + 21:00, 22:00 UTC (evening tail). Dead-of-night gap: **23:00 UTC → 09:59 UTC next day = ~12h** with no cron fire by design.

Both invariants assume a tighter cadence:

- `regime_state_freshness_rth`: phases `{rth: ≤15min, offhours: ≤90min, weekend: pass}`. Treats 23:00-09:59 UTC as `offhours` with 90-min threshold. Drift from last 22:00 fire crosses 90min around 23:30 UTC and keeps failing every 30-min tick until 10:00 UTC the next day.
- `cron_zero_row_upsert_silent_failure_class`: reads `ct_growth_crons` manifest entry `('ct-regime-capture-offhours','public.ct_regime_history','created_at','weekday',90,...)` from migration `20260502040100_pulse_v2_schemas.sql:252`. The 90-min cadence claim has the same mismatch — silent 12h doesn't fit a 90-min expectation.

This is a **recurring nightly artifact**. Historical pattern visible in `ct_invariant_log` — yesterday 2026-05-06 failed 06:30→10:00 UTC (4 consecutive ticks at values 510→720 min) then passed at 10:30 UTC after the morning cron fired. Pattern repeats every weeknight.

## What WAS NOT broken

- The cron schedule is correct per its design (RTH coverage + morning ramp + evening tail).
- The producer (`ct-regime-capture` edge function) is healthy — when it fires, it writes ~10-11 classifications per fire (verified at 22:00:08 UTC fire today).
- Pulse organ shipped today is a **read-side** consumer of `ct_regime_classifications`, not a producer. Cannot have caused this.

## Phase B scope (not today)

**Option 1 — add `dead_of_night` phase to invariant SQL.** Extend the phase classifier:

```
WHEN clk.dow NOT BETWEEN 1 AND 5 THEN 'weekend'
WHEN clk.hr BETWEEN 13 AND 20 THEN 'rth'
WHEN clk.hr IN (10, 11, 12, 21, 22) THEN 'offhours_active'
ELSE 'dead_of_night'
```

Then: `dead_of_night` phase passes (returns 0 metric_value) regardless of age. Mirrors weekend-pass semantic.

**Option 2 — relax `offhours` threshold to match actual gap.** Set threshold to ~12h (720 min) for `offhours`. Simpler edit, but loses tightness during the active 21-22 UTC window when 90-min IS the right threshold.

**Option 3 — split into two invariants.** `regime_state_freshness_offhours_active` (covers 21-22 UTC + 10-12 UTC, 90-min threshold) + `regime_state_freshness_rth` (rth-only, 15-min threshold). Drop the conflated definition. Most structurally correct; most code.

**Recommendation:** Option 1. Smallest delta, mirrors the existing `weekend` pass-through, doesn't expand the invariant count.

Companion fix for `cron_zero_row_upsert_silent_failure_class`: amend the `ct_growth_crons` manifest entry to either (a) drop ct-regime-capture-offhours from the silent-failure class entirely (it's not a "growth cron" — it's a periodic snapshot cron with intentional gaps), or (b) extend `expected_cadence_minutes` to 720 with `phase='offhours'`.

## Re-open trigger

If after Option 1 fix lands and both invariants stay clean for 7 days, ship verified. If they continue to fire on a new boundary (e.g., weekend → Monday morning gap), re-scope to Option 3.

## Cascade catalog

Not a new instance — re-emergence of the class documented in `feedback_warden_threshold_calibration.md`: "When invariants fail 20+ runs and last_value > 0, check 7-day median + producer caps before chasing the runbook." This is the same class, surfaced again because the dead-of-night/morning-ramp boundaries weren't initially in the `regime_state_freshness_rth` design when the pulse v2 cron was scheduled hourly.

The new wrinkle worth codifying: **invariant-and-cron-must-be-co-designed**. When the cron's silence schedule has multiple distinct windows (RTH + morning-ramp + evening-tail + dead-of-night + weekend), the invariant's phase classifier must enumerate them all. Add as sub-class candidate to methodology-patterns when next touched.
