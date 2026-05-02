# 2026-05-02 — Grader coverage extension: Path A vs Path B (Phase A — design only)

**Goal:** unblock the forensic post-op platform's data thinness. The corpus currently has 5,255 flags with only **90 multi-axis grades** (`ct_specialist_grade_axes`); 5,165 detector-fired flags have no entry there. Slice cells stay tiny.

**Phase A deliverable:** scope both paths, surface tradeoff, recommend. **No build until James picks.**

## The actual fact that decides this

`ct_flag_grades` already contains **1,407 graded rows** with a clean distribution:

| outcome | n |
|--|--:|
| partial | 346 |
| win | 280 |
| loss | 275 |
| invalidated_early | 99 |

That's 15.6× the multi-axis grader's coverage. **The data already exists** — it's just not joined into the corpus.

Schema: `id, flag_id, specialist_ticker, graded_at, outcome, price_at_horizon, price_change_pct, spy_change_pct, alpha_pct, notes`. Single-axis (one outcome per flag), underlying-anchored, alpha-vs-SPY scored. Horizon implicit in `ct_flags.horizon_hours`.

Source-coverage: `ct-flag-grader/index.ts` writes to this table for **all sources** (specialist / james_star / signature_alarm / detector_alarm) — no source filter. So whale_v1, signature_v1, unusual_oi_v1 etc. flags are already graded here. Cron `*/30 13-20 * * 1-5` (RTH every 30 min).

This means the bottleneck wasn't a grader gap — it was an **MV join gap.**

## Path A — extend Specialist v2 RPC to grade detector flags into `ct_specialist_grade_axes`

**Code site:** `supabase/migrations/20260502040600_specialist_v2_score_rpc.sql`. The gate is line 104: `WHERE f.specialist_ticker IS NOT NULL`. Drop it and detector flags become eligible.

**But it's not that simple.** The RPC was designed around specialist context:

- **Premium axis** (lines 122-154) reads `ct_contract_tracks` for the flag's `option_symbol` ± 2hr. Detector flags have option_symbol → ✅ works.
- **Underlying axes 4h/1d/3d** (lines 156-220+) read `ct_price_bars` for the flag's `instrument`. Universe-locked → ✅ works.
- **Specialist read streak / blended verdict** (lines 419-441 per the explore agent) joins `ct_specialist_reads` keyed on `specialist_ticker`. Detector flags have **no specialist_ticker** → would need the join to handle NULL, OR fall back to `instrument`, OR drop the streak component for non-specialist flags.
- **Conviction calibration** populates `ct_specialist_conviction_calibration` from specialist read conviction. Detector flags have no conviction → would skew calibration if mixed.

**Effort estimate:** 1-3 days of careful work.
- Map every specialist_ticker dependency in the RPC body.
- Decide per dependency: NULL-safe / fallback to instrument / skip for non-specialist source.
- Decide whether to write detector grade rows into the same `ct_specialist_grade_axes` table (mixing schemas) or a parallel `ct_detector_grade_axes` (cleaner separation).
- Re-run grade backfill across the existing 5,165 detector flags.
- Verify the existing 68 specialist-source settled rows aren't perturbed.

**Risk: high.** Touches a load-bearing nightly RPC during the C1 verification window (through 2026-05-15 — see Tenet 13 / preamble freeze, `feedback_co_trader_thesis.md`). Every row added to `ct_specialist_grade_axes` flows into `ct_specialist_scoreboard_v2` → contaminates specialist hit-rate metrics if rows from non-specialist sources are mixed in.

**Reward: full multi-axis coverage** (premium + 4h/1d/3d + blended) on every flag. Right structural fix.

## Path B — extend the MV to LEFT JOIN `ct_flag_grades`

**Code site:** `supabase/migrations/20260502060000_ct_flag_analysis_corpus.sql`. Add one more LEFT JOIN, normalize verdict columns.

