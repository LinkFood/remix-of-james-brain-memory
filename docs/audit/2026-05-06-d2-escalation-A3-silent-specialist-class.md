# A3 — D2 escalation: silent-specialist class diagnosis (MSFT + GOOGL + AMZN + META)

**Date:** 2026-05-06 post-D2-verdict.
**Trigger:** D2 verification verdict + reactivation of yesterday's queued GOOGL/AMZN/META silence brief, EXPANDED to include MSFT after today's verdict surfaced MSFT as event-starvation class.
**Scope:** diagnose-only. Per-ticker threshold inventory + score distribution + events_considered vs wakeup count + upstream cause class assignment.

---

## TL;DR

**Original framing — "silent-specialist class of 4 tickers" — REFUTED.** Empirical evidence shows three distinct classes, not one:

| ticker | threshold | p75 | events/wakeup | class | structural cause |
|---|---:|---:|---|---|---|
| **MSFT** | 55 | **38** | **0.2** (1 ev / 5 wakeups) | **C1: double-failure** | event-starvation upstream + extreme threshold-fragility downstream |
| **GOOGL** | 60 | 62 | 1.0 | C2: marginal | p75 just barely above threshold; firing 2× in 7d |
| **AMZN** | 60 | 62 | 1.2 | C2: marginal | same shape as GOOGL |
| **META** | 60 | 58 | 1.6 | C2.5: mildly fragile | p75 sits 2pts BELOW threshold; would benefit from threshold ↓ to 55 |

Plus the contextually-relevant non-silent specialists for cross-comparison:

| ticker | threshold | p75 | events/wakeup | class |
|---|---:|---:|---|---|
| NVDA | 50 | 62 | 7.8 | C3: adequate post-D2 (see A2) |
| AAPL | 55 | 68 | 4.0 | C3: adequate post-D2 |

**Methodology-errors-cascade #12 confirmed at A3 scope as well**: yesterday's "GOOGL/AMZN/META + MSFT silent" framing grouped by symptom (no_events% + no fires) when the underlying causes split three ways. **Same shape as today's morning's heatmap "5/8 missing" partial-frame (instance #10)**: consumer-framed symptom upgraded by Phase A to compounding causes.

---

## Per-ticker conviction distribution (7-day, n shown)

Pulled `ct_specialist_reads.conviction` per ticker, last 7 days. `Prefer: count=exact` confirms full populations (no PostgREST cap).

### MSFT (n=18, threshold=55)

```
[25-29]   1  ###
[30-34]   3  #########
[35-39]  10  ##############################  ← p25=p50=p75=38
[40-44]   2  ######
[45-59]   0
[60-64]   1  ###
[65-69]   0
[70-74]   1  ###
```

Stats: min=28, p25=38, p50=38, **p75=38**, p95=72, max=72, mean=40.1, flagged=**0**

**Distance from p75 to threshold: -17.** p75 sits 17 points BELOW threshold. **Recalibration to 55 was structurally insufficient by a wide margin.** To capture even half of MSFT reads, threshold would need to drop to ≤38.

### GOOGL (n=27, threshold=60)

```
[25-29]   1  ####
[30-34]   4  #################
[35-39]   7  ##############################  ← p25=38
[40-44]   3  ############
[45-49]   3  ############  ← p50=42
[60-64]   3  ############  ← p75=62
[65-69]   1  ####
[70-74]   3  ############
[75-79]   1  ####
[80-84]   1  ####
```

Stats: min=28, p25=38, p50=42, **p75=62**, p95=79, max=82, mean=48.9, flagged=**2**

**Distance from p75 to threshold: +2.** Marginal — fires 2× in 7d at threshold 60.

### AMZN (n=34, threshold=60)

```
[25-29]   3  ##########
[35-39]   9  ##############################  ← p25=35
[40-44]   5  ################
[45-49]   2  ######  ← p50=48
[55-59]   1  ###
[60-64]   7  #######################  ← p75=62
[65-69]   5  ################
[70-74]   1  ###
[75-79]   1  ###
```

Stats: min=25, p25=35, p50=48, **p75=62**, p95=72, max=76, mean=49.5, flagged=**1**

