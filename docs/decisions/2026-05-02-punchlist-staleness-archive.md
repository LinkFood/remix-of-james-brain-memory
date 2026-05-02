# 2026-05-02 — Punchlist Staleness Archive

**Decision date:** 2026-05-02
**Decision class:** Doc-only / scope hygiene
**Source pattern:** `docs/runbooks/punchlist_staleness.md`

## Context

The Co-Trader playbook punchlist accumulated four items added pre-2026-05-02 that, on a Saturday-night relevance audit, no longer survive scrutiny. The system's empirical evolution (detector lifecycle, Specialist Scoreboard v2, the 2026-04-28 UNIQUE INDEX, Saturday's audit findings) has either superseded, resolved, or invalidated the original framing of each item.

Per Tenets 14 and 25 ("built to evolve, not to be right on day 1" / "evolves in STRUCTURE, not just within structure"), punchlist items are theory at insertion time. Architecture lands → the theory needs re-checking. This is that audit.

This decision documents the archive — what was on the list, why each item is leaving the list, what handles the underlying need now, and what would re-trigger investigation.

---

## Item 1 — P0 #0. Re-poll canonical week + diff signature corpus

**Status: ARCHIVED — SUPERSEDED**

### Original framing
- Detector predicates were built off the 2026-04-20 → 2026-04-24 canonical corpus.
- That corpus reads from `ct_contract_tracks.peak_contract_pct`; ~60% of tracks had `peak=0` because the poller couldn't keep up before the throughput bump.
- Solution proposed: a one-shot re-poll of the canonical week, then diff `ct_signature_magnitude_stats` pre/post. Estimated cost ~5–15K UW calls.
- Listed as P0 because "every day we don't run it, new flags fire on a biased corpus."

### Why obsolete
The detector portfolio (Tenet 8) is now empirical and continuous, not one-shot. Specifically:

- **`ct_detector_lifecycle_state` table** (created 2026-05-02 commit `9504dcb`) tracks each detector's `proposed_status` stability across nightly runs.
- **`ct-detector-scoreboard-update` cron** computes composite hit rate continuously across a rolling window.
- **K=4 stability gate** ensures a detector's status (shadow → trial → live → decay) is earned over 4 consecutive nights of agreeing observations — not declared by a single empirical re-poll.

`signature_v1` now earns its lifecycle status the same way every other detector does — via continuous grading, not a one-shot canonical-week tune.

### Architecturally what handles this need now
The detector portfolio is a database (`ct_detectors` rows + `ct_config` thresholds + `ct_detector_lifecycle_state` history). Recalibrating a detector means adjusting `ct_config` thresholds and letting the lifecycle cron observe over 4 nights. There is no longer a "canonical-week corpus" that has to stay current — the system regrades against rolling windows on a cadence.

### What to do if the underlying need re-surfaces
- Query `ct_detector_scoreboard` for the suspect detector's `hit_rate_30d` trajectory.
- If decay is real, the lifecycle cron will propose status downgrade automatically.
- If you need faster signal, lower K in `ct_config.detector.lifecycle.stability_runs` for that detector class.
- A re-poll is only justified if you suspect *poller throughput drift* rather than detector tuning. Not the case as of 2026-05-02.

### Cost saved by archiving
~5–15K UW calls. Material against current daily budget.

---

## Item 2 — P0 #1. DTE-bucketed win threshold (grader)

**Status: ARCHIVED — SUPERSEDED**

### Original framing
- Single 50% premium-peak threshold treats 0DTE and 30DTE flags identically.
- Today's mid-DTE high-conviction flags peaked at +7–11% but graded `partial` because none hit +50%.
- Proposed fix: DTE-bucketed `alarmWinPct` in `ct_flag_grader/index.ts` (50% / 30% / 15% / 10% by bucket), mirrored to `ct_config`.

### Why obsolete
Specialist Scoreboard v2 (commits `4bc606a`, `65d8996`, `f36da46`, shipped 2026-05-02 ~05:30 UTC) makes DTE-relative timing structural rather than threshold-driven:

- **`ct_specialist_grade_axes`** adds 4h / 1d / 3d underlying-axis windows on `ct_price_bars`.
- **`blended_verdict`** combines premium-axis + multi-horizon underlying-axis outcomes.
- 0DTE flags get pending → graded within the 1d window naturally; 30DTE flags get the 3d window. The DTE structure is in *which window resolves the flag*, not in a per-DTE percentage threshold.

Adding DTE buckets to the v1 premium-only grader would now be redundant with v2's underlying-axis grading.

