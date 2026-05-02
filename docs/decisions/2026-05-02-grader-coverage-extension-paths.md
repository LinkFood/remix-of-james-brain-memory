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
