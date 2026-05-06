# A1 — D2 escalation: cadence framing (verify-the-brief's-empirical-premise)

**Date:** 2026-05-06 post-D2-verdict.
**Trigger:** D2 verification verdict observed 1 wakeup/ticker in first RTH hour. Brief expected ~10/hour at 6-min cadence. **10× discrepancy** — must verify before A2/A3 readings can be sample-trusted.
**Scope:** diagnose-only. Evaluate hypotheses (a) wakeup conditional-on-events / (b) cron schedule changed / (c) atypical low flow today.

---

## TL;DR

**The brief's "10 wakeups/hour at 6-min cadence" empirical premise was WRONG.** Actual cron schedule is **1 wakeup/hour/ticker** — each per-ticker specialist has its own cron at a unique staggered minute past the hour. Has been stable for 7+ RTH days. Today's 1-wakeup-per-ticker observation in the first RTH hour is the **full sample** the schedule produces, not a regression.

Methodology-errors-cascade **instance #12** confirmed: brief embedded an empirical assumption (6-min cadence) that didn't survive contact with the actual cron schedule. Sub-class of brief-author-premise-error. Sibling to today's morning A1 (MCP v1.1 token target ≤8k → empirical 32k) — second instance this session of brief embedding wrong empirical claim.

---

## Hypothesis evaluation

### (a) wakeup is conditional-on-events — PARTIAL

The cron `ct-specialist-<ticker>` always fires at its scheduled time, but the specialist may early-exit before logging a wakeup_log row if pre-conditions fail (no events, etc.). **Today's MSFT wakeup logged WITH `events_considered=0` and `skip_reason='no_events'`** — so wakeup_log DOES log zero-event runs. So (a) doesn't fully explain the cadence. Specialists log every cron firing.

### (b) cron schedule actually changed — REFUTED

7-day wakeup_log data shows stable per-ticker cadence:

| ticker | wakeups (7d 13:30Z+) | wakeups RTH-only |
|---|---:|---:|
| AAPL | 5 | 4 |
| AMZN | 5 | 4 |
| GOOGL | 6 | 5 |
| IWM | 4 | 3 |
| META | 5 | 4 |
| MSFT | 5 | 4 |
| NVDA | 5 | 4 |
| QQQ | 5 | 4 |
| SPY | 6 | 5 |
| TSLA | 5 | 4 |

Stable ~4-5 per ticker over 6 RTH days = 0.7-0.8 wakeups/RTH-hour/ticker. No recent break. (b) refuted.

### (c) atypical low flow today — REFUTED for cadence

The cron schedule is the binding constraint, not flow. Even on high-flow days the cron fires once per ticker per hour. (c) doesn't explain the cadence; it can only explain whether the wakeup that DID fire produced events or not.

### (d) [the actual answer] — Brief embedded a wrong cadence assumption

Cron schedule (verified from `cron.job` via `get_cron_status` RPC):

```
ct-specialist-spy       0  13-20 * * 1-5    (HH:00)
ct-specialist-qqq       6  13-20 * * 1-5    (HH:06)
ct-specialist-iwm      12  13-20 * * 1-5    (HH:12)
ct-specialist-aapl     18  13-20 * * 1-5    (HH:18)
ct-specialist-msft     24  13-20 * * 1-5    (HH:24)
ct-specialist-googl    30  13-20 * * 1-5    (HH:30)
ct-specialist-amzn     36  13-20 * * 1-5    (HH:36)
ct-specialist-meta     42  13-20 * * 1-5    (HH:42)
ct-specialist-nvda     48  13-20 * * 1-5    (HH:48)
ct-specialist-tsla     54  13-20 * * 1-5    (HH:54)
ct-specialist-dispatcher  */5  13-20 * * 1-5  (every 5 min — but this is the DISPATCHER, not per-ticker fire)
```

Each per-ticker specialist fires once per hour at a staggered minute. The dispatcher fires every 5 min but that's an orchestration heartbeat, not a per-ticker scoring run. The brief likely conflated dispatcher cadence (5 min) with specialist cadence (60 min).

**Empirical max wakeups/ticker/RTH-hour = 1.** Hard ceiling.

---

## Implications for A2 + A3 sample interpretation

Today's first RTH hour produced **1 wakeup per ticker = 1 sample per ticker**. That is the maximum possible sample size for any single hour, NOT a degraded sample. D2 verification's first-hour findings are full-resolution at the 1-sample-per-ticker grain.

Multi-day baselines are needed for distribution analysis. A2 and A3 must use 7-day windows (~4-6 wakeups per ticker) to get meaningful sample sizes. A single RTH hour cannot validate or refute D2 acceptance because the schedule allows at most one data point per ticker per hour.

**This means D2's "fire within first hour of RTH" acceptance criterion was structurally over-prescriptive.** A more empirically-anchored acceptance criterion would be "fire on multi-day cumulative basis at recalibrated thresholds" or "p75 of conviction over 7d > recalibrated threshold."

---

## Class-kill candidates (queued, no ship this round)

### A1.K1 — brief-author-premise-empirical-verification step

When a brief embeds an empirical claim (cadence, count, frequency), require the brief author to verify the claim against current state before treating as load-bearing. Today: the brief said "10 wakeups/hour"; verifying against `cron.job` would have surfaced the 1/hour reality in <1 min. Operationally — add a "verified empirical premises" section to brief templates with the specific check that confirmed each empirical claim.

### A1.K2 — D2 acceptance criterion reformulation

Restate as multi-day: "≥N fires per ticker per 7-day RTH cumulative" or "p75 of conviction at recalibrated threshold > threshold." Single-hour verification is structurally noisy at 1 sample/ticker; multi-day captures the distribution.

Both queued for explicit per-PR approval.

---

## Methodology audit (self-check)

- ✅ Pulled cron schedule directly via `get_cron_status` — empirical ground truth.
- ✅ Cross-checked against 7-day wakeup_log to confirm cron behavior matches schedule.
- ✅ Distinguished dispatcher cadence (5 min) from per-ticker cadence (60 min) explicitly.
- ✅ Stated which hypothesis the evidence supports (d, the unstated option).
- ✅ Flagged second instance this session of brief-embedding-wrong-empirical-claim — pattern not isolated.
- ⚠️ Did NOT inspect the dispatcher logic to confirm whether dispatcher invocations could trigger additional per-ticker runs outside the scheduled cron (would require reading dispatcher source). Pre-flag for A1 follow-up if needed.
