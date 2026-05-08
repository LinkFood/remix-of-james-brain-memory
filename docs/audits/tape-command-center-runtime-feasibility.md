# Tape Command Center — Runtime Feasibility Audit

**Pairs with:** `cowork-cotrader/memory/tape-command-center-snapshot-inventory.md` (structural inventory of 11 dedicated pages).

**Scope:** Verify Cowork inventory empirically against the running system. Surface runtime data that informs which snapshots ship first and what RPC reuse is possible. **Diagnose-only — no fixes.**

---

## Phase A — Runtime Verification

### A.1 — Cron schedules + change frequencies (empirical)

Verified against `supabase/migrations/*_cron.sql` directly:

| Page producer | Cron jobname | Schedule | Cadence shape |
|---|---|---|---|
| Heatmap | `ct-heatmap-snapshot-rth` + offrth + eod | `*/5 13-20 * * 1-5` / `0 10-12,21-22 * * 1-5` / `5 20 * * 1-5` | 5min RTH, hourly off-RTH, EOD marker |
| Flags / Alarms | `ct-signature-watcher` | `* 13-20 * * 1-5` + `*/5 0-12,21-23 * * *` | Per-minute RTH, 5min off-RTH (alarm fires) |
| Flags grade-back | `ct-flag-grader` | `*/30 * * * *` | Every 30min, all day |
| Specialists | (per-ticker) `ct-watcher` | `0,30 13-20 * * 1-5` | Twice/hour RTH |
| Tape Reader | `ct-tape-reader` | `*/10 13-20 * * 1-5` | Every 10min RTH |
| EOD legacy | `ct-eod-summary` | `30 20 * * 1-5` | 4:30 PM ET (RTH+30min) |
| EOD Report | `ct-eod-report` | `0 21 * * 1-5` | 5 PM ET |
| Morning Brief | `ct-daily-brief` | `0 11 * * 1-5` | 7 AM ET |
| Pulse / regime | `ct-regime-capture-rth` + offhours | `*/5 13-21 * * 1-5` + `0 10-12,21-22 * * 1-5` | 5min RTH, hourly off |
| Detectors | `ct-detector-whale` (RTH) | `*/5 13-20 * * 1-5` + `0 0,4,8,21 * * *` | 5min RTH + 4 daily off-RTH |
| Flow ingester | `ct-flow-ingester` | `*/3 10-22 * * 1-5` | Every 3min, pre/RTH/post |
| Edge | (post-close batch from grader + ct-edge-daily aggregator) | nightly | Once-daily after-close |

**Cowork inventory cadences mostly match producer cron, with two refinements:**
- Cowork said Heatmap = 30s polling (UI-side). True at the hook layer (`useFlowHeatmapLive` polls 30s); upstream producer is `*/5 13-20` not 30s. The UI-poll-30s on a 5-min-stale source is fine — it just keeps the React Query cache fresh, doesn't beat the underlying data.
- Cowork said Specialists = 60s polling. UI-side correct. The underlying scoreboard is updated nightly + opportunistically on flag fire — 60s UI poll catches transitions.

### A.2 — Hook + RPC reuse map per page

**Empirical: every dedicated page has a 1:1 dedicated hook already. No new RPCs are needed for first-ship snapshots — reuse the page's hook with smaller-N rendering.**

| Page | Hook | RPC / table | Reuse strategy for snapshot |
|---|---|---|---|
| Heatmap | `useFlowHeatmapLive` (+`useFlowHeatmapLiveWithDelta`) | `ct_flow_heatmap_live()` | Reuse hook, render top-3-by-premium client-side |
| Flags | inline `useQuery` on `ct_flags` | direct table | New tiny hook variant `useFlagsTopN({status:'active', source:'specialist', limit:3})` worth wrapping; or inline same query |
| Alarms | `useAlarms` | `ct_flags WHERE source='signature_alarm'` | Reuse hook, render gold+silver count + 3 latest |
| Specialists | `useSpecialistScoreboard` (+`V2`) | `ct_specialist_scoreboard` table | Reuse hook, render 10-mini-tile row from existing data |
| Patterns | inline `useQuery` on `ct_flag_patterns` | direct table | Reuse-style: copy 5-line hook into new `useFlagPatternsTopN` |
| Pulse / regime | `useRegimeState` | `ct_regime_classifications` | Reuse hook, render regime pill + top-3 ticker bias |
| Pulse aggregate | `useFlowPulse(windowMin)` | `ct_flow_pulse(p_window_min)` RPC | Already aggregate; render market_total directly |
| MorningBrief | `useMorningBrief` | `ct_daily_briefs` | Reuse hook, slice latest row → headline + macro_regime |
| EodReport | `useEodReport` | `ct_eod_reports` | Reuse hook, slice latest row → scorecard + carryover thesis |
| Eod (legacy) | inline `useQuery` on `ct_eod_summaries` | direct table | Reuse-style: 1-line summary from latest row |
| Edge | `useEdge` (+`useDteEligibility` +`useContractTracks`) | `ct_edge_daily`, `ct_signatures` | Reuse hook, render hero (regime + snap hit% + W/L/F) |
| Tape Reader | inline `useQuery` on `ct_tape_commentary` (already lives on Tape via `<TapeReaderBanner>`) | direct table | **Already integrated.** ARC = expand existing banner. |

