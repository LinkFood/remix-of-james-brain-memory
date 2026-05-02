# 2026-05-02 — P0 #1 Investigation Findings (Phase B → Captain Decision)

**Status:** Phase C PAUSED. Three investigation answers below; redesigned scope options at bottom. Captain decision required before proceeding.

## Q1 — Why only 12 underlying-axis (specialist) grades?

**Not a pipeline bug. Backlog drain priority artifact.**

- Specialist source has **90 flags total ever created**: 65 active / 12 graded / 13 conviction / 0 invalidated
- Of the 65 "active", ~10 have `horizon_ts` already past but haven't been graded yet
- Tonight's drain (8 fires × 200 limit, ASC by horizon_ts) processed 1,407 grades — but the queue is still ~3,500 deep (mostly old signature/detector flags from late April). Specialists from May 1 sit at the back of the queue.
- As cron drains over coming hours/days at `*/30 * * * *`, the specialist count will climb naturally to match `flagged + horizon_ts < now()` minus `(specialists with status=conviction OR T+1-OI-confirmed)`.
- **The grader code path for specialist works correctly.** No bug.

james_star source: 4 flags total, 0 graded — same story. They'll grade as backlog clears.

**Implication for P0 #1:** original premise ("DTE-bucketed thresholds for underlying-axis") is structurally fine; specialist grading just hasn't accumulated yet. Calibrating from n=12 is impossible regardless.

## Q2 — Full axis breakdown

| Source | Grades (last 30d) | % of corpus | Axis |
|---|---|---|---|
| signature_alarm | 735 | 52% | contract |
| detector_alarm | 660 | 47% | contract |
| specialist | 12 | <1% | underlying |
| james_star | 0 | 0% | underlying |
| **Total** | **1,407** | | |

**Per-day:**

| Date | Total | Breakdown |
|---|---|---|
| 2026-04-28 | 66 | signature=66 |
| 2026-04-29 | 1 | signature=1 |
| 2026-04-30 | 6 | signature=5 detector=1 |
| 2026-05-01 | **1,334** | signature=663 detector=659 specialist=12 |

95% of all-time grades landed tonight (May 1) during the silent-exit drain (commit c951c59). Without tonight's drain, the corpus would be 73 grades total. **Effectively, we have one day of grading data, and 99% of it is contract-axis.**

## Q3 — DTE bucketing on contract-axis (the 99% slice)

**The data + a data-quality caveat.**

Contract-axis hit-rate by DTE bucket (`hr_v3` = wins + 0.5×partials / n):

| Bucket | n | win | partial | loss | inv | strict_win% | hr_v3 |
|---|---|---|---|---|---|---|---|
| 0DTE | 487 | 135 | 176 | 133 | 43 | **27.7%** | 45.8% |
| 1-3d | 273 | 80 | 115 | 58 | 20 | **29.3%** | 50.4% |
| 4-14d | 313 | 85 | 123 | 80 | 25 | 27.2% | 46.8% |
| 15-45d | 237 | 52 | 118 | 40 | 27 | 21.9% | 46.8% |
| 46+d | 85 | 11 | 47 | 1 | 26 | **12.9%** | 40.6% |

**Composite hr_v3 is roughly flat across DTE (40-50% band).** But the **strict win-rate drops dramatically** for long-DTE — 12.9% on 46+d vs 28% on short DTE. The current 50% peak / 30% drawdown thresholds in `computeAlarmOutcome` are reasonably calibrated for short DTE but unreasonably tight for long-DTE — long-dated contracts rarely move 50% intraday because they trade with lower IV and time-decay drag.

**This IS a real signal — DTE-bucketed contract-axis thresholds would lift long-DTE detectors fairly.**

### Data-quality caveat (significant)

I tried to calibrate thresholds from `peak_contract_pct` distribution and found:

| Bucket | n | p50 | p75 | p90 |
|---|---|---|---|---|
| 0DTE | 133 | 0.0% | 9.4% | 37.7% |
| 1-3d | 82 | 0.0% | 13.3% | 25.2% |
| 4-14d | 262 | 0.0% | 3.9% | 10.7% |
| 15-45d | 84 | 0.0% | 1.1% | 4.2% |
| 46+d | 439 | 0.0% | 0.1% | 1.2% |

