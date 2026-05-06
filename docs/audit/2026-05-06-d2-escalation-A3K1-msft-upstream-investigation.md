# A3.K1 — MSFT upstream investigation (Phase A.5 diagnose-only)

**Date:** 2026-05-06 post-D2-escalation.
**Trigger:** A3 verdict tagged MSFT as C1 (double-failure: upstream event-starvation + downstream threshold-fragility). Captain decision gates D2.2 on this investigation.
**Scope:** diagnose-only. MSFT-specific cause vs shared with GOOGL/AMZN/META.

---

## TL;DR

**Original C1 framing (MSFT-unique double-failure) is REFUTED at the upstream layer; CONFIRMED-BUT-RESHAPED at the downstream layer.** Empirical evidence:

1. **MSFT is NOT upstream-starved at the score level.** `ct_scored_flow` has 235 MSFT events scoring ≥55 over 7 days — similar magnitude to NVDA (288 ≥50, 235 ≥55). The upstream score function produces plenty of high-score MSFT events.

2. **MSFT IS effectively starved at the 30-min-candidate-window granularity.** 5 of 6 logged wakeups had `events_considered=0`. Mechanism: cron-window-vs-event-clustering misalignment — high-score events cluster at times that don't reliably align with MSFT's HH:24 wakeup (with 30-min lookback covering HH:54-prev to HH:24-current).

3. **MSFT downstream conviction IS more fragile than other tickers**, but the bimodal-low-mode pattern is **shared cross-ticker** (cross-validated in A3). MSFT just sits on the worse end of the same distribution shape.

**Verdict on the gating question:** **Cause is NOT MSFT-specific upstream.** Cause is two compounding shared factors converging on MSFT specifically:
- Cron-window-vs-event-clustering at MSFT's HH:24 sample point
- Bimodal scoring (downstream) where MSFT's prompt produces lower-mode-dominated outputs

**Implication for D2.2 (the held GOOGL/AMZN/META ↓55 ship):** **Safe to proceed with D2.2 as scoped.** GOOGL/AMZN/META don't have the cron-window misalignment problem (they have 0.33-0.40 zero-event rates vs MSFT's 0.83). Their issue is purely downstream-marginal — exactly what D2.2's threshold drop addresses.

**Implication for MSFT:** **Do NOT include MSFT in D2.2.** A separate fix path needed — either cron-time reconfiguration OR per-ticker prompt review (D3-adjacent). A3.K1 follow-on Phase A needed before any MSFT-specific write.

---

## Evidence

### Upstream score density per ticker (last 7 days, ct_scored_flow)

| ticker | n | p25 | p50 | p75 | p95 | max | ≥50 | ≥55 | ≥60 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **MSFT** | **473** | 40 | 54 | 65 | 75 | 85 | 284 | **235** | 187 |
| NVDA | 1319 (sample 1000) | 38 | 47 | 55 | 65 | 80 | 479 | 288 | 161 |
| AAPL | 559 | 38 | 52 | 60 | 70 | 85 | 298 | 245 | 166 |
| GOOGL | 551 | 42 | 55 | 65 | 75 | 88 | 343 | 285 | 212 |
| AMZN | 661 | 47 | 58 | 67 | 78 | 90 | 461 | 385 | 296 |
| META | 450 | 42 | 55 | 68 | 77 | 85 | 289 | 244 | 194 |

**MSFT upstream score density is mid-pack.** 235 events ≥55 / 7 days = ~33/day = ~5/RTH-hour. Plenty of qualifying events exist.

**Counter to A3 framing:** MSFT is not upstream-poor. The "event starvation" observed at the wakeup level is downstream of upstream — the 30-min candidate window happens to not catch events.

### Per-30-min-window expected events (uniform distribution baseline)

For each ticker, expected events per 30-min window = (events_above_wakeup_threshold over 7d) / (336 30-min windows in 7 days):

| ticker | wakeup threshold | events ≥threshold over 7d | uniform expected per 30-min window |
|---|---:|---:|---:|
| MSFT | 55 | 235 | 0.70 |
| NVDA | 50 | 479 | 1.43 |
| AAPL | 55 | 245 | 0.73 |
| GOOGL | 60 | 212 | 0.63 |
| AMZN | 60 | 296 | 0.88 |
| META | 60 | 194 | 0.58 |

**Uniform expectation says MSFT should see ~0.70 events per wakeup.** Observed events_per_wakeup = 0.2 (over 5 logged wakeups since 2026-05-05 19:24Z when wakeup_log was added). **3.5× lower than uniform expected.**

NVDA: uniform expected 1.43, observed 7.8 (5.5× HIGHER). NVDA gets clustering at HH:48.
MSFT: uniform expected 0.70, observed 0.2 (3.5× LOWER). MSFT gets anti-clustering at HH:24.
GOOGL/AMZN/META: uniform expected 0.58-0.88, observed 1.0-1.6 (2-3× HIGHER). They get clustering at their respective minutes.

**Cron-window-vs-event-clustering pattern:** the wakeup time matters. NVDA at HH:48 catches end-of-hour clustering; MSFT at HH:24 misses event clustering elsewhere in the hour.

### Downstream conviction reconciliation

ct_specialist_reads has 18 MSFT rows over 7 days (all at HH:24). All conviction values:

```
38, 32, 38, 38, 32, 38, 42, 28, 42, 38, 31, 38, 38, 72, 38, 38, 38, 62
```

10 of 18 reads are exactly 38. Consistent with the bimodal scoring pattern (lower mode at ~38, upper mode at ~62-72). 