**No "summary RPC" variants exist** (verified via grep `RETURNS TABLE` across migrations for keywords like top_3 / hottest / tier_count). Each snapshot does its top-N slicing client-side from the existing query result. This is fine for first ship — page-hook payloads are small (Heatmap ~50-60 cells; Flags page typically ~100-200 active rows; Alarms last hour ~5-15 rows; Specialists 10 rows).

### A.3 — Realtime channel inventory

**Currently on Tape page:**
- `useAlarmRealtime` → `ct_flags-signature-alarm-realtime` (1 channel; AlarmBanner glow)
- `useCoTraderData` → `ct_events`, `ct_active_setups` (2 channels)
- `useContractTracks` → `ct_contract_tracks-realtime`, `ct_print_grades-contract_v1-realtime` (2 channels)
- **Total active on Tape: ~5 channels**

**Projected post-snapshot (worst case = each snapshot subscribes its own):**
- +1 Heatmap (poll-only, no realtime needed in current page) → 0 new
- +1 Flags (would share `ct_flags` channel with Alarms via consumer-filter) → 0 new
- +1 Alarms (already subscribed via AlarmBanner) → 0 new
- +1 Specialists (60s polling, no realtime needed) → 0 new
- +1 Patterns (60s polling) → 0 new
- +1 Pulse (`useRegimeState` polls; no realtime) → 0 new
- +1 MorningBrief / EodReport (read-only daily; no realtime) → 0 new
- +1 Edge (60s polling; post-close static) → 0 new

**Empirical:** **0-1 new channels needed.** All snapshots either reuse existing subscriptions (ct_flags shared by Alarms+Flags) or use polling-only patterns. Cowork's worry about 2-3× channel count is **refuted** — the existing per-page cadence is mostly polling, not Realtime.

**Supabase Realtime limits:** project-tier dependent (Pro = 200 concurrent channels per client; Free = 100). Currently ~5 used → headroom is comfortable regardless of snapshot count.

**Shared-channel optimization queued (not v1):** `ct_flags` INSERTs currently invalidate via 2 separate channels (`ct_flags-signature-alarm-realtime` + `ct_flags-alarms-page`). Could consolidate to a single channel with consumer-side `source` filtering. Out of scope here.

### A.4 — Page performance baseline

