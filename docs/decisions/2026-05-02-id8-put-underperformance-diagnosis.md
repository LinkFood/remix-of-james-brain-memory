# 2026-05-02 — id 8 (put-side −21pp) diagnosis

**TL;DR — half-artifact, half-real.** The −21pp finding splits cleanly:

- **Artifact (≈217 of 431 settled losses):** `ct-signature-watcher/index.ts:174` carries a stale local copy of the RepeatedHits-put inference logic. The 2026-04-28 fix patched `_shared/directionInference.ts` but signature-watcher never imported it — has its own divergent inferPredictedSource(). 100% of signature_v1 puts (and all cluster_slow_stacker / cluster_default puts) are tagged `direction='bullish'` regardless of actual flow. Grader is correct; flag direction is wrong; verdict is wrong.
- **Real residual (n=214 settled, hit rate 40.9%, −11.2pp vs 52.1% baseline):** correctly-tagged puts still underperform modestly. Plausibly regime mismatch (the 30d window is dominated by chop + trending_up; put thesis is structurally harder in those regimes). Could also be detector quality differences (zerodte_put_voi_extreme_v1 fires riskier setups).

**Recommendation:** Hold validation of id 8 in current form. Fix the live bug, re-tag historical, re-grade, then re-run the slice. The "real" residual at n=214 will decompose into regime-conditional or detector-specific cells once cleaned.

**C1 window note (escalates to James):** the fix touches no v2 RPC code, but re-grading historical puts mutates `ct_specialist_grade_axes` rows that feed `ct_specialist_scoreboard_v2` — which is the C1 measurement. Two routes; both need your call.

## Evidence chain

### 1. Cross-tab by (side, direction) on 1,322 settled rows

| side | direction | n | hr_weighted |
|--|--|--:|--:|
| call | bullish | 876 | 0.623 |
| **put** | **bullish** | **217** | **0.214** |
| put | bearish | 214 | 0.409 |
| call | bearish | 15 | 0.600 |

The 20pp gap inside the put cohort split by direction is the signature of a tagging bug — real signals don't show 20pp swings between flag-direction labels on the same option side.

### 2. Detector-level breakdown of put flags

100% direction-tagging by detector (any verdict):

| detector | n puts | direction tagging |
|--|--:|--|
| whale_v1 | 612 | 100% bearish ✓ |
| unusual_oi_v1 | 463 | 100% bearish ✓ |
| weekly_atm_voi_v1 | 161 | 100% bearish ✓ |
| zerodte_put_voi_extreme_v1 | 144 | 100% bearish ✓ |
| **signature_v1** | **225** | **100% bullish ✗** |
| **cluster_slow_stacker** | **25** | **100% bullish ✗** |
| **cluster_default** | **12** | **100% bullish ✗** |

The four correctly-tagging detectors all use either explicit aggressor flags (UW occasionally sets them on whale-class alerts) or the fixed `_shared/directionInference.ts`. The three mis-tagging detectors all flow through `ct-signature-watcher`.

### 3. Verdict by detector on settled put flags

| detector | settled | hit rate | observation |
|--|--:|--:|--|
| signature_v1 | 181 | **0.218** | the artifact bucket |
| cluster_default | 12 | 0.167 | also routes via signature-watcher |
| cluster_slow_stacker | 23 | 0.196 | also routes via signature-watcher |
| zerodte_put_voi_extreme_v1 | 34 | 0.338 | real signal — risky 0DTE puts |
| unusual_oi_v1 | 113 | 0.385 | real signal — slightly under baseline |
| whale_v1 | 45 | 0.500 | baseline |
| weekly_atm_voi_v1 | 5 | 0.600 | n too small |

**The three detectors that flow through signature-watcher's mis-tagging cluster at hit rates 16-22%.** Detectors that tag puts correctly cluster at 34-50%.

### 4. Post-fix evidence

After 2026-04-28 13:30 UTC (fix to `_shared/directionInference.ts`):

| detector | post-fix put count | direction tagging |
|--|--:|--|
| whale_v1 | 479 | 100% bearish ✓ |
| unusual_oi_v1 | 269 | 100% bearish ✓ |
| weekly_atm_voi_v1 | 117 | 100% bearish ✓ |
| zerodte_put_voi_extreme_v1 | 89 | 100% bearish ✓ |
| **signature_v1** | **25** | **100% bullish ✗** |
| **cluster_slow_stacker** | **2** | **100% bullish ✗** |

The shared-helper fix propagated to detectors that import inferDirection. signature-watcher and the cluster detectors that route through it continue producing bullish puts because they don't import `inferDirection` — they have local `inferPredictedSource()` (signature-watcher) or use signature-watcher's source as input.

### 5. The live bug

`supabase/functions/ct-signature-watcher/index.ts` lines 152-185 — local function `inferPredictedSource()`:

```ts
function inferPredictedSource(row: FlowAlertRow): string | null {
  const side = (row.side ?? '').toLowerCase();
  // ...
  if (alertRule.startsWith('RepeatedHits')) {
    sourceTag = side === 'call' ? 'ask' : 'bid';   // <-- LINE 174: puts mis-mapped to bid
  }
  // ...
  return `aggressive_${sourceTag}_${side}`;
}
```

The `aggressive_bid_put` label flows downstream to line 574-576:

```ts
direction = source === 'aggressive_ask_call' || source === 'aggressive_bid_put' ? 'bullish' : ...
```

