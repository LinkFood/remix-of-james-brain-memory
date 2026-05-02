# 2026-05-02 — Saturday night audit results

**Audit window:** 2026-05-02 ~01:30 UTC (Friday → Saturday early-AM ET)
**Constraint:** UW budget at 65.4% (13,071/20,000) on session 2026-05-01. No UW-heavy work tonight; all items below are read-only / non-UW unless explicitly noted.
**Format:** one master decision file per James's request — items 3-9 from the night's plan, with reasoning per item. LB8 audit + #9/#10 Phase A reports live in their own decision files.

## Item 1 (LB8) — see [`2026-05-02-uw-budget-rebaseline.md`](./2026-05-02-uw-budget-rebaseline.md)
Verdict: −5,000/day target met. Friday closed at 65.4% (down from 100% cap-streak two weeks running). One leak surfaced: `ct-historical-quote-backfill` at 16.3% mid-week share — investigate next session whether it should be weekend-only.

## Item 2 — Q3 fire-rate report (`zerodte_put_voi_extreme_v1`)

**Pattern:** 144 fires over last 14 trading days (~10/day avg).

| Ticker | Fires | Share |
|---|---|---|
| SPY | 73 | 51% |
| QQQ | 39 | 27% |
| TSLA | 14 | 10% |
| IWM | 8 | 6% |
| GOOGL | 3 | 2% |
| AAPL | 2 | 1% |
| NVDA | 2 | 1% |
| META, AMZN, MSFT | 1 each | <1% |

**Daily trajectory:** 19 → 20 → 39 → 24 → 42 (Apr 27 → May 1) — accelerating.

**Implication for #10 doc page:** Detector is ACTIVE at config `min_voi_ratio=5.0` (10 fires/day, growing). Thesis text "V/OI ≥ 20" is the typo — config is truth. Resolves the Phase A blocker for the #10 doc page (no James input needed; numbers say config is correct).

## Item 3 — Q4 biases inventory + correction to earlier audit

**Schema correction:** I claimed all 7 had `last_triggered_at = NULL`. The column doesn't exist. Actual time columns: `first_seen_at`, `last_confirmed`, `created_at`. Re-reading via `last_confirmed`:

| # | Pattern | Voice | Sev | last_confirmed | Re-confirmed since first_seen? |
|---|---|---|---|---|---|
| 1 | overweight single-moment convergence in oscillation | Claude (1st) | 5 | 2026-04-24 | YES (5 days after first_seen) |
| 2 | Averages down losers | James (2nd) | 5 | 2026-04-18 (= first_seen) | NO — never re-confirmed |
| 3 | max conviction to bullish + underweight oscillation | Claude (1st) | 4 | 2026-04-19 (= first_seen) | NO |
| 4 | Over-trades on Fed days | James (2nd) | 4 | 2026-04-18 (= first_seen) | NO |
| 5 | delta flow reversals → regime shifts (retail whipsaw) | Claude (1st) | 4 | 2026-04-24 | YES |
| 6 | overweights put flow in low-VIX | James (2nd) | 3 | 2026-04-18 (= first_seen) | NO |
| 7 | underweight 0DTE pin gravity | Claude (1st) | 3 | 2026-04-21 | YES |

**3 of 7 re-confirmed** since creation (1, 5, 7 — all Claude-side, by regrade events recorded in `evidence`). **4 of 7 never re-confirmed** since creation (2, 3, 4, 6).

**Class observation:** "never re-confirmed" doesn't necessarily mean "stale" — it could mean "no consumer reads them" or "the regrade pipeline only confirms a subset of patterns." Cohort 4 (1st-person Apr 19 batch) is structurally different from cohort 7 (2nd-person James-side). The latter probably needs human re-confirmation that the project doesn't currently capture.

**Action:** James decision pending per-bias. Archive ship deferred.

## Item 4 — P2 #10 (ct_signature_alarm_log → ct_flags 1:1)

**Counts last 7d:** 1,151 alarms in `ct_signature_alarm_log` vs 1,399 flags with `source='signature_alarm'`. **More flags than alarms — directionally not 1:1.**

**Linkage probe:** `ct_flags.source_flow_ids` is an array of UUIDs (textual). PostgREST `source_flow_ids=cs.{<uuid>}` query failed array literal parsing — would need different syntax to confirm linkage. Without that confirmation, the actual gap shape is unclear:

- Could be 1 alarm → many flags (alarm fired, multiple flags written from it)
- Could be N alarms missing flag-write (alarm logged but flag never created)
- Could be flags written by non-alarm path that share `source='signature_alarm'`

**Verdict — DO NOT SHIP without original diagnostic context.** James said "Diagnostic ran previously; gap confirmed" but the original diagnostic output isn't in the playbook or in `ct_heartbeats` from a prior inspection. Shipping a fix without knowing which of the three gap shapes is the real one would be guessing.

**Pre-ship blocker (1 min from James):** Either paste the prior diagnostic output, OR specify which gap shape is the real one. With that, the fix is probably small (~30 min — likely a missing INSERT in `ct-signature-watcher` after alarm-log write).

## Item 5 — P0 #1 (DTE-bucketed win threshold)

**Class-kill discipline check.** James asked me to surface "this is days-each work" before half-shipping.

**Honest scope:** Half-day to 1.5 days.

**What's needed:**
1. Bucket boundaries (your draft: ≤3d / 4-14d / 15-45d / 46+d). Verified against last 7d distribution:

| Bucket | Flag % (last 7d, n=1000) |
|---|---|
| 0DTE | 18.5% |
| 1-3d | 15.4% |
| 4-14d | 30.2% |
| 15-45d | 8.5% |
| 46+d | 16.1% |
| (no expiry / parse_err) | 11.3% |

