# 2026-05-02 — First-Pass Empirical Discovery on Flow Corpus

**Mode:** Analysis (Tenet 26). Read-only SQL against existing tables. No
code, no migrations, no edge-function changes. Pure SELECT.
**Window:** Last 30 days (2026-04-02 → 2026-05-02).
**Iterative:** This doc accumulates one slice per query. Don't auto-run
follow-ups — James interprets and steers next.

---

## Corpus baseline

| Metric | Value |
|---|---|
| Total flags last 30d | **5,255** |
| Graded flags (have ct_flag_grades row) | **1,407** |
| Grade rate (graded / total) | 26.8% |

### Outcome distribution (1,407 graded)

| Outcome | n | % |
|---|---|---|
| partial | 581 | 41.3% |
| win | 368 | 26.2% |
| loss | 317 | 22.5% |
| invalidated_early | 141 | 10.0% |

### By source (5,255 total)

| Source | Total flags | Graded | Grade rate |
|---|---|---|---|
| detector_alarm | 3,762 | 660 | 17.5% |
| signature_alarm | 1,399 | 735 | 52.5% |
| specialist | 90 | 12 | 13.3% |
| james_star | 4 | 0 | 0% |

### By detector_id (graded only, top 10)

| detector_id | graded n |
|---|---|
| signature_v1 | 563 |
| unusual_oi_v1 | 320 |
| whale_v1 | 144 |
| smart_money_repeat_v1 | 105 |
| cluster_slow_stacker | 77 |
| (null detector_id) | 65 |
| cluster_default | 42 |
| zerodte_opening_call_v1 | 40 |
| zerodte_put_voi_extreme_v1 | 39 |
| weekly_atm_voi_v1 | 12 |

### Detectors with ≥30 fires last 30d (the eligibility set for Slice 1)

10 of 14 detectors qualify:

| detector | total fires |
|---|---|
| whale_v1 | 1,605 |
| signature_v1 | 1,100 |
| unusual_oi_v1 | 1,003 |
| smart_money_repeat_v1 | 392 |
| weekly_atm_voi_v1 | 370 |
| cluster_slow_stacker | 181 |
| zerodte_opening_call_v1 | 175 |
| zerodte_put_voi_extreme_v1 | 144 |
| cluster_default | 65 |
| flow_stack_v1 | 64 |

Skipped (<30 fires): pair_qqq_iwm_v1 (5), specialist_flag, scorer_v1,
small_cap_inverted_put_v1.

**Corpus quality caveat:** 1,334 of 1,407 grades (95%) landed on
2026-05-01 from tonight's silent-exit drain. Calibration window is
effectively the period over which fires CREATED — Apr 25-28 dominates
(1,366 of 1,395 cells = 98%). Window narrower than 30d in practice.

---

## Slice 1 — detector × pulse_regime × DTE bucket

**Filter:**
- detector_id ∈ {detectors with ≥30 fires last 30d} (10 detectors)
- source ≠ 'specialist' (C1 verification window — small-N misleads)
- Cell N ≥ 10 (small-sample noise excluded)
- Strict-win = `outcome='win' / total_graded_in_cell`

**Sort:** by detector ascending, then by strict-win-rate descending within detector.
**Flags:** ↑ HIGH = strict_win ≥ 35%; ↓ LOW = strict_win ≤ 15%. Candidates for further investigation, not conclusions.