**Median peak is ZERO across every bucket.** That's not how options trade — it's how `ct_contract_tracks` rows look when they were polled briefly and then frozen.

**Earlier observation (carried from tonight's audit):** `ct_contract_tracks` has 3,465 WORKING rows / 0 REALIZED / 0 EXPIRED. **The track-state machine doesn't transition tracks.** A track in WORKING state forever stops being polled at some point but its `peak_contract_pct` reflects only the polled period. For most contracts that's near-zero because polling was sparse or stopped before the move.

**This poisons calibration math.** The peak_contract_pct percentiles above don't represent "what contracts actually do over their lifetime" — they represent "what the poller happened to capture before stopping." Building DTE-bucketed thresholds on this distribution would calibrate against poll-cadence artifacts, not contract performance.

## Captain decision options

### Option A — Defer P0 #1 entirely
- Underlying-axis: too thin (n=12)
- Contract-axis: data quality suspect (poll-cadence artifacts)
- Wait 2-4 weeks for corpus accumulation + track-state-machine fix
- **Audit caught the false premise. Discipline working.**

### Option B — Ship contract-axis DTE bucketing using strict-win-rate as anchor
- Use the strict win-rate distribution (not peak_contract_pct distribution) — that data IS valid because it's a binary outcome label, not a polled value
- Strict win-rate: 27.7% on 0DTE, 12.9% on 46+d
- Calibrate per-bucket thresholds to flatten strict win-rate to ~25-30% across all buckets
- Mechanical: lower the win-pct config for long DTE so more contracts cross the bar
- Risk: doesn't fix the underlying data-quality issue (peak values are unreliable). Just rebalances which label gets applied.

### Option C — Fix the prerequisite: track-state machine
- Investigate why no track ever transitions WORKING → REALIZED/EXPIRED
- Likely a polling-stopped-but-status-unchanged class
- After fix, re-poll old tracks to recover their actual peaks
- THEN P0 #1 calibration becomes meaningful
- Estimated: 1-2 days for state machine + re-poll + verify

### Option D — Hybrid: ship strict-win-rebalanced thresholds (B) + flag the state-machine issue for next session
- Lower 46+d win threshold from 50% → 20% (target ~25% strict win-rate)
- Lower 15-45d win threshold from 50% → 30%
- Keep 0-14d win threshold at 50%
- File "track-state-machine doesn't transition" as separate P0 for next session
- Acceptable tonight because the strict-win shift is independent of peak-data-quality (binary outcome, not magnitude)

## My recommendation

**Option D.**
- B alone leaves a known data-quality lie in the foundation (calibrating against poll-cadence artifacts).
- C alone delays a high-leverage fix (long-DTE detectors penalized by uniform thresholds).
- A defers everything which contradicts tonight's "stop pushing items down the road" posture.
- D ships the contract-axis threshold rebalance using the trustworthy data (strict win-rate label, not peak%) AND surfaces the track-state issue for separate treatment.

**If D approved:**
- Phase C (~1.5 hr): add per-DTE config keys for `grader.alarm_win_pct.<bucket>` + `grader.alarm_loss_pct.<bucket>`. Modify `computeAlarmOutcome` to take DTE bucket. Wire DTE extraction in the grader's source-branch.
- Phase D (~30 min): re-grade last 7d of contract-axis flags with new thresholds. Verify strict win-rate flattens across buckets.
- File track-state-machine investigation as next session's P0.

## C1 measurement noise note

P0 #1's original (underlying-axis) framing would have introduced grading-logic noise into the C1 hit-rate verification (specialist recall property). **Option D keeps underlying-axis grading unchanged** — only contract-axis thresholds change. Specialists are graded via underlying-axis. **C1 noise is zero under Option D.** That's a structural reason to prefer it over the original P0 #1 framing.

## Open question for James

Approve Option D and proceed to Phase C? Or chosen alternative?

**Auxiliary finding to flag regardless of which option:** the track-state machine producing 3,465 WORKING / 0 REALIZED / 0 EXPIRED is a real bug that affects more than P0 #1. It distorts every metric that reads `ct_contract_tracks.peak_contract_pct`. Logging as P0 candidate for next session.
