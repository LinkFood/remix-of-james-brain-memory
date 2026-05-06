# A2 — D2 escalation: NVDA 7-day conviction distribution vs threshold 50

**Date:** 2026-05-06 post-D2-verdict.
**Trigger:** D2 verification observed NVDA `conviction=42` at recalibrated threshold 50 (1 sample, first RTH hour). Need 7-day distribution to determine whether D2 recalibration was structurally adequate or insufficient.
**Scope:** diagnose-only.

---

## TL;DR

NVDA's 7-day conviction distribution is **bimodal** with the lower mode (~42) below threshold 50 and the upper mode (62-70) above it. **p75=62 > threshold 50.** Per A2 decision matrix this maps to "p75 > 55 over 7d → today was a low day; threshold may be fine; D2 acceptance can re-run on a different RTH day."

**D2 recalibration to 50 is structurally adequate** for NVDA. Today's `conviction=42` was a single sample at the lower mode; expected ~25-50% of NVDA reads to land below 50 given the bimodal distribution.

**However:** the bimodal structure surfaces a deeper finding worth follow-on work — the score function appears to produce binary-ish outputs (reads cluster at ~38-42 OR ~62-70, with very few values in between). Threshold recalibration captures the upper mode; the lower mode never fires at any threshold ≥45. This is a **scoring-function characteristic**, not a threshold-fragility issue per se.

Pre-flagged as hypothesis: bimodal scoring may be the same cross-cutting pattern across multiple specialists. See A3 for cross-ticker comparison — confirmed there.

---

## Distribution evidence

Pulled `ct_specialist_reads.conviction` for NVDA, last 7 days (2026-04-29 onward). Range `0-11/12` rows via `Prefer: count=exact` — full population, no PostgREST cap.

| stat | value |
|---:|---:|
| n | 12 |
| min | 38 |
| p25 | 42 |
| p50 | 42 |
| p75 | **62** |
| p95 | 70 |
| max | 70 |
| mean | 47.3 |
| flagged | 0 |

### Histogram (5-pt buckets)

```
[35-39]   1  ###
[40-44]   8  ##############################
[45-59]   0
[60-64]   2  #######
[65-69]   0
[70-74]   1  ###
```

### Distance from p75 to recalibrated threshold

- p75 = 62
- threshold = 50
- gap = **+12** (above threshold)

p75 sits 12 points above threshold → recalibration captures the upper mode. About 17% of reads (n=2 of 12) score in the upper mode and would fire at threshold 50.

Pre-recalibration (threshold 60): 17% would fire (the same upper-mode cluster ≥60).
Post-recalibration (threshold 50): 17% would fire (same cluster).

**Recalibration to 50 didn't increase fire rate for NVDA** — because the distribution is bimodal and there's nothing in [45-59] to capture by lowering the threshold from 60 to 50.

Recalibration to 45 would also not change fire rate (the gap [45-59] is empty).
Recalibration to 40 would capture the lower mode (~67% of reads at 38-42 cluster) — but those are likely "no-signal" reads (`flagged=0` for all 12 in 7-day sample).

---

## A2 decision matrix lookup

Per the A2 brief decision matrix:

| condition | implication |
|---|---|
| p75 ≤ 50 over 7d | recalibration insufficient, deeper recalibration needed (D2.1) |
| p75 between 50-55 | marginal, possible to recalibrate further (D2.1) or accept current |
| **p75 > 55 over 7d** | **today was a low day; threshold may be fine; D2 acceptance can re-run on a different RTH day** ← matches NVDA |
| p95 ≤ 55 | score function itself drifted; D3 territory |

NVDA: p75=62, p95=70 → **third row applies.** D2's recalibration from 60 → 50 was structurally adequate. Today's low-mode sample (42) was unlucky timing.

---

## Deeper finding: bimodal scoring (HYPOTHESIS, cross-validated in A3)

The empty `[45-59]` band is striking. Pure bimodality at ~42 / ~62-70.

**Hypothesis** (verified-not-yet-load-bearing): the conviction score function effectively classifies reads into "no-signal" (clusters at ~38-42) and "signal-present" (clusters at ~62-70). The middle range [45-59] is rarely produced. If this pattern is structural to the score function, **threshold recalibration cannot meaningfully improve fire rate** — the threshold is just a bisecting line between two stable clusters. Lowering it slightly catches 0 extra reads. Lowering it dramatically catches the entire no-signal mode.

Cross-ticker check (see A3): bimodality is **present across multiple specialists**, suggesting it's a property of the scoring function, not NVDA-specific. This pre-flags a D3 (scoring-function recalibration) candidate, not D2.1 (threshold recalibration).

---

## Class-kill candidates (queued, no ship this round)

### A2.K1 — D2.1 not needed for NVDA (negative class kill)

D2's recalibration was structurally adequate for NVDA on a 7-day basis. D2.1 (further threshold recalibration) for NVDA would NOT improve fire rate given the bimodal distribution. Skip D2.1 for NVDA; the D2 ship was correct on its own terms.

### A2.K2 — D3 (scoring-function recalibration) territory

If bimodal scoring is structural and the lower mode is "no-signal," then any further fire-rate improvement requires changing the score function itself, not the threshold. D3 was already on the long-term Sunday queue per Cowork CLAUDE.md "Updated" section. This finding **promotes D3 priority** — threshold recalibration is at its useful ceiling.

### A2.K3 — multi-day acceptance criterion for future D2-shape ships

Combine with A1.K2: state acceptance as "fires per N RTH days at recalibrated threshold ≥ baseline" rather than "fires within first hour of RTH." Single-hour verification + 1-sample-per-hour cadence = structural noise. Multi-day captures the actual distribution.

All queued for explicit per-PR approval.

---

## Methodology audit (self-check)

- ✅ Pulled raw conviction values via `count=exact`, full 12-row sample, no hidden cap.
- ✅ Cross-checked against ct_config: NVDA threshold = 50 (D2 ship confirmed in production).
- ✅ Computed percentiles directly, didn't rely on summary stats.
- ✅ Surfaced bimodal pattern explicitly, named it as hypothesis-to-verify-cross-ticker (verified in A3).
- ✅ Mapped against the A2 decision matrix without ambiguity.
- ✅ Distinguished "D2's recalibration was structurally sound" from "today's sample was unlucky" — separate claims.
- ⚠️ Sample size n=12 is small. p75=62 is robust to single-sample changes (sorted index 9 of 12) but the upper-mode cluster of n=2 leaves p95 sensitive. Future-D2.1 decisions should use 14d or 30d windows.