So `aggressive_bid_put` → `direction='bullish'`. The mapping at line 574 is correct under standard semantics ("aggressive bid on a put = put-seller, bullish"). The bug is upstream at line 174: RepeatedHits is accumulation = buying. For puts that's ask-aggressive, not bid-aggressive. The shared helper at `_shared/directionInference.ts:82-88` was fixed for this exact reason. Signature-watcher's local copy was missed.

### 6. Population stratification with bug isolated

| filter | n | hit_rate | Δ vs baseline (0.521) |
|--|--:|--:|--:|
| all puts | 431 | 0.311 | **−0.210** |
| puts EXCLUDING the three buggy detectors | 215 | **0.409** | −0.112 |
| puts WITH `direction='bearish'` (correctly tagged) | 214 | **0.409** | −0.112 |
| puts WITH `direction='bullish'` (suspect tagging) | 217 | 0.214 | −0.307 |

The bullish-tagged-put bucket is ~50% of the put population by n. Removing it halves the apparent underperformance. The residual −11.2pp on correctly-tagged puts is plausibly real but much weaker than the headline number suggested.

## Fix paths

### Path A — code fix only, no historical re-grading

1. Edit `ct-signature-watcher/index.ts:174` to `sourceTag = 'ask'` (both sides). Better: replace local `inferPredictedSource()` with import from `_shared/directionInference.ts` so future fixes propagate automatically.
2. Redeploy `ct-signature-watcher` (and any other functions sharing this stale logic — grep for the pattern).
3. Going forward, signature_v1 puts get tagged correctly. Backlog stays mis-tagged.

**Pro:** 30-minute fix, zero C1-window perturbation. **Con:** the corpus continues showing −21pp until the mis-tagged backlog ages out. Forensic re-runs over the next 30 days will keep flagging the same artifact pattern.

### Path B — code fix + historical re-tag + re-grade

Steps 1-2 above, plus:

3. UPDATE `ct_flags` SET direction='bearish' WHERE detector_id IN ('signature_v1','cluster_slow_stacker','cluster_default') AND side='put' AND fire_ts < (fix deploy ts). Affects ~225 rows.
4. DELETE corresponding rows from `ct_flag_grades` and `ct_specialist_grade_axes` (force re-grade on next grader cron). Affects ≤225 rows.
5. Re-run `corpus_baseline + find_anomalies` to confirm put cohort lifts to baseline-ish.

**Pro:** corpus is methodologically clean. id 8 either disappears or surfaces as a much smaller real-residual signal.
**Con:** Step 4 mutates `ct_specialist_grade_axes` rows mid-C1-window. Specialist v2 scoreboard (which is the C1 measurement) re-recomputes on changed inputs. The C1 acceptance review on 2026-05-15 sees a corpus that was retroactively cleaned — falsifiability is preserved (you can compare scoreboard before vs after cleanup) but the experimental clarity is reduced.

### Path C — Path B but defer step 4 to post-2026-05-15

1-3 above ship now. Step 4 (re-grade) waits until C1 closes 2026-05-15. Until then, corpus shows the artifact in its current form; we know what it is and stop re-validating it weekly.

**Pro:** clean fix going forward, C1 window protected, only ~13 days of "we know this is the artifact" wait. **Con:** Track 4 (weekly cadence) effectively waits 13 days too — first useful run is 2026-05-16 Saturday.

## Recommendation

**Path C.** Ship the live bug fix now (line 174 + redeploy). Skip historical re-tag and re-grade until 2026-05-16. This:

- Stops new bullish-put-mis-tagging immediately (fixes are backward-incompatible only on data, not on going-forward correctness).
- Protects C1 window measurement integrity through 2026-05-15 acceptance review.
- Lets us mark id 8 status='deprecated' with documented reason (artifact-driven), and re-capture the residual signal as a NEW pattern post-cleanup.

**Track 4 (weekly cadence) holds until 2026-05-16.** Running it weekly for 13 days produces 2-3 Saturday reports of "puts −21pp" as the same artifact churns through. Not useful.

## What to do with id 8

Mark **deprecated** with note: "Diagnosed 2026-05-02 23:55 UTC as half-artifact. ~50% of settled put losses came from `ct-signature-watcher`'s stale RepeatedHits-put inference (mis-tagging direction='bullish'). Real residual is −11.2pp on n=214 correctly-tagged puts; capture that as a new pattern post-fix per Path C."

## Open questions for James

1. **Path A, B, or C?** My recommendation is C. Override if you want B (same-night cleanup) or A (no historical touch ever).
2. **Replace local `inferPredictedSource()` with shared-helper import?** I'd say yes — the divergence is exactly what created this bug. Costs nothing structurally, prevents recurrence.
3. **Hold Track 4 until 2026-05-16?** My default. Alternative: run it weekly anyway, but exclude the 3 buggy detectors from anomaly scans (single SQL filter in find_anomalies's dimension list).

## Files touched (none yet — Phase A diagnosis only)

- (proposed) `supabase/functions/ct-signature-watcher/index.ts` line 152-185 — replace local `inferPredictedSource()` with `import { inferDirection } from '../_shared/directionInference.ts'` wrapper.
- (proposed) UPDATE `ct_flags` re-tag + DELETE re-grade — only under Path B/C step 4.
- ct_observed_patterns id 8 — mark deprecated post-decision.

Awaiting your call.