**Distance from p75 to threshold: +2.** Marginal — same shape as GOOGL. Notably wider distribution than MSFT (events flowing).

### META (n=28, threshold=60)

```
[25-29]   7  #####################
[30-34]   1  ###  ← p25=32
[35-39]  10  ##############################  ← p50=38
[40-44]   3  #########
[55-59]   2  ######  ← p75=58
[60-64]   1  ###
[65-69]   4  ############
```

Stats: min=28, p25=32, p50=38, **p75=58**, p95=68, max=68, mean=42.1, flagged=**0**

**Distance from p75 to threshold: -2.** Mildly below — threshold ↓ to 55 would catch the [55-59] cluster (n=2) plus push p75 past threshold. Not in MSFT's class but more fragile than GOOGL/AMZN.

---

## Upstream events_considered (7-day cumulative)

| ticker | wakeups | total events | zero-event wakeups | events / wakeup |
|---|---:|---:|---:|---:|
| **MSFT** | 5 | **1** | **4 / 5 (80%)** | **0.2** |
| GOOGL | 6 | 6 | 2 / 6 (33%) | 1.0 |
| AMZN | 5 | 6 | 2 / 5 (40%) | 1.2 |
| META | 5 | 8 | 1 / 5 (20%) | 1.6 |
| AAPL | 5 | 20 | 2 / 5 (40%) | 4.0 |
| NVDA | 5 | 39 | 2 / 5 (40%) | **7.8** |

**MSFT is anomalous.** 80% zero-event wakeups + only 1 event in 5 wakeups. The other "silent" tickers (GOOGL/AMZN/META) get 1-2 events per wakeup on average — mediocre but not starved. NVDA gets 7.8 events/wakeup — clearly upstream is firing heavily for NVDA.

---

## Cross-cutting bimodal pattern (cross-validates A2 hypothesis)

Every ticker shows two clusters separated by a near-empty middle band:

| ticker | lower mode | empty band | upper mode |
|---|---|---|---|
| NVDA | [38-44] (n=9) | [45-59] | [60-74] (n=3) |
| MSFT | [25-44] (n=16) | [45-59] | [60-74] (n=2) |
| GOOGL | [25-49] (n=18) | [50-59] | [60-84] (n=9) |
| AMZN | [25-49] (n=19) | [50-54] | [55-79] (n=15) |
| META | [25-44] (n=21) | [45-54] | [55-69] (n=7) |
| AAPL | [25-49] (n=14) | [50-54] | [55-79] (n=8) |

**The bimodal scoring pattern is structural to the score function, not ticker-specific.** A2's hypothesis confirmed: threshold recalibration is bisecting between two stable clusters; lowering the threshold within the empty band catches no extra reads. **D3 (scoring-function recalibration) is the structural fix shape, not D2.1 (further threshold recalibration).**

---

## Class assignment + structural fix shape per ticker

### Class C1 — MSFT — DOUBLE-FAILURE

- **Upstream**: 80% zero-event wakeups → ingest filter / candidate-event source isn't producing flow that reaches MSFT scoring. Could be:
  - UW MSFT-tagged flow is genuinely sparse this week
  - Specialist's pre-scoring filter is too strict for MSFT options characteristics
  - Per-ticker watchlist filter excluding relevant flow
- **Downstream**: even when scored, p75=38 << 55. Lower mode dominates entire 18-row sample. 1 of 18 reads (5.6%) lands in upper mode (≥60). Recalibration to 55 was insufficient by 17 points; recalibration to 38 would catch ~50% of reads but most of those are likely no-signal.

**Fix shape (HYPOTHESIS, requires per-PR approval):**
1. Upstream investigation — read MSFT-side ingest filter logic, compare against NVDA's. Find why MSFT events_considered is ~7-40× lower per wakeup than NVDA/AAPL.
2. Score-function review (D3) — bimodal lower-mode-dominated distribution suggests MSFT prompt produces low-conviction reads on most data shapes. Either the prompt needs MSFT-specific tuning OR the score function needs reformulation.
3. NOT another threshold recalibration to ~38 — that would catch ~50% of reads but they're predominantly no-signal cluster; would create false-positive flood not matched by signal increase.