```sql
-- Inside the corpus MV definition:
LEFT JOIN public.ct_flag_grades fg ON fg.flag_id = fb.flag_id

-- Add columns:
fg.outcome             AS legacy_grade_outcome,
fg.price_change_pct    AS legacy_grade_price_change_pct,
fg.alpha_pct           AS legacy_grade_alpha_pct,
fg.spy_change_pct      AS legacy_grade_spy_change_pct,
fg.graded_at           AS legacy_graded_at,

-- Unified verdict + provenance:
COALESCE(
  ga.blended_verdict,
  CASE fg.outcome
    WHEN 'invalidated_early' THEN 'loss'   -- treat invalidations as losses for hit-rate math
    WHEN 'win'     THEN 'win'
    WHEN 'loss'    THEN 'loss'
    WHEN 'partial' THEN 'partial'
    ELSE NULL
  END
)                      AS unified_verdict,

CASE
  WHEN ga.blended_verdict IS NOT NULL THEN 'specialist_v2_multiaxis'
  WHEN fg.outcome         IS NOT NULL THEN 'legacy_single_axis'
  ELSE NULL
END                    AS grade_source,
```

Then in the helper RPCs (`corpus_baseline`, `slice_by`, `find_anomalies`) — switch hit-rate computation from `blended_verdict` to `unified_verdict`. **One column rename per RPC, that's it.**

**Effort estimate: 2-3 hours.**
- One migration: rebuild MV with the LEFT JOIN.
- One migration: rebuild three helper RPCs to use `unified_verdict`.
- Rebuild the warden invariant if needed (probably unaffected — it checks freshness, not verdicts).
- Verify the same Phase 4 baseline + slices + anomalies output, expanded to 1,407 settled rows.

**Risk: low.**
- No grader logic touched. ct-flag-grader keeps writing where it always has.
- Specialist v2 scoreboard untouched. C1 window unaffected.
- MV rebuild is idempotent (DROP + CREATE).
- The only real call is the `invalidated_early → loss` mapping. Could equally map to a new fifth verdict bucket if you want it visible.

**Reward: instant 15.6× corpus expansion** for forensic analysis. From 68 settled → ~900 settled (estimate: 1,407 minus 99 invalidated minus the 90 already counted under specialist v2 ≈ 1,200+ unique). Every slice gets statistical power. Pattern capture threshold (N≥30) becomes routinely achievable.

**Cost: single-axis only for detector flags** — no per-horizon (4h/1d/3d) breakdown for them. The horizon is implicit in flag.horizon_hours; you can still slice by horizon, but the per-row outcome is one number, not three.

## Side-by-side

| | Path A (extend RPC) | Path B (extend MV) |
|--|--|--|
| Effort | 1-3 days | 2-3 hours |
| Risk | High (grader logic touched, scoreboard contamination, C1 window) | Low (MV + RPCs only) |
| Touches preamble freeze? | Indirectly yes (specialist scoreboard inputs change) | No |
| Multi-axis on detector flags? | Yes (premium + 4h/1d/3d) | No (single-axis only) |
| Time to first analysis | Days | Hours |
| Settled-N gain (corpus) | ~5,000+ when fully backfilled | ~1,200+ immediate |
| Partial axis (premium) bug fix? | Required as part of build | Independent (Track 2) |
| Reversibility | Hard (grade rows persist) | Trivial (DROP + recreate MV) |

## Recommendation

**Ship Path B now. Defer Path A.**

Reasoning:
1. **Path B unlocks 1,200+ settled rows in 3 hours** — enough to clear N≥30 across every dimension we tested. The forensic platform becomes useful tonight or tomorrow morning.
2. **Path A is the "right" structural fix but not the right *next* fix.** Doing Path B first lets us empirically learn whether multi-axis (4h/1d/3d split) is actually what we need on detector flags, or whether single-axis is enough. We may find detector flags are well-served by single-axis grading and Path A becomes optional.
3. **C1 verification window forbids Path A safely.** Through 2026-05-15 we shouldn't be modifying the specialist v2 grader RPC — that's exactly the system being measured. Path B doesn't touch it.
4. **Path B is reversible.** If the unified-verdict approach turns out to muddy hit-rate semantics, drop the MV and revert in 5 minutes. Path A's grade rows persist in the table forever.

**Suggested sequence:**
- Phase B1 (now, 2-3h): extend MV + helper RPCs. Re-run baseline + slices. Capture Path B-validated patterns.
- Phase B2 (post-2026-05-15, when C1 closes): re-evaluate whether Path A's multi-axis gives meaningful additional signal beyond Path B's single-axis. If yes, build Path A. If no, document why we're staying with Path B.

If James prefers Path A first, the right phasing is: wait until 2026-05-15, scope the specialist_ticker dependency map, decide separate-table vs same-table for detector grade rows, then build. Don't compress that work into a same-day sprint during the freeze.