### Architecturally what handles this need now
v2 multi-axis grading. Premium-axis from `ct_contract_tracks` (still uses 50% peak — that's a separate signal about contract movement, not about whether the trade idea was right). Underlying-axis from `ct_price_bars` at 4h/1d/3d does the DTE-structural work.

### What to do if the need re-surfaces
v2 is already DTE-structural. If explicit DTE-bucket scoreboard slicing becomes useful (e.g., "are 0DTE specialist reads better than 30DTE?"), add a `dte_bucket_at_fire` column to `ct_specialist_grade_axes` and re-aggregate `scoreboard_v2` across (specialist × regime × dte_bucket × window). This is a cleaner extension than retro-fitting v1's grader.

---

## Item 3 — P0 #2. Per-option-symbol track dedup (print-grader)

**Status: ARCHIVED — RESOLVED**

### Original framing
- Diagnostic concern about duplicate WORKING tracks for the same `option_symbol` (one contract being multi-tracked).
- WORKING pool had been seen at 6,990 tracks for ~4,400 unique option symbols (1.6× dup ratio).
- Proposed fix: print-grader UPSERTs on `(option_symbol)` instead of INSERTs per print.

### Why obsolete — no gap
The 2026-04-28 partial UNIQUE INDEX `ct_contract_tracks_option_symbol_working_uniq` already structurally prevents duplicate WORKING tracks (Tenet 15 — class becomes impossible).

Saturday-night audit (2026-05-02 ~01:30 UTC) sampled 3,000 of 3,465 current WORKING tracks. **Zero duplicates found.** The index is holding.

### Architecturally what handles this need now
The DB-layer UNIQUE INDEX on `ct_contract_tracks (option_symbol) WHERE status = 'WORKING'`. The class is structurally impossible. No further work needed.

### What to do if the need re-surfaces
If a future audit finds duplicate WORKING tracks, the index would have to be lifted somewhere — investigate **why** before patching. Check for:
- migration that dropped the partial index
- a code path bypassing the canonical insert (writing via raw SQL, different status enum value, etc.)
- enum-rename cases where `WHERE status = 'WORKING'` no longer matches because the value was renamed

The original framing was based on a diagnostic that's no longer current. Fixing instances on top of a working structural prevention would re-introduce the class.

---

## Item 4 — P2 #10. ct_signature_alarm_log → ct_flags 1:1 fix

**Status: ARCHIVED — STALE (archeology needed if re-investigated)**

### Original framing
- Suspected mismatch between signature alarm count and flag count.
- 2026-04-28 diagnostic in playbook claimed: 733 flags vs 610 alarm-log rows = "123 flags missing alarm log entry (16.8%)."
- Proposed fix path: find the path that doesn't write the log row, add the write, audit class becomes impossible.

### Why stale (not obsolete)
Saturday-night audit (2026-05-02) re-ran the count and found a **different gap shape**:
- `ct_signature_alarm_log` entries: **1,151**
- `ct_flags` signature_alarm rows: **1,399**
- Direction: more flags than alarms — *opposite* of the original framing.

That makes at least three possible gap shapes, none of which are the originally proposed "alarm fires, flag-write fails":

1. **One alarm → many flags:** a single alarm fires multiple flag-writes (cluster path? duplicate consumers?).
2. **Alarms missing flag-write:** alarm fires but flag-writer doesn't pick it up (the original framing).
3. **Non-alarm-path writers tagging `signature_alarm`:** flags being created without going through the alarm path at all.

The original diagnostic context (which exact fired-path was suspected, when the gap was first observed, whether the gap moves with cron re-deploys) is **not in the playbook or `ct_heartbeats`**. Without knowing which gap shape is real, shipping any fix is guessing.

### Architecturally what handles this need now
Nothing — the gap is real but its shape is unknown. We are explicitly *not* shipping a fix on a misunderstood diagnostic.

### What to do if the gap re-surfaces in operational behavior
Trigger condition: `/alarms` or `/flags` shows surprising counts; specialist scoreboard shows lineage misses; warden invariant fails on the alarm-flag relationship.

Order of operations on re-investigation:
1. Re-run the count freshly. The 2026-04-28 diagnostic and 2026-05-02 audit disagree on direction — confirm current state first.
2. Query the alarm-to-flag join with the actual key the system uses. Identify which of the three gap shapes is real.
3. Only then propose a fix to the specific path that's broken.

Tag this as `[needs-archeology]` if it returns to a punch list.

---

## Aggregate impact

- **4 items removed** from `docs/LINKJAC_COTRADER_PLAYBOOK.md` punchlist.
- **~5–15K UW calls saved** by archiving Item 1.
- **Pattern formalized** as `docs/runbooks/punchlist_staleness.md` so future audits run on cadence rather than ad-hoc.

## Related
- `docs/decisions/2026-05-02-saturday-night-audit-results.md` — source of the audit numbers used here.
- `docs/decisions/2026-05-02-phase-a-detector-lifecycle.md` — what supersedes Item 1.
- `docs/decisions/2026-05-02-specialist-scoreboard-v2-design.md` — what supersedes Item 2.
- `docs/runbooks/punchlist_staleness.md` — the pattern lesson this archive instantiates.