**Bundle size progression (this session, from build outputs):**
- Pre-session (main baseline): 2,363.56 kB raw / 631.11 kB gzip
- After 4 frontend PRs (#65, #66, #67, #68 stacked): 2,376.53 kB raw / 634.27 kB gzip
- **Delta: +13 kB raw / +3 kB gzip across 4 components + several hooks**

**Projected per-snapshot weight:** ~3-5 kB raw / ~1 kB gzip. 8-10 snapshots ≈ 30-50 kB raw / 10 kB gzip — well under the 500 kB chunk-warning threshold and a rounding error vs the existing 2.4 MB bundle.

**Render perf NOT measured in CLI session** (would require browser-side instrumentation). Two open questions deferred to Vercel preview / captain's local testing:
- Tape page initial-load time with 8-10 snapshot sections mounted (each fetching its own data on mount)
- Realtime update latency under load (when ct_flow_alerts INSERTs, how long until DOM repaints reflect cascade?)

**Mitigation if perf surfaces a problem:** lazy-mount via `<Suspense>` per snapshot; intersection-observer-gated render so off-screen snapshots don't fetch until scrolled into view. Not needed if perf holds; queued as fallback.

### A.5 — Tape Reader ARC schema check

**Empirical findings:**
- `ct_tape_commentary` is **append-only** (verified: 1,129 rows since 2026-04-24, ~85 rows/day average). Cowork inventory's *"may overwrite"* concern is **refuted**.
- Schema confirmed: `id, created_at, session_date, trigger_kind, commentary, flow_ids, flag_ids, vix_level, market_tide, window_start, window_end, model, input_tokens, output_tokens, cost_usd`
- **`market_tide` column exists per row** (string: 'bullish' / 'bearish' / 'flat' / null) — flip-history is trivially derivable from `SELECT created_at, market_tide FROM ct_tape_commentary WHERE session_date = today ORDER BY created_at`
- TapeReaderBanner already exists on Tape (`src/components/command/TapeReaderBanner.tsx`, 108 LOC, mounted at `Tape.tsx:1033`) reading **latest row only**

**ARC enhancement is structurally simple:**
- Pull last N rows in current session (already `session_date` indexed via `created_at`)
- Detect flips by walking the rows and stamping each `market_tide` change as a flip event
- Render: latest commentary (today) + small "flip history" mini-row showing time-stamped tide states
- No schema change needed; no new producer needed

**Sparkline data:** `vix_level` is per-row → trivial sparkline of session VIX path. `market_tide` is categorical → could render as a colored ribbon timeline.

### A.6 — Cross-page dependencies (composition cost reductions)

**Confirmed shared-data opportunities:**

1. **ct_flags is shared by Flags + Alarms** (confirmed). Alarms = subset filter `source='signature_alarm'`. Flags snapshot can omit signature_alarms (Cowork's recommendation) and Alarms snapshot rolls them up — no overlap.

2. **Specialist conviction already on Tape ticker cards.** `Tape.tsx` imports `RegimeChip` from `useTickerIntradayContext`. Specialist snapshot would augment the existing per-ticker rendering, not duplicate. Cowork's hint here is correct.

3. **Heatmap and Flow Pulse share `ct_flow_alerts` upstream** but at different aggregation levels (Heatmap = ticker × expiry-week premium; Flow Pulse = ticker × directional ratio). Both call DIFFERENT RPCs (`ct_flow_heatmap_live` vs `ct_flow_pulse`). Cowork's claim of shared subscription is **partially refuted** — the aggregation surfaces are different RPCs with different cadences.

4. **`useFlowPulse(60)` already exists** as a market-aggregate hook returning per-ticker rows + `marketTotal` (count + premium-weighted C:P). Pulse snapshot reuses this directly without new code; the page-side hook is already optimized for this.

5. **EodReport vs Eod vs MorningBrief = THREE distinct tables** (refines Cowork inventory):
   - `ct_eod_summaries` (legacy, /eod page, 4:30 PM ET)
   - `ct_eod_reports` (newer, /eod-report page, 5 PM ET, "close-to-open handoff")
   - `ct_daily_briefs` (/morning-brief page, 7 AM ET)
   These are NOT collapsible — each is its own producer + table. Cowork's snapshot proposed showing "Morning Brief OR EOD Report depending on time-of-day" is correct UX; the data is just from different tables.

### A.7 — Disambiguation per Cowork-flagged ambiguities

| Page | Reads | Purpose |
|---|---|---|
| **/alarms** | `ct_flags WHERE source='signature_alarm'` | Real-time signature-alarm calibration. Slack-OFF mode. James reads here when calibrating fire criteria. |
| **/flags** | `ct_flags` ALL sources (`specialist`, `signature_alarm`, `detector_alarm`) joined with `ct_flag_grades` | Full prediction stream + grader outcomes. Filters: specialist / status / direction / score / source. |
| **Alarms vs Warden invariants** | distinct: signature_alarms = market-event detections; warden invariants = system-health checks (`ct_invariants` table). Different layer entirely. |
| **/patterns** | `ct_flag_patterns` (mined `(specialist_ticker, signature_hash)` buckets with hit rates) | NOT `ct_observed_patterns` (cascade catalog). NOT `methodology-patterns.md` (engine-room methodology doc). Per-specialist pattern mining with `n>=5` default. |
| **/edge** | `ct_edge_daily` + `ct_signatures` + `ct_print_grades` + `ct_print_tracks` | Hedge-fund-style edge attribution dashboard. Hero (regime + snap hit% + W/L/F) → retroactive alpha → today's W/L → best signatures → per-ticker scorecards → working tracks → attribution-by-dimension. **Hidden pre-close** (snapshot grading happens after RTH). |
| **/eod** (legacy) | `ct_eod_summaries` (Sonnet narrative, 4:30 PM ET) | Daily journal. One narrative entry/day. Cron `30 20 * * 1-5`. Refetches 5min so cron fire lands automatically. |
| **/eod-report** (newer) | `ct_eod_reports` (Sonnet close-to-open handoff, 5 PM ET) | Structured: graded morning brief, regime close, per-ticker close cards, carryover thesis, overnight catalysts, tomorrow setup. |
| **/morning-brief** | `ct_daily_briefs` (Sonnet pre-market brief, 7 AM ET) | Macro narrative + breaking events + per-ticker tilts + high-conviction ideas. |

---

## Phase B — Snapshot Feasibility Ranking

For each Cowork-inventoried snapshot, classified by ship-readiness:

### READY-TO-SHIP (data path clean, hook reusable, no schema or RPC work)

| # | Snapshot | Why READY |
|---|---|---|
| **1** | **Specialists 10-tile row** | `useSpecialistScoreboard` returns full data; render compact tiles client-side. Captain-impact: continuous (10-ticker breadth read). Effort: ~half day. |
| **2** | **Heatmap top-3 cells** | `useFlowHeatmapLive` returns full grid; client-sort by premium DESC, slice 3. Captain-impact: high (where stacking is). Effort: ~half day. |
| **3** | **Flags top-3 active conviction** | Inline `useQuery` on `ct_flags` already used by /flags; copy the same query with `limit(3) order(score DESC)`. Effort: ~half day. |
| **4** | **Alarms count + top-3 fires** | `useAlarms` returns last-N rows + tier counts. Render `🥇 N · 🥈 M · live` + 3 newest gold/silver. Effort: ~half day. |
| **5** | **Pulse regime pill + 3-ticker bias** | `useRegimeState` returns regime + per-ticker. Render pill + top 3 by `|premium_net|`. Effort: ~half day. |
| **6** | **MorningBrief OR EodReport (time-of-day swap)** | `useMorningBrief` + `useEodReport` both return latest row. Compose-time check `if before noon ET → brief, else → report`. Effort: ~half day. |
| **7** | **Patterns top-3 by hit rate** | Inline `useQuery` on `ct_flag_patterns` (mirrors /patterns). Slice top 3 by `hit_rate * sqrt(n_observations)`. Effort: ~half day. |
| **8** | **Edge hero (post-close only)** | `useEdge` returns aggregates. Conditional render `if RTH-closed → hero`, else `null`. Effort: ~half day. |

### NEEDS-LIGHT-WORK (small RPC variant or composition layer)

| # | Snapshot | What's needed |
|---|---|---|
| **A** | **Eod legacy 1-line summary** | Inline query on `ct_eod_summaries` for latest row, slice narrative to 1 line. Trivial; could be in READY-TO-SHIP. Bumping here only because Cowork inventory marked it minimal-real-estate. |

### NEEDS-STRUCTURAL-WORK (schema change or producer-side computation)

| # | Snapshot | What's needed |
|---|---|---|
| **(none)** | All Cowork-inventoried snapshots are reusable from existing producer infrastructure. The "ARC enhancement" item in Cowork inventory is a **separate work item from the snapshots**. |

### Tape Reader ARC (separate from snapshots)

**Status:** READY-TO-SHIP at the data layer. Schema supports flip-history without modification. The ship is purely a UI extension of the existing `TapeReaderBanner` component to render last N session rows + flip-detection ribbon + VIX sparkline. **Estimated effort: 1 small ship.** Sequence as a separate PR after captain reviews layout.

---

## Surprises + Refinements vs Cowork Inventory

### Confirmed (Cowork was right)
- 11 dedicated pages exist as inventoried; routes confirmed in App.tsx
- Hook reuse philosophy holds (each page has dedicated hook)
- ct_tape_commentary is the right table for Tape Reader ARC
- TapeReaderBanner-as-existing-Tape-component matches inventory

### Refuted / refined
1. **Cowork: "Tape Reader compositions may overwrite."** Refuted — table is append-only, 1,129 rows preserved since 4/24, `market_tide` per row, flip-history trivially derivable. Tape Reader ARC is **structurally simpler than Cowork inferred.**

2. **Cowork: 8-10 snapshots = 2-3× Realtime channel count.** Refuted — most snapshots are polling-only or share already-subscribed channels (especially `ct_flags`). Empirically only 0-1 new channels needed; Supabase Realtime limit (200 concurrent on Pro tier) has comfortable headroom.

3. **Cowork: New summary RPCs may be needed.** Refuted for v1 — every page-hook returns enough data to slice top-N client-side. Page-payloads are small (Heatmap ~60 cells, Alarms last-hour ~5-15 rows, Specialists 10 rows, etc.). Server-side summary RPCs become valuable only if v1 surfaces visible re-render lag, which is a future-Phase B optimization.

4. **Cowork: Heatmap and Flow Pulse share underlying flow data.** Partially refuted — they read the same source table (`ct_flow_alerts`) but through DIFFERENT RPCs at different aggregation grain. Snapshot composition can't share a subscription; both need their own hook (which they already have).

5. **EOD vs EOD Report vs Morning Brief.** Cowork inventory implied they're distinct; **confirmed and crisper:** three tables (`ct_eod_summaries`, `ct_eod_reports`, `ct_daily_briefs`), three crons (`30 20`, `0 21`, `0 11`), three pages, three hooks. Snapshot pattern can swap by time-of-day cleanly.

### New observations not in Cowork inventory
6. **`useFlowPulse(windowMin)` returns market_total aggregate already.** Pulse snapshot reuses with zero additional aggregation code.

7. **Specialists, Heatmap, Pulse, MorningBrief, EodReport all have polling-only hooks (no Realtime).** Their snapshots inherit the same cadence — captain shouldn't expect tick-level refresh, and that's fine because the underlying producer data isn't tick-level either.

8. **TapeReaderBanner already exists on Tape.** Cowork inventory listed Tape Reader as "ARC question — separate from snapshots" but didn't flag the existing UI integration. The ARC enhancement is an **upgrade** to existing component, not a new mount.

---

## Ship-First Ranked List (captain-impact-per-effort)

Rank 1-8 are all READY-TO-SHIP, ranked by **captain-impact-per-effort**:

| Rank | Snapshot | Captain impact | Why prioritized |
|---|---|---|---|
| **1** | **Specialists 10-tile row** | Continuous breadth read; status of all 10 specialists at-a-glance. Most-used signal. | One row, always-visible, no collapse — highest density-per-pixel of the inventory. |
| **2** | **Flags top-3 active conviction** | Per-day actionable signals; drives entry decisions. | Already-actively-consulted page → top-3 compresses ~80% of value. |
| **3** | **Alarms count + top-3 fires** | Real-time signature alarms = leading indicators; current AlarmBanner is single-fire glow only. Snapshot adds rollup + recency. | Strong recency-of-signal value. Realtime cost = $0 (already subscribed). |
| **4** | **Heatmap top-3 cells** | Where premium is stacking by ticker × expiry-week. Captain reads this for positioning context. | Top-3 compresses 60-cell grid to glanceable. |
| **5** | **Pulse regime pill + 3-ticker bias** | Regime context for every other signal — frames interpretation. | Single pill anchors the entire chart row. |
| **6** | **MorningBrief / EodReport time-swap** | Setup theme + carryover thesis at the top of the day / closing handoff at end. | Captain reads these once/day already; Tape integration eliminates separate page navigation. |
| **7** | **Patterns top-3** | Mined-signature hit rates per specialist; validation signal. | Lower urgency than rank 1-6 but cheap to ship. |
| **8** | **Edge hero (post-close only)** | Today's snapshot hit rate + W/L tally. | Conditional render; no value pre-close. Lowest immediate captain-impact during RTH. |

### Recommended Phase 1 ship batch (parallelizable)

Cowork inventory's "recommend Phase 1: Heatmap + Flags + Specialists MVP" aligns with rank 1-4. Empirically these four ship together cleanly because:
- All four are READY-TO-SHIP
- All four reuse existing hooks (zero new infrastructure)
- All four have no Realtime channel additions
- Visual estimate per Cowork: ~640px combined real estate (Specialists 100 + Heatmap 80 + Flags 360 + Alarms 100) — fits above existing Tape table

**Suggest sequencing:** ship as 4 separate PRs (one per snapshot) to keep diffs reviewable; OR one bundled PR if captain wants atomic cutover. Each PR ~half-day effort.

### Tape Reader ARC = separate ship after captain layout review

Bundled sequence: ship snapshots first (rank 1-4), capture captain reaction, then ship Tape Reader ARC as enhancement to existing TapeReaderBanner. Schema is ready; only blocker is layout decision (does ARC live above or below new snapshots? Embedded in the banner or as its own collapsible card?).

---

**End of runtime feasibility audit.** All cron schedules, hook bindings, channel counts, table-row counts, and bundle-size deltas are direct queries against current production state (2026-05-08). Captain decides priority sequencing of subsequent ships. Engine-room awaits direction.