## Open questions for James

1. **Invalidated-early mapping.** Currently 99 rows in `ct_flag_grades` have outcome `invalidated_early` (flag's invalidation_price was hit before horizon). Treat as `loss` for hit-rate math (recommended), as `partial`, or carve a fifth `invalidated` bucket?
2. **Grade-source visibility in slices.** Do you want to be able to filter `slice_by(p_filters: {grade_source: 'legacy_single_axis'})` to see specialist-v2 vs legacy distinct? (Easy to add now if yes.)
3. **Premium-axis on detector flags.** Path B doesn't grade premium axis on detector flags — they get `legacy_grade_outcome` only. The forensic doc's premium-axis findings will remain limited to specialist-source rows. Acceptable?

Awaiting your call before Phase B build.

---

## EXECUTED — Path B shipped 2026-05-02 ~23:50 UTC

James called Path B. Migration `20260502070000_corpus_unified_verdict.sql` rebuilt the MV with `ct_flag_grades` LEFT JOIN, added `unified_verdict` / `grade_source` / `verdict_axes_available` columns, recreated all three RPCs against `unified_verdict`. Single commit, MV + RPCs together (the SQL function `corpus_baseline` had a static dep on the MV; CASCADE drop required recreate-in-same-migration).

### Settled-row count: 68 → 1,322

| metric | before (specialist v2 only) | after (unified) | × |
|--|--:|--:|--:|
| total flags | 5,255 | 5,255 | — |
| settled (win/loss/partial) | 68 | **1,322** | 19.4× |
| invalidated (excluded from hit-rate) | 0 | 141 | — |
| pending | 22 | 22 | — |
| ungraded | 5,165 | 3,770 | 0.73× |
| hit_rate_weighted (overall) | 0.5368 | **0.5212** | — |

Settled count exceeded the 1,200 estimate by 122. Acceptance criterion ✅.

### Hit-rate cross-check between graders

The two graders agree to within 1.7pp on weighted hit rate over their respective coverage:

| grade_source | n total | settled | hit_rate_weighted | hit_rate_strict | invalidated |
|--|--:|--:|--:|--:|--:|
| legacy_single_axis | 1,395 | 1,254 | 0.5203 | 0.2895 | 141 |
| specialist_v2_multi_axis | 90 | 68 | 0.5368 | 0.2941 | 0 |
| **delta** | | | **+0.0165** | +0.0046 | |

That's a 1.65pp gap on weighted hit rate over comparable populations. Within sampling noise for these N values. **Combining the two graders into `unified_verdict` is methodologically sound.** Note: legacy is single-axis (underlying at flag.horizon_hours); v2 is multi-axis (premium + 4h + 1d + 3d + blended). The comparison above is `unified_verdict` (= v2.blended for v2 rows, legacy.outcome for legacy rows). Different definitions, agreeing closely — that's the substantive finding.

### New anomaly cells at the LOAD-BEARING threshold (N≥30 settled, |Δ|≥0.10)

Run on unified data, dimensions `instrument / side / direction / time_of_day_bucket / dte_bucket / premium_bucket / aggressor / regime / day_of_week / detector_id / grade_source`:

| dim | value | n | settled | invalidated | hit_rate_unified | Δ baseline (0.521) |
|--|--|--:|--:|--:|--:|--:|
| **side** | **put** | 1,680 | **431** | 70 | **0.311** | **−0.210** ⭐⭐ |
| instrument | TSLA | 499 | 116 | 9 | 0.323 | −0.198 ⭐ |
| detector_id | zerodte_put_voi_extreme_v1 | 144 | 34 | 5 | 0.338 | −0.183 |
| instrument | NVDA | 825 | 212 | 16 | 0.703 | +0.182 ⭐ |
| detector_id | smart_money_repeat_v1 | 392 | 103 | 2 | 0.694 | +0.173 ⭐ |
| instrument | AMZN | 381 | 52 | 11 | 0.663 | +0.142 |
| instrument | SPY | 1,133 | 273 | 20 | 0.403 | −0.118 |
| side | call | 3,498 | 891 | 71 | 0.623 | +0.102 |

**At the strict load-bearing threshold (N≥30 AND |Δ|≥0.20), only put-side underperformance survives.** This is the highest-confidence pattern in the corpus by sample size and effect magnitude.

### What happened to the original 7 captured patterns

Sample expansion (~10× to ~25× per pattern) was a stress test. Most prior patterns were small-sample artifacts in specialist-v2-only data. One held.

| id | original signature | original Δ (n) | unified Δ (n) | new status | reason |
|--:|--|--:|--:|--|--|
| 1 | fri / 3d-axis | +0.17 (40) | +0.05 (44) | deprecated | axis-specific signal; legacy doesn't have isolated 3d-axis |
| 2 | mon / 3d-axis | −0.27 (23) | −0.02 (281) | deprecated | sample 12× → effect collapsed |
| 3 | NVDA / 3d-axis | +0.22 (13) | +0.18 (212) | **VALIDATED** | direction held, magnitude held, sample 16× |
| 4 | GOOGL / 3d-axis | +0.22 (9) | +0.07 (51) | deprecated | small-sample noise |
| 5 | midday_1230_1400 | −0.22 (11) | +0.01 (126) | deprecated | totally vanished |
| 6 | morning_1030_1130 | +0.20 (17) | +0.07 (102) | deprecated | weakened below load-bearing |
| 7 | MSFT / blended | +0.16 (13) | +0.08 (89) | deprecated | weakened below load-bearing |

**1 of 7 (14%) survived the unified scan.** This is honest empirical work — the 6 that didn't survive were noise that the thin specialist-v2 corpus couldn't distinguish from signal. Pattern capture is doing what it should.

### New patterns captured (status='observed', need next-session re-confirmation)

Inserted ids 8-11 (see `ct_observed_patterns`):

- **id 8** — put-side underperformance (Δ −0.210, n=431). Strongest signal; only one clearing strict load-bearing threshold. Cross-references `feedback_direction_inference_repeatedhits_put_inverted.md`.
- **id 9** — TSLA underperformance (Δ −0.198, n=116). May be a downstream of put-side once we can do 2D slices.
- **id 10** — NVDA broad outperformance unified (Δ +0.182, n=212). Companion to validated id=3 — confirms the NVDA effect isn't 3d-axis-specific.
- **id 11** — smart_money_repeat_v1 detector quality (Δ +0.173, n=103). Detector-portfolio signal.

### Open questions surfaced

1. **Is the put underperformance a direction-inference bug or a real bias?** Per `feedback_direction_inference_repeatedhits_put_inverted.md`, RepeatedHits puts must map ask-aggressive to bearish "buying puts." The fix shipped weeks ago. The unified data shows puts at 31.1% hit rate on n=431. Three hypotheses:
   - (a) Residual inference bug not caught by the prior fix (regression test).
   - (b) Universe regime mismatch: chop + trending_up dominate the 30d window; puts naturally underperform in those regimes.
   - (c) Specialist + detectors are systematically over-flagging puts (false-positive rate higher on puts than calls).
   
   Phase 1 audit: run `slice_by('side', filters: {regime: 'chop'})` and `slice_by('side', filters: {regime: 'trending_up'})` once we have multi-filter support. If puts underperform in EVERY regime, hypothesis (a) or (c). If puts underperform only in trending_up, hypothesis (b). Currently slice_by accepts `p_filters jsonb` — works.
2. **Is TSLA underperformance just put-side underperformance in disguise?** TSLA puts probably dominate the cohort. Need 2D slice to disambiguate.
3. **Should id=10 (NVDA unified) and id=3 (NVDA 3d) coexist as observed patterns?** They're effectively duplicate. Decision: keep both — id=3 is a precise 3d-axis-specific claim (validated), id=10 is the broad version (observed). If id=10 confirms next session, deprecate id=3 (subsumed).

### Acceptance summary

✅ Corpus MV refreshed with unified_verdict + grade_source + axes_available.
✅ Settled count jumped to 1,322 (target ~1,200+).
✅ Re-run of corpus_baseline + find_anomalies surfaces meaningful-N anomalies.
✅ 7 prior captured patterns re-validated; 1 promoted, 6 deprecated.
✅ 4 new load-bearing patterns captured.
✅ Decisions doc updated (this section).
✅ methodology-patterns.md created with new entry (`docs/methodology-patterns.md`).
✅ Warden green on corpus_freshness; pre-existing 2-warn telemetry pair persists, unrelated to this work.