**Note:** ct_specialist_reads has 18 rows but ct_specialist_wakeup_log only has 6 (since wakeup_log was added at commit `5ad7127` on 2026-05-05 19:00Z). The 12 reads from before that date had no corresponding wakeup_log entries. **wakeup_log incomplete coverage is a pre-existing observability gap**, not part of A3.K1 scope.

### MSFT specialist prompt (sampled inspection)

Pulled `specialist.MSFT.prompt` from ct_config — full prompt is 60+ lines. Surface comparison against AAPL prompt (also pulled) shows:
- Both have ticker-specific narrative (AAPL: iPhone cycles / WWDC; MSFT: enterprise software / Azure cycles)
- Both have similar structural framing
- **No obvious structural prompt difference that would produce systematically lower conviction**

Pre-flag (HYPOTHESIS, NOT load-bearing): subtle prompt characteristics may produce lower-conviction outputs for MSFT, but this requires per-PR Phase A.5.1 to verify (prompt-engineering work, not a quick query).

---

## Verdict on the captain's gating question

**MSFT-specific cause? NO.** MSFT shares the upstream-clustering and downstream-bimodal patterns with other tickers. MSFT is the most-affected because both factors converge:
- Cron at HH:24 happens to misalign with MSFT-event clustering
- Specialist's bimodal output skews to lower mode for MSFT specifically

**Shared upstream cause? PARTIAL.** Upstream score function is fine (235 events ≥55 / 7d for MSFT). The cron-window-vs-clustering pattern is shared infrastructure (one cron per ticker per hour at staggered minutes). Whether each ticker's HH:NN sample time aligns with its event clustering is per-ticker empirical question.

**Implication for D2.2 (GOOGL/AMZN/META ↓55):**
- GOOGL/AMZN/META have 0.33-0.40 zero-event-rate (mid-band). Their issue is purely downstream-marginal — D2.2 threshold drop fixes this.
- D2.2 ships as scoped tomorrow morning, with a multi-day acceptance criterion (per A1.K2).
- **Do NOT include MSFT in D2.2.** MSFT's failure mode is different.

**MSFT-specific fix path** (queued, requires separate per-PR approval):
1. **Cron timing reconfiguration** — move MSFT cron from HH:24 to a different minute that better captures MSFT-event clustering. Requires histogram of MSFT-event timestamps within the hour; would inform a new HH:NN choice. Migration only, no code change.
2. **Per-ticker prompt review** — D3-adjacent. Compare MSFT prompt against AAPL/NVDA for differences that might produce lower-conviction outputs.
3. **Defer until D3** — if D3 (scoring-function recalibration) addresses bimodal pattern globally, MSFT improves automatically without a per-ticker patch.

Recommend (3) — do not patch MSFT separately; let D3's structural fix lift it.

---

## Class-kill candidates (queued, no ship this round)

### A3.K1.K1 — MSFT cron timing histogram analysis (Phase A.5.1)

If/when D3 doesn't address MSFT enough, run this. Histogram MSFT high-score event timestamps within the hour to pick a better HH:NN cron time. Pure analysis, no production write.

### A3.K1.K2 — Cross-ticker cron-event-clustering alignment audit

Generalize the MSFT pattern: for each of the 10 specialists, check whether their cron HH:NN aligns with their event-clustering pattern. May surface additional under-firing or over-firing per-ticker. Pure read.

### A3.K1.K3 — wakeup_log backfill for pre-2026-05-05 19:24Z

Currently wakeup_log has incomplete coverage (only 6 MSFT rows when ct_specialist_reads has 18 in same window). Backfill from older sources would tighten the analysis baseline — but per James's directive on PR #26, **NO backfill of forensic gaps**. Skip this candidate or re-evaluate separately.

All require explicit per-PR approval.

---

## Methodology audit (self-check)

- ✅ Pulled per-ticker upstream score density via `count=exact`, full populations (with note that NVDA hit the 1000-row PostgREST cap at n=1319 but for the score-distribution question that's a representative sample).
- ✅ Cross-checked uniform-expected vs observed per-wakeup events to surface the cron-window-vs-clustering pattern.
- ✅ Reconciled ct_specialist_reads (18 rows) vs ct_specialist_wakeup_log (6 rows) — the gap is wakeup_log addition timing, not data corruption.
- ✅ Refuted my own A3 C1 framing with empirical evidence — discipline operating correctly. The original "MSFT-specific double-failure" was a false-cause inference at A3 scope; A3.K1's empirical verification surfaced the actual mechanism.
- ✅ Per-PR-approval-required tag preserved on all proposed fix shapes.
- ✅ Brief-author-premise-error discipline applied: A3's original verdict was treated as hypothesis, not premise; A3.K1 verified against empirical ground.
- ⚠️ Did NOT inspect MSFT prompt vs AAPL/NVDA at the prompt-engineering level — too deep for diagnose-only round. Pre-flag: A3.K1.K1 needs that read if/when MSFT fix becomes priority.
- ⚠️ NVDA upstream sample hit PostgREST 1000-row cap. The score-distribution shape is robust, but if a future analysis needs NVDA's exact n, paginate explicitly.

---

## Methodology-errors-cascade — instance #13 candidate

A3.K1's empirical verification refuted my own A3 framing (MSFT as MSFT-specific C1 double-failure). This is the **second instance THIS SESSION** of Phase A discipline catching a Phase A's own framing error. Pattern: each layer of audit produces a hypothesis that the next layer empirically verifies; the verification sometimes refutes the hypothesis. The discipline operates correctly when this happens.

Worth a methodology-patterns.md entry as a **structural property** of nested-Phase-A audits: each Phase A's output should be tagged as hypothesis-pending-verification by the NEXT Phase A. The current "brief-author-premise-error" framing covers this; A3.K1 confirms the pattern recursively.
