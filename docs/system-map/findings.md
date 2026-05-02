# System Map Findings — 2026-05-02

Synthesis of orphans, missing wires, dormant features, and tenet violations
surfaced by the read-only audit across **163 edge functions / 68 tables /
221 live crons / 12 brain organs / 19 warden invariants / 33 UI pages /
105 hooks**. Honest empirical truth — no soft-pedalling.

## Top findings (highest-leverage first)

### 1. Orphan tables with rows (silent residue)

Tables that exist + have rows + have NO producer found in current code:

| Table | Rows | Status | Action |
|---|---|---|---|
| `ct_dreams` | 4 | Producer not found in `supabase/functions/` or `_shared/` | Dream Mode reflection feature scaffolded then abandoned. **Candidate for archival or revival.** |
| `ct_specialist_memory` | 3 | DEAD-BY-DESIGN per `specialist_memory_table_dead` warden invariant | Confirmed intent. The 3 rows are pre-warden artifacts (the 11 we wrote by accident tonight got cleaned up). Warden enforces the dead path. |
| `ct_specialist_principles` | empty | Zero producers, zero consumers | Schema drift — table created, never wired |
| `ct_weekly_reviews` | empty | Zero producers, zero consumers | Schema drift |
| `deploy_environments` | empty | Zero references | Phase 2 self-deploy scaffolding never wired |
| `deploy_operations` | empty | Zero references | Same |

### 2. Cron coverage gaps (false positives + real concerns)