The draft bucketing roughly matches the natural distribution. **Recommend adding 0DTE as its own bucket** — it's 18.5% of the corpus and structurally different from 1-3d.

2. New config keys: `grader.target_pct.0dte`, `grader.target_pct.1_3d`, `grader.target_pct.4_14d`, `grader.target_pct.15_45d`, `grader.target_pct.46d_plus`. Currently single global `grader.target_threshold_pct=0.5%` (target for all underlying-axis grading).

3. DTE-extraction helper in grader (compute dte from `expiry - created_at`).

4. `getTargetThreshold()` becomes per-DTE.

5. `computeSpecialistOutcome()` takes DTE bucket → threshold.

6. **Calibration analysis** (this is the hard part): set the per-bucket thresholds correctly. 0.5% for 0DTE is way too tight (0DTE moves are 1-2% routinely); 0.5% for 46+d may be too loose (46d move >0.5% is barely noise). **Defaults from gut:**
   - 0DTE: 0.8% (move must clear noise)
   - 1-3d: 0.6%
   - 4-14d: 0.5%
   - 15-45d: 0.4%
   - 46+d: 0.4%

   These are guesses. Real calibration requires a backtest of the last 30d at varying thresholds and choosing the value that maximizes precision-without-killing-recall.

7. Re-grade last 7d through new logic + verify shifts. **Catastrophic flips → investigate, not ship.**

**Verdict — NOT SHIPPING TONIGHT.**

- Code mechanics: 1.5-2 hr
- Calibration analysis to set bucket thresholds: 2-3 hr terminal-mode work (best done in dedicated session, not 11pm Friday)
- Re-grade verification: 1 hr
- Total: ~5-6 hr, with the calibration being the load-bearing piece
- Half-shipping (= shipping schema + code with default 0.5% across all buckets) doesn't change behavior. Pointless.

**Recommend:** Saturday morning — first run the calibration analysis as a Q1-style terminal pass. THEN Saturday afternoon ship code + thresholds together.

## Item 6 — P0 #2 (per-option-symbol track dedup)

**Audit result:** Sampled 3,000 of 3,465 WORKING tracks (87% of population). **ZERO duplicate option_symbols** in WORKING set. The Apr 28 partial UNIQUE INDEX (`ct_contract_tracks_option_symbol_working_uniq`) is holding.

REALIZED + EXPIRED row counts are 0. **Every track is WORKING.** That's a separate observation worth flagging — no track ever transitions to REALIZED/EXPIRED. Might be a track-state-machine bug, not a dedup bug.

**Verdict — NO DEDUP GAP TO FIX.**

- Original brief said "Diagnostic ran previously; dedup gap confirmed" — diagnostic context missing same as P2 #10
- Direct DB inspection shows the dedup index is enforced
- Possible the gap was fixed by the Apr 28 index landing and the punch-list item is stale
- OR the gap is somewhere I'm not seeing (e.g., a different status, a JOIN that double-counts)

**Recommend:** flag for archeology Saturday — pull the original diagnostic OR re-run it to confirm whether the gap exists. If yes, scope the actual gap. If no, archive the punch-list item.

## Item 7 — P0 #3 (per-alert score-race coverage audit)

**Score-race fix history:**
- `f5f2c4e fix(signature-watcher): score-first cron + backfill today's score=0 flags` (Apr 27)
- `e88cc79 fix(signature-watcher): inline per-alert score recovery + zero backfill` (Apr 28)

**Score-write surfaces (ct_scored_flow.score writers):** 10 functions touch `ct_scored_flow`. Most are read-only consumers. Need to grep precisely for INSERT/UPDATE on the score column. Tonight's quick scan found the writers via grep but didn't analyze each call site for race protection.

**Verdict — AUDIT INCOMPLETE.** Real audit (read each writer, confirm score is INSERTED before any consumer reads it, AND consumer's read-after-write barrier exists) is ~1.5-2 hr of careful code-reading. Shipping a "fix" without the audit risks introducing the very class we're trying to kill.

**Recommend:** Saturday morning — agentic read-pass on the 10 writers, classify each as "score-first guaranteed" / "race risk" / "consumer only." Document. If risks found, scope individually.

## Item 8 — Q1: detector lifecycle threshold analysis

See companion file: [`2026-05-02-detector-lifecycle-thresholds.md`](./2026-05-02-detector-lifecycle-thresholds.md)

## Item 9 — Q2: docs/detectors/ + README

Created `docs/detectors/README.md` as the index template + 14 detector inventory rows. Placeholder, ready for Phase B Mon-Tue-Wed authoring per the #10 Phase A schedule.

## UW budget — end of session

Pre-audit: 65.4% (13,071 / 20,000). Post-audit: still 65.4% — none of tonight's work made UW calls. ✓ guardrail.

## Warden — end of session

Spot-checked at start (post-flag-grader-revert green) and final commit. `current_status != 'pass'` returns `[]`. ✓ green throughout.

## Net for the night

Items shipped: 1 (LB8 audit doc), 2 (Q3 + Q4 reports), 9 (Q2 dir + README), and Q1 (detector thresholds analysis).
Items deferred with reasoning: 3 (biases archive — pending James decision), 4 (P2 #10 — diagnostic context missing), 5 (P0 #1 DTE buckets — calibration is the load-bearing piece, do it Sat AM in dedicated session), 6 (P0 #2 dedup — no current gap visible, need archeology), 7 (P0 #3 score-race audit — full audit is 1.5-2hr, defer to Sat AM).

Class-kill discipline upheld on P0 #1 and P0 #3 (and effectively on P0 #2 by surfacing "no gap" before shipping a non-fix).