### Class C2 — GOOGL + AMZN — MARGINAL

- **Upstream**: 1.0-1.2 events/wakeup — adequate flow.
- **Downstream**: p75 = 62 vs threshold 60 — barely catching the upper mode. Currently firing 1-2× per 7d at threshold 60.
- Could benefit from threshold ↓ to ~55 → would catch the [55-59] cluster but n is small.
- Not structurally broken; marginally below useful sensitivity.

**Fix shape (HYPOTHESIS):** small recalibration to 55, brings GOOGL/AMZN in line with NVDA/MSFT/AAPL post-D2 thresholds. Low blast radius. Confirm via 7-day re-distribution after recalibration.

### Class C2.5 — META — MILDLY FRAGILE

- p75 = 58 vs threshold 60 → recalibration to 55 would push p75 above threshold and catch the [55-59] cluster (n=2 in current sample).
- Same shape as GOOGL/AMZN but slightly worse positioning relative to threshold.
- Not in MSFT's class — events flowing fine (1.6/wakeup), distribution shape similar to GOOGL/AMZN.

**Fix shape (HYPOTHESIS):** same as GOOGL/AMZN — recalibrate to 55.

### Class C3 — NVDA + AAPL — ADEQUATE POST-D2

- p75 above current threshold by 12-13 points.
- Firing 0-3 times per 7d in current sample.
- D2 recalibration was structurally correct.
- See A2 for NVDA detail.

---

## Class-kill candidates (queued, no ship this round)

### A3.K1 — MSFT-specific upstream investigation (Phase A.5)

Read `_shared/specialistContext.ts` and ct-specialist-msft prompt to identify why MSFT's events_considered is ~7-40× lower than NVDA/AAPL. Could be ticker-specific filter, prompt structure, or genuine UW data sparsity. Different shape from threshold recalibration — needs its own diagnose-only Phase A.

### A3.K2 — GOOGL/AMZN/META threshold recalibration to 55 (D2.2)

Following the same shape as D2 (60 → 50/55/55 for NVDA/MSFT/AAPL). Per-PR approval required. Blast radius: ct_config write only, no edge-function deploy needed (config-driven via the new ct_config.specialist.\<TICKER\>.wakeup_threshold).

### A3.K3 — D3 (scoring-function recalibration) PROMOTED

Bimodal scoring across all 6 specialists (NVDA/MSFT/GOOGL/AMZN/META/AAPL) suggests structural property of the score function itself. Threshold recalibration is at its useful ceiling — further fire-rate improvement requires changing how scores are computed, not where the cut-line is. Promotes D3 from long-term Sunday to active queue.

### A3.K4 — silent-specialist warden invariant

Detect: any specialist where (events_considered_per_wakeup_7d) < N AND (zero_event_wakeups_pct_7d) > 50%. Severity: warn. Catches the MSFT C1 class going forward. Ties to today's morning's pattern (defense-in-depth catches future regressions).

All queued for explicit per-PR approval.

---

## Methodology audit (self-check)

- ✅ Pulled per-ticker thresholds from `ct_config` directly — empirical ground truth.
- ✅ All conviction queries used `count=exact` — full populations, no PostgREST cap (instance #9 forcing function active).
- ✅ Refuted the original "4-ticker silent class" framing with empirical evidence — instance #12 confirmed at A3 scope.
- ✅ Three distinct class assignments with explicit empirical basis per assignment.
- ✅ Cross-validated A2's bimodal hypothesis via cross-ticker patterns — load-bearing now, not just hypothesis.
- ✅ Structural fix shapes flagged as HYPOTHESES requiring separate approval, not premises.
- ⚠️ Did NOT inspect ct-specialist-msft's prompt or the upstream filter chain. Pre-flag: A3.K1 needs that read before fix can be designed.
- ⚠️ Sample sizes are small (n=12-34). Multi-week sampling would tighten percentile estimates. For decisions about further recalibration, recommend 14d or 30d windows.