**False alarm (looked broken but isn't):** Three crons shipped tonight (`ct-detector-scoreboard-update-rth`, `ct-detector-scoreboard-update-offhours`, `ct-eod-specialist-narrative`) have `last_run_at = NULL`. **All three are weekday-only schedules and the audit ran on Saturday.** Will fire Monday at their respective times. The `-weekend` variant of the scoreboard update DID fire at Sat 03:00 UTC successfully — confirms the function works.

**Real concern surfaced:** **`ct-custom-rule-eval` orphan.** Header says "every 5min during RTH" and a migration repeats this in comments, but **no `cron.schedule(...)` block exists** for it in any tracked migration. Either it was never scheduled or the schedule was created out-of-band. **Investigate via direct cron.job query before next session.**

### 3. UI surface drift (34 unimported hooks)

34 of 105 hooks have **zero importers** in `src/pages/` or `src/components/`:

- Examples: `useEvLadder`, `useGexRadar`, `useMarketBreadth`, `useNetPremiumCumulative`, `usePositionSizing`, `useStressScenarios`, `useVoiceAlerts`
- Several look like Pulse / Patterns / EOD / Flags page candidates that those pages don't actually pull from
- Pages `Pulse` / `TapeReader` / `Patterns` / `Flags` / `EOD` / `Jac` / `Settings` / `CtSettings` / `Budget` import **no hooks directly** — they delegate to sub-components, which may or may not pull the data

**Class lesson:** UI hooks are the highest-rate feature-drift surface. Each `feature-X-shipped-but-page-doesn't-render-it` instance is a Tenet 24 violation (silos within the front-end). Worth a Mon pass.

### 4. Tenet 24 violation candidates (data silos)

**Co-Trader → JAC bridges (alive):**
- `ct-reflect-to-jac` writes `jac_reflections` ✓
- `ct-debate-outcome-scorer` writes `brain_insights` ✓
- `_shared/crossFacetMemory.ts` lets ct-chat + ct-session-analog query DCD's `hunt_knowledge` filtered to BRIDGE narratives ✓

**JAC → Co-Trader bridges (zero — by design):**
- No jac-* function reads ct_* tables
- No bidirectional flow

**Within Co-Trader:**
- 4 of 14 detectors don't have `_shared/detectorContext.ts` representation in their primary call sites (specialist_flag, scorer_v1, cluster_*) — they fire flags but the detector context isn't surfaced via the brain organ. Possibly Tenet 24 violation; needs verification before acting.

### 5. Tenet 25 (DB-driven evolution) — confirmed alive

- `ct_detectors` has 14 rows — detectors-as-data is real
- `ct_specialist_prompts` has 20 rows — prompts-as-data is real
- `ct_invariants` has 19 rows — warden-rules-as-data is real
- `ct_detector_lifecycle_state` (shipped tonight) has 14 rows — lifecycle-rules-as-data is real

All four prove the architecture pattern: adding a detector / prompt / invariant / lifecycle rule is a DB INSERT, not a deploy.

### 6. Tenet 26 (three-mode rule) — one violation, one watch

**Confirmed violation:** `ct-backtest-harness` is analysis-mode work living as autonomous infrastructure (per CLAUDE.md tech-debt list). Used by terminal-Claude only. Should ideally be terminal-only invocations against the corpus, not an edge function.

**Watch list (potentially analysis-mode disguised as autonomous):**
- `ct-mcp-shape-probe` (52 LOC) — debug diagnostic still in prod
- `ct-mcp-verify` — similar shape

These could be retired or moved to a `terminal-tools/` directory.

### 7. Heavy-traffic table coverage check

Top 10 tables by row count:

| Table | Rows |
|---|---|
| ct_price_bars | 153,494 |
| ct_technicals | 36,162 |
| ct_contract_quotes | 20,098 |
| ct_scored_flow | 18,309 |
| ct_print_tracks | 17,647 |
| ct_contract_track_alerts | 13,937 |
| ct_contract_tracks | 8,791 |
| ct_pulse_timeline | 7,280 |
| ct_oi_snapshots | 6,379 |
| ct_price_ticks | 5,709 |

All have producers + consumers + brain-organ exposure where applicable. **No top-10 table is orphaned.** Healthy core.

### 8. Detector portfolio status

- 10 of 14 detectors have ≥30 fires last 30d (eligible for lifecycle scoring)
- 4 below floor: `pair_qqq_iwm_v1` (5 fires), `specialist_flag` (0 under detector_id — see specialist note), `scorer_v1` (0), `small_cap_inverted_put_v1` (0)
- 3 detectors had proposed-flips identified by tonight's scoreboard fire; K=4 stability gate prevents actual flip until ~Mon RTH
- All 14 documented in `docs/detectors/`

### 9. ct-flow-ingester schedule overlap

The grep history shows **4 overlapping cron entries** for `ct-flow-ingester` over time (per-ticker RTH, off-RTH, marketwide, legacy `*/3 10-22`). The unschedule-then-schedule pattern in migrations may have left some duplicate active jobs. Worth cron.job direct query Mon to confirm only the intended cadence runs.

### 10. Specialist source flag detector_id gap

`specialist_flag` detector_id row exists in `ct_detectors` for portfolio accounting, but `ct_flags.detector_id` is mostly NULL on specialist-source flags (90 specialist flags lifetime, 0 under the detector_id). The lifecycle scoreboard pathway needs to either:
- Populate detector_id on specialist flag-write, OR
- Add a separate scoreboard pathway joining via `source='specialist'` instead of `detector_id`

Currently specialists are graded via the underlying-axis grader path with n=12, separate from the contract-axis detector lifecycle math.

## Cross-facet wires summary

**Active bridges:**
- ct-reflect-to-jac (daily 22:30 UTC) — Co-Trader → JAC reflections pipeline
- ct-debate-outcome-scorer — writes to JAC's brain_insights
- _shared/crossFacetMemory.ts — DCD hunt_knowledge BRIDGE narratives → Co-Trader chat
- Shared substrate: profiles, generate-embedding, slack-incoming, supabase auth

**Audience-mode firewall (working as designed):**
- `_shared/contextHelper.ts` enforces `audienceFilter` per organ
- `specialist_recall` organ is `cotrader`-only; `paper_claude` consumers see `error='skipped:organ_filter'`
- ct-chat on a non-watchlist ticker fires `tickerCoherenceValidator` warning

## Auto-maintaining the map (stretch goal scope)

**Sketch — `ct-system-map-regen` weekly cron:**

1. Re-runs the programmatic extraction (this session's `/tmp/sysmap_*.{txt,tsv,json}` build)
2. Diffs against current `docs/system-map/` files
3. If diff is non-trivial, opens a PR via the existing code-agent's branch-not-main discipline (`jac/system-map-regen-<hex>`)
4. PR body includes: tables added/removed, edge fns added/removed, cron changes, status flips (LIVE → DORMANT etc.)
5. Cadence: weekly Sun 06:00 UTC (post-weekend, pre-Monday-prep)

**Effort: ~1 day to build.** Would require a shared module that wraps the extraction + diff + PR-open logic. Don't build now — value depends on whether the system-map proves load-bearing for future sessions.

## Recommended next-session work (not actioned tonight)

1. **Investigate `ct-custom-rule-eval` orphan cron** — verify if scheduled out-of-band or genuinely never wired
2. **Audit 34 unimported hooks** — which are dead vs. which want a page
3. **Verify ct-flow-ingester duplicate-cron concern** — direct cron.job query
4. **Clean up `ct_dreams` / `deploy_*` / specialist_principles / weekly_reviews** — archive or revive
5. **Specialist detector_id population** — pick one of the two paths in finding #10
6. **Consider retiring `ct-mcp-shape-probe` + `ct-mcp-verify`** — analysis-mode-disguised debug tools
7. **`ct-backtest-harness` migration to terminal-only** — Tenet 26 cleanup

## What the audit confirmed (good news)

- **0 warden invariants failing** as of audit completion
- **All top-10 traffic tables** have producer + consumer + brain-organ exposure where appropriate
- **Cross-facet bridges are alive** in the intended direction (Co-Trader → JAC), with the firewall working
- **Tenet 25 (DB-driven evolution) is live** across detectors, prompts, invariants, lifecycle rules
- **Synthesis layer is in place** — 12 brain organs are exposed via `_shared/claudeReadSurface.ts` orchestrator
- **All 14 detectors documented** in `docs/detectors/` per the Phase B Mon-Tue-Wed plan

## Honest summary

The system is in better shape than the orphan list suggests. The ~5 truly orphaned tables represent <0.5% of total rows (essentially zero data lost). The 34 unimported hooks are mostly UI scaffolding that hasn't been wired to pages yet — annoying but not broken. The Tenet 26 violation (`ct-backtest-harness`) is documented and intentional-for-now. The remaining concerns are tractable and surfaced.

The system map is now a load-bearing reference. Update via the regen sketch or by hand on major refactors.