| detector | regime | dte | n | win | part | loss | inv | strict_win% | flag |
|---|---|---|---|---|---|---|---|---|---|
| cluster_default | unknown | 4-14d | 16 | 7 | 0 | 9 | 0 | **43.8%** | ↑ HIGH |
| cluster_slow_stacker | unknown | 1-3d | 10 | 5 | 0 | 5 | 0 | **50.0%** | ↑ HIGH |
| cluster_slow_stacker | unknown | 4-14d | 19 | 7 | 3 | 9 | 0 | **36.8%** | ↑ HIGH |
| cluster_slow_stacker | unknown | 15-45d | 13 | 0 | 6 | 7 | 0 | **0.0%** | ↓ LOW |
| signature_v1 | unknown | 1-3d | 47 | 25 | 8 | 14 | 0 | **53.2%** | ↑ HIGH |
| signature_v1 | unknown | 0DTE | 87 | 40 | 5 | 42 | 0 | **46.0%** | ↑ HIGH |
| signature_v1 | chop | 0DTE | 26 | 11 | 11 | 1 | 3 | **42.3%** | ↑ HIGH |
| signature_v1 | unknown | 4-14d | 100 | 31 | 17 | 52 | 0 | 31.0% | |
| signature_v1 | trending_up | 4-14d | 11 | 3 | 7 | 0 | 1 | 27.3% | |
| signature_v1 | chop | 1-3d | 34 | 8 | 17 | 2 | 7 | 23.5% | |
| signature_v1 | chop | 4-14d | 26 | 6 | 13 | 1 | 6 | 23.1% | |
| signature_v1 | chop | 15-45d | 22 | 5 | 12 | 0 | 5 | 22.7% | |
| signature_v1 | unknown | 46+d | 24 | 3 | 15 | 0 | 6 | **12.5%** | ↓ LOW |
| signature_v1 | unknown | 15-45d | 93 | 9 | 42 | 30 | 12 | **9.7%** | ↓ LOW |
| signature_v1 | trending_up | 1-3d | 22 | 2 | 13 | 5 | 2 | **9.1%** | ↓ LOW |
| signature_v1 | trending_down | 4-14d | 12 | 1 | 8 | 2 | 1 | **8.3%** | ↓ LOW |
| signature_v1 | trending_up | 0DTE | 12 | 1 | 6 | 1 | 4 | **8.3%** | ↓ LOW |
| signature_v1 | trending_down | 1-3d | 13 | 1 | 9 | 2 | 1 | **7.7%** | ↓ LOW |
| signature_v1 | trending_up | 15-45d | 15 | 1 | 11 | 0 | 3 | **6.7%** | ↓ LOW |
| signature_v1 | trending_down | 0DTE | 10 | 0 | 5 | 2 | 3 | **0.0%** | ↓ LOW |
| smart_money_repeat_v1 | trending_up | 15-45d | 13 | 12 | 1 | 0 | 0 | **92.3%** | ↑ HIGH |
| smart_money_repeat_v1 | chop | 15-45d | 10 | 9 | 1 | 0 | 0 | **90.0%** | ↑ HIGH |
| smart_money_repeat_v1 | trending_up | 1-3d | 10 | 6 | 3 | 1 | 0 | **60.0%** | ↑ HIGH |
| smart_money_repeat_v1 | chop | 1-3d | 11 | 4 | 4 | 3 | 0 | **36.4%** | ↑ HIGH |
| smart_money_repeat_v1 | chop | 0DTE | 12 | 3 | 7 | 1 | 1 | 25.0% | |
| smart_money_repeat_v1 | chop | 4-14d | 11 | 2 | 7 | 1 | 1 | 18.2% | |
| unusual_oi_v1 | trending_up | 1-3d | 12 | 6 | 1 | 4 | 1 | **50.0%** | ↑ HIGH |
| unusual_oi_v1 | trending_up | 0DTE | 48 | 12 | 24 | 9 | 3 | 25.0% | |
| unusual_oi_v1 | chop | 0DTE | 121 | 25 | 41 | 40 | 15 | 20.7% | |
| unusual_oi_v1 | trending_down | 4-14d | 15 | 3 | 9 | 0 | 3 | 20.0% | |
| unusual_oi_v1 | chop | 1-3d | 26 | 4 | 12 | 8 | 2 | 15.4% | |
| unusual_oi_v1 | trending_down | 0DTE | 32 | 4 | 24 | 4 | 0 | **12.5%** | ↓ LOW |
| unusual_oi_v1 | chop | 4-14d | 28 | 3 | 18 | 2 | 5 | **10.7%** | ↓ LOW |
| unusual_oi_v1 | trending_down | 1-3d | 11 | 1 | 6 | 3 | 1 | **9.1%** | ↓ LOW |
| unusual_oi_v1 | trending_up | 4-14d | 15 | 1 | 11 | 2 | 1 | **6.7%** | ↓ LOW |
| whale_v1 | chop | 1-3d | 20 | 4 | 12 | 1 | 3 | 20.0% | |
| whale_v1 | chop | 15-45d | 22 | 3 | 16 | 1 | 2 | **13.6%** | ↓ LOW |
| whale_v1 | trending_up | 46+d | 12 | 1 | 8 | 0 | 3 | **8.3%** | ↓ LOW |
| whale_v1 | chop | 46+d | 19 | 0 | 9 | 1 | 9 | **0.0%** | ↓ LOW |
| zerodte_opening_call_v1 | trending_down | 0DTE | 15 | 8 | 2 | 5 | 0 | **53.3%** | ↑ HIGH |
| zerodte_opening_call_v1 | chop | 0DTE | 22 | 6 | 12 | 2 | 2 | 27.3% | |
| zerodte_put_voi_extreme_v1 | chop | 0DTE | 13 | 3 | 1 | 5 | 4 | 23.1% | |
| zerodte_put_voi_extreme_v1 | trending_down | 0DTE | 22 | 2 | 6 | 13 | 1 | **9.1%** | ↓ LOW |

**Cells: 43 with N≥10 / 101 total cells.** Other 58 cells have N<10 — too thin to interpret.

### Detectors NOT appearing in cross-tab (≥30 fires but <10 cells)

- **flow_stack_v1** (64 fires, 0 grades) — too new, no grade pipeline coverage yet
- **weekly_atm_voi_v1** (370 fires, 12 grades) — every cell <10. Sample concentrating; revisit when grader catches up

### Pulse-regime distribution within graded set

The `unknown` regime label dominates many cells. Likely a structural artifact:
`pulse_regime_at_fire` is `unknown` when fewer than 2 ct_flow_pulse_ticks exist in the tick history at fire time (per `_shared/pulseContext.ts:104`). Pre-Apr 28 tick coverage may have been thinner — most graded flags are from Apr 25-28 fires, that period may pre-date full pulse-tick capture.

---

## SQL pseudo-code (PostgREST equivalents shown)

Corpus baseline:
```
GET /rest/v1/ct_flags?select=id,source,detector_id,direction,score,
    expiry,created_at,pulse_regime_at_fire,ct_flag_grades(outcome)
    &created_at=gte.<30d_ago>
    &order=created_at.desc
    [paginated 6× limit=1000]
```

Slice 1 aggregation:
- Python-side aggregation on the pulled rows (PostgREST has no GROUP BY)
- DTE bucket: round((expiry - created_at) / 86400 sec)
- Filter: detector ∈ {≥30 fires set} ∧ source ≠ 'specialist' ∧ cell N ≥ 10
- Output: cross-tab grouped by (detector_id, pulse_regime_at_fire, dte_bucket)

If we want to extend with stricter filters (excluding `unknown` regime, or
windowing by graded_at instead of created_at), re-run with the additional
filter applied. Each additional filter recomputes from the same pulled
corpus — single fetch, multi-slice cheap.

---

## Open for next slice

(Empty — awaiting James's read of Slice 1.)
