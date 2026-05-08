# Tape V2 Feasibility Scoping — Phase A

**Date:** 2026-05-08
**Scope:** Diagnose-only feasibility audit for the parallel-route /tape-v2 command-center redesign. NO ship work in this pass.
**Companion:** Cowork structural inventory (`tape-command-center-snapshot-inventory.md`) + PR #69 runtime feasibility audit (currently branch-only on `docs/tape-command-center-runtime-feasibility-2026-05-08`).
**Author convention:** Brief asserts intent; this report asserts current state of the codebase as Phase A discovered it.

---

## TL;DR

**Doable:** YES, with one structural caveat — several substrate items the brief asserts as "introduced by PR #N" are still **branch-only and not on main**. Either land those PRs first or descope dependent features to v1.1.

**Recommended ship cut:** **One-shot descoped v1**, single PR. Drop ALL-mode Flow Butterfly + 4-segment ARC ribbon refinement + News-compress redesign + emission event-feed slot to v1.1. Ship Warden + Tape Reader ARC (simple shape) + Specialists 10-tile + FlowPulse + Flow Butterfly (TICKER/MARKET) + Overnight + Tape table in main column; EOD/Brief swap + Heatmap top-3 + Flags top-3 + Alarms count+top-3 in right rail. Single coherent PR; v1.1 follow-up adds ALL-mode and ARC refinement after PR #66 lands.

**Complexity read:** Moderate ship, high reuse, manageable risk. ~10–12 new component files, 1–2 new hooks, 1 route addition. No schema. No RPCs. Zero new realtime channels.

**Highest-leverage open question:** how the captain wants to sequence against open PRs #64–#68 (whether to land them first, bundle, or descope dependent features).

---

## 1. Doable feasibility — yes/no

**YES.** All eight Cowork-inventoried snapshots are READY-TO-SHIP per PR #69's classification. The parallel-route safety pattern is structurally clean. The substrate exists today (tables, RPCs, hooks) for everything except per-PR-#66/67/68 features the brief leans on.

The only structural blocker is sequencing: **the brief asserts substrate from open PRs as if it were on main.** If we treat that substrate as available, ship breaks at import-time. If we descope to what's on main today, ship is clean. See section 12 for the empirical state-vs-intent breakdown.

---

## 2. Ship cut recommendation — ONE-SHOT (descoped)

Default is one PR. Splitting requires structural justification per the brief. Phase A surfaced **one** structural reason that points at descope-not-split: PR #66/#67/#68 substrate isn't on main, so v2's full spec is blocked on a landing-order I shouldn't presume.

**Recommended v1 (one PR):**

Main column, top-to-bottom:
1. SystemWardenCard — **as-is** (already auto-compacts when healthy; no refactor for v1)
2. Tape Reader ARC — simple shape: tide pill + VIX pill + read-text + bullish/bearish progression line derived from `ct_tape_commentary.market_tide` over today's session. **Defer 4-segment ribbon refinement** to v1.1 once segment definitions lock.
3. Specialists 10-tile row — new `useSpecialistsTileRow` compose hook (see section 5)
4. FlowPulse (existing, unchanged)
5. Flow Butterfly — TICKER + MARKET modes only, in current dropdown; **defer ALL mode** to v1.1
6. OvernightPositioning (existing, unchanged)
7. Tape table (existing, unchanged)

Right rail, top-to-bottom (time-of-day-aware ordering):
1. EOD Report / Morning Brief swap — time-of-day aware (see section 8)
2. Alarms count + top-3 — clean reuse of `useAlarmRealtime`
3. Heatmap top-3 — clean reuse of `useFlowHeatmapLive`
4. Flags top-3 active conviction — needs new `useTopActiveFlags(limit, minScore)` thin hook
5. **NewsFeed (kept at bottom, full size, NOT compressed for v1)** — defer compress redesign to v1.1
6. **Pulse snapshot DEFERRED to v1.1** — `useFlowPulse` is already used in main col; redundant on right rail until ordering settles

Left rail: existing `<ChatPanel />` via AuthLayout — already automatic for any new route.

**Single PR. Single rollback. Single review surface.**

**Deferred to v1.1:**
- Flow Butterfly ALL-mode (waits on PR #66 landing)
- Tape Reader ARC 4-segment ribbon (waits on segment-source spec)
- Right-rail News-compress redesign (currently fine at bottom; small follow-up)
- Pulse snapshot in right rail (avoid redundancy with main-col FlowPulse until layout settles)
- Phase 2 emission event-feed slot (waits on PR #63 landing — see section 9)

**Why not split into 2-3 PR stack:** the components are tightly coupled at the page-shell layer. Splitting layout from snapshots forces an in-between commit where the page is half-rendered. The descope path keeps coherent v1 in one PR, then individual v1.1 follow-ups are themselves single-purpose.

**Why not maximalist one-shot:** every deferred item depends on substrate that's branch-only or design-unlocked. Shipping a "complete" v2 forces either bundling 5 open PRs (review surface explodes) or building stub components that immediately get rewritten when their substrate lands.

---

## 3. Authority to descope — used

Phase A used the descope authority. The descopes above (ALL-mode, 4-segment ARC, News-compress, Pulse-on-rail, emission slot) are not all "too aggressive" — some are simply gated on substrate not yet on main. Captain can override any descope; section 10 surfaces the specific decisions.

---

## 4. Pushbacks on design intent

**4a. Tape Reader ARC's 4-segment ribbon implies a producer that doesn't exist.** The brief locks "4-segment style: bullish green / neutral gray / bullish green / bearish red showing today's regime trajectory" + "flip annotations below ribbon." Phase A on `useTapeReader` and `ct_tape_commentary` schema:

- `ct_tape_commentary` columns (verified on main): `id, created_at, session_date, trigger_kind, commentary, flow_ids[], flag_ids[], vix_level, market_tide, window_start, window_end, model, input_tokens, output_tokens, cost_usd`.
- `market_tide` is one column of one classification per row, written every ~10 min during RTH.
- The 4-segment ribbon implies 4 distinct signal sources colored independently (e.g., flow / regime / specialist / news). **No producer writes that shape today.**
- The brief notes "data already exists in ct_tape_commentary append-only table per runtime audit (1,129 rows / 13 days, market_tide per row — schema is ready)" — that's true for **a single tide trajectory**, not for 4 independent segments.

**Recommendation:** v1 ARC = simple session-progression sparkline derived from `market_tide` flips over today's `session_date` rows. Tide pill + VIX pill + read-text reuse current `useTapeReader` data. Flip annotations are derivable from successive `market_tide` value changes over the day. The "4-segment" framing returns in v1.1 once captain locks the 4 sources, and that locking is itself a design pass that warrants its own brief.

**4b. SystemWardenCard "compact-but-expandable" already exists implicitly.** The current component (`src/components/system/SystemWardenCard.tsx`) auto-renders compact when healthy and expanded when failing. Captain can already click in to expand failing detail. The brief says "Existing SystemWardenCard component reused with a new compact mode" — that's an accurate intent but Phase A finds the existing behavior is close enough for v1 without a `compact` prop refactor. **Defer the explicit prop to v1.1** if captain wants forced-compact-when-failing.

**4c. Specialists 10-tile data shape is composite, not a single hook return.** Brief lists per-tile fields: ticker, current price, conviction score (0–100), direction arrow, delta-since-last-hour. Phase A on hooks:

- `useFlowPulse` returns per-ticker premium/calls/puts with no conviction.
- `useSpecialistScoreboard` / `useSpecialistScoreboardV2` return hit-rate + alpha + top-pick — **not** current conviction or 1h delta.
- No hook returns "current conviction per ticker" as a single field today.
- Spot prices live in `ct_ticker_snapshots.spot` (read by `TickerSheet` and `useTickerIntradayContext`).

**Recommendation:** new `useSpecialistsTileRow()` compose hook. Inputs: `useFlowPulse` (premium signal for direction arrow + delta proxy) + `ct_specialist_reads` latest row per ticker (conviction) + `ct_ticker_snapshots` (price). Single React Query that returns `Array<{ticker, price, conviction, direction, delta_1h}>` for the 10-tile row. ~50–80 LOC. New hook, no new RPC, no schema change.

**4d. Time-of-day-aware right-rail ordering — feasible but lightly disruptive if auto-rerendering.** `useClock` already exists and ticks every 1s. Re-rendering right-rail order on every clock tick would flicker. **Recommendation:** order is computed once on mount based on current ET hour bucket, plus listened on three transition points only (open ~13:30 UTC, lunch ~16:00 UTC, close ~20:00 UTC). Captain manual reorder via persistent collapse-state in localStorage takes precedence after first paint. Don't fight the captain's preference once they've expressed one.

**4d-corollary.** Recommend `13:30 UTC` strict (RTH open) as default boundary. Captain can override per question 4 below.

**4e. Brief asserts cross-reference to "PR #57 docs-PR discipline workflow" enforcement.** That workflow file is not on main yet (PR #57 is open). The discipline is in force per James's standing instruction; this audit is being shipped through PR-discipline regardless. No blocker, just naming what's true.

---

## 5. Suggestions for refinement

**5a. Audit doc lives at `docs/audit/2026-05-08-tape-v2-feasibility-scoping.md`.** The repo has `docs/audit/` (singular), not `docs/audits/`. Existing 31 audit files follow `YYYY-MM-DD-<title>-phase-<letter>.md` naming. This doc matches the convention.

**5b. New components live at `src/components/tape-v2/`.** This is clearer than `src/pages/TapeV2/` (subdirectory under pages would be unusual) or `src/components/command-v2/` (the v2 isn't replacing all of `command/`, only Tape). `tape-v2/` is the cleanest sibling to `command/`, `co-trader/`, `system/`.

**5c. New page entry: `src/pages/TapeV2.tsx`.** Single file at the page root level, mirroring `Tape.tsx`. Imports from `src/components/tape-v2/*`.

**5d. Don't extract Tape.tsx local helpers as part of v2.** `rthOpenCutoffUtc`, `tradingDaysAgoCutoff`, `etDateKey`, `formatSeparatorLabel`, `parseOccSide`, `formatTimeET`, `deriveTapeKind` are duplicated in 4 sibling files (`ContractDrillSheet`, `TickerSheet`, `FlagDetailSheet`, `TapeReader`) but as **independent duplicates**, not imports. v2 should re-duplicate or re-import locally — not extract these into a shared `src/lib/tradingTime.ts`. That extraction is its own kernel-cleanup PR (low priority, queue separately) and conflating it with v2 expands review surface.

**5e. Bundle Phase 2 organMetadata pattern applies narrowly, not broadly.** The brief recommends applying `{value, as_of, source, status}` "to any new snapshot components that compose data with freshness/source attribution." Phase A clarifies: most snapshots read existing tables/RPCs directly — they're not organ consumers and the wrapper would be overhead. **Apply organMetadata only to the Tape Reader ARC** where freshness/source is explicitly captain-facing. The other snapshots already carry implicit freshness (their hooks have `refetchInterval` semantics; staleness is handled at React Query layer).

**5f. AuthLayout already wraps `<ChatPanel />` for every authenticated route** (verified `src/App.tsx:88` + similar lines). The brief says LEFT RAIL is "Chat with Claude, collapsible (existing component, unchanged behavior)." Phase A: nothing to do — the new `/tape-v2` route adds a single line to App.tsx with the same `<AuthLayout sidebar={<ChatPanel />}>` wrapper. Left rail is automatic.

**5g. Hidden-from-nav for v1.** Recommended pattern: add `/tape-v2` route line in App.tsx, **don't add a TopNav link**. Captain navigates via direct URL. After captain validates, follow-up PR adds the link (or — better — does the swap directly).

**5h. Migration cleanup is one line.** When captain validates, the swap PR changes `src/App.tsx:88` from `<Tape />` to `<TapeV2 />` and deletes `src/pages/Tape.tsx`. Optionally adds a `/tape-v2 → /tape` redirect. That's the entire migration. See section 7 for the dependency check that confirms this.

---

## 6. Risk assessment

**6a. Realtime subscription channel budget — ZERO new channels.**
Current `Tape.tsx` subscribes via:
- `useAlarmRealtime` → 1 channel (`ct_flags-signature-alarm-realtime`, INSERT, source=signature_alarm filter)
- `useContractTracksRealtime` → 2 channels (`ct_contract_tracks-realtime` UPDATE; `ct_print_grades-contract_v1-realtime` INSERT)

Total: **3 active channels.** v2's design reuses both hooks identically. Right-rail snapshots use polling (per PR #69's analysis). No new realtime needed for v1. Verdict: well within budget.

**6b. Performance bottleneck at composition density.**
Current `/tape` issues ~30+ React Query subscriptions across hooks. Adding 6 right-rail snapshots adds ~6–8 more (each snapshot is one or two queries, with shared keys deduping). Total ~36–40 subscriptions. Acceptable on modern desktop. Phase A flag: snapshot mini-charts (if any are added in ARC v1.1) could push render time during initial paint — recommend lazy-load any chart >100px on mount.

**6c. Mobile responsive collapse.**
Current `Tape.tsx` uses `grid-cols-1 lg:grid-cols-[1fr_auto]` for content + right rail; right rail is hidden below `lg`. v2 should mirror this pattern: right rail collapses below `lg`, main col stacks. Specialists 10-tile row needs `flex-wrap` for narrow widths (10 tiles × ~80px = 800px minimum, won't fit on tablet without wrap).

**6d. Component coupling for parallel-route approach.**
**Clean.** Verified: `src/App.tsx:35` is the **only** place anything imports from `src/pages/Tape.tsx`. No external consumer of Tape.tsx local helpers. v2 can be built fully isolated; old /tape stays untouched.

**6e. Hook signatures don't all support snapshot mode.**
- Heatmap → `useFlowHeatmapLive` — CLEAN-REUSE (sort+slice client-side)
- Pulse → `useFlowPulse` + `useRegimeState` — CLEAN-REUSE
- Alarms → `useAlarmRealtime` — CLEAN-REUSE for top-3, count requires either separate quick query or counting `recentAlarms` in-memory window (recommend the latter for v1)
- Flags → no dedicated hook on main; `Flags.tsx` queries Supabase directly. **Need new** `useTopActiveFlags(minScore=80, limit=3)` thin hook (~20 LOC)
- Specialists 10-tile → composite, **need new** `useSpecialistsTileRow()` (~50–80 LOC, see 4c)
- Brief swap → `useMorningBrief` exists; **no `useEodReport` on main**. Need new `useEodReportSnapshot()` reading `ct_eod_reports` table (cron-written daily). Or reuse `useDailyBrief` if it covers both — Phase A.1 verifies in v1 implementation.

Verdict: 3 hooks clean, 3 hooks need adaptation/new. Total new-hook LOC ~150–250. Single PR scope. No structural blocker.

**6f. Recharts integration quirks.**
Recharts is used extensively on main (verified `AreaChart`, `Area`, `ResponsiveContainer`, `Tooltip`, `XAxis`, `YAxis`, `ReferenceLine`, `LineChart`, `Bar`, `BarChart`, `ComposedChart`, `Legend`, `CartesianGrid` across components and pages). The XAxis-ReferenceLine quirk from PR #67 (XAxis required even when hidden, for category resolution) **applies to ARC v1 if we use ReferenceLine for flip annotations.** PR #67's helper `src/lib/flowButterflyCrosses.ts` is NOT on main — if v1 ARC needs cross-style annotations, we either re-implement the pattern locally or wait for PR #67 to land. Recommended: v1 ARC uses inline marker dots (simpler than ReferenceLine), defers the ReferenceLine + helper-extract design to v1.1 alongside the 4-segment ribbon.

**6g. Brief-author state assertions in the prompt itself — verified false in places.**
See section 12 for the full empirical breakdown. The relevant runtime risks:
- v2's ALL-mode flow butterfly needs `MiniFlowButterfly` + multi-ticker `useFlowPulseChart` — **not on main**. Importing them today would fail TypeScript build. Either bundle PR #66 in v2's stack or descope ALL-mode (recommended).
- v2's ARC ribbon-cross-annotations would need PR #67's `flowButterflyCrosses.ts` — **not on main**.
- v2's emission event-feed slot would need PR #63's `jac_emission_triggers` etc. — **not on main**.
- v2's prev-close anchor pattern as exemplar of organMetadata — **on main only as the abstract Bundle Phase 2 contract**, not as the prev_close-specific implementation.

---

## 7. Migration cleanup dependency check

**Imports of `src/pages/Tape.tsx` outside the page itself:**
- `src/App.tsx:35` — `import Tape from "./pages/Tape";` — **only consumer**

**Re-exports / external use of Tape.tsx local helpers:** none. Verified by grep:
- `rthOpenCutoffUtc`, `tradingDaysAgoCutoff`, `etDateKey`, `formatSeparatorLabel`, `parseOccSide`, `formatTimeET`, `deriveTapeKind` are all locally scoped. Duplicated implementations exist in `ContractDrillSheet.tsx`, `TickerSheet.tsx`, `FlagDetailSheet.tsx`, `TapeReader.tsx` but as independent re-implementations, not imports.

**Migration sequence (recommended after captain validation):**
1. v1 PR ships `/tape-v2` route + `src/pages/TapeV2.tsx` + `src/components/tape-v2/*`. Old `/tape` untouched.
2. Captain validates v2 by direct URL.
3. **Swap PR (separate, single-line):** change `src/App.tsx:88` from `<Tape />` to `<TapeV2 />`, optionally add `/tape-v2 → /tape` redirect, delete `src/pages/Tape.tsx`. Single import line removed at App.tsx:35.
4. The duplicated helpers extract is its own follow-up cleanup PR — **not** part of v2.

This sequence works because nothing else imports Tape.tsx. The kernel-clean migration is one-line + one-delete.

---

## 8. Time-of-day aware right-rail ordering — implementation pattern

**Feasibility:** YES.

**Implementation pattern (recommended):**

```tsx
// src/components/tape-v2/RightRail.tsx
const phase = useEtPhaseBucket();  // 'pre_open' | 'rth' | 'post_close'
const order = useMemo(() => orderForPhase(phase), [phase]);
return order.map(slot => <SlotComponent key={slot.id} {...slot} />);
```

`useEtPhaseBucket()` is a new ~20-LOC hook reading `useClock` and bucketing into 3 phases at known UTC boundaries. It re-renders only on phase transition (3 times/day max), not on every clock tick.

**Phase ordering defaults (Phase A recommendation, captain confirms in section 10):**
- `pre_open` (00:00–13:30 UTC): Morning Brief first, then Heatmap, Flags, Alarms
- `rth` (13:30–20:00 UTC): Alarms first, then Heatmap, Flags, Brief
- `post_close` (20:00–24:00 UTC): EOD Report first, then Brief, Flags, Alarms, Heatmap

**Captain manual-reorder takes precedence** via localStorage-persisted collapse/expand state. If captain pins a section open during pre-open, it stays where they put it through phase transitions. Auto-ordering applies on first mount only when no localStorage state is found.

---

## 9. Phase 2 emission event-feed slot pre-flag

PR #63 substrate (`jac_emission_triggers`, `jac_emissions`, `compose_emission`, `emit`) is **not on main yet** — verified via migration grep.

**Engine-room recommendation: defer the slot entirely to Phase 2 emission ship.**

**Reasoning:**
- Designing-in a placeholder slot now creates an empty pane in v1 (ugly without payoff) until emission lands.
- The right-rail pattern (collapse/expand sections, ordered list) is structurally easy to extend — adding a section in v1.1 is one entry in the slot-order array + one component file. No layout rewrite needed.
- Reserved-empty-slots are the design-coupling-now-without-substrate anti-pattern. Engine-room recommends: ship v1 cleanly, add the emission slot when its substrate ships.

**Alternative (if captain prefers):** include a hidden `<EmissionFeedSlot />` placeholder that only renders if a feature flag is on (`localStorage.tape_v2_emission_slot === 'true'`). Captain can flip the flag to test layout once PR #63 lands. But this adds complexity for marginal value — defer is the cleaner call.

---

## 10. Open questions for captain

These are decisions the brief did not lock that engine-room cannot make alone:

1. **PR #66 dependency strategy.** ALL-mode Flow Butterfly imports `MiniFlowButterfly` + multi-ticker hook from PR #66 (open, not on main). Pick one:
   - (A) Land PR #66 first; v2 ships fully-spec'd including ALL-mode (sequential)
   - (B) Ship v1 with TICKER+MARKET only; ALL-mode lands as v1.1 follow-up after PR #66 (recommended — keeps v1 clean and unblocked)
   - (C) Bundle PR #66 + v2 in one stack (bigger review surface, single-stack rollback)

2. **ARC v1 scope.** "4-segment ribbon" implies 4 distinct signal sources (no producer writes that shape today). Pick one:
   - (A) v1 ARC = tide pill + VIX pill + read-text + simple session-progression line from `market_tide` flips. Defer 4-segment ribbon to v1.1 once segment definitions lock (recommended)
   - (B) v1 ARC includes 4-segment ribbon — captain locks the 4 sources here and now (flow/regime/specialist/news? something else?), engine-room picks read paths in implementation

3. **Specialists 10-tile data composition.** No existing hook returns `{ticker, price, conviction, direction, delta_1h}` together. Pick one:
   - (A) New `useSpecialistsTileRow()` composing from `useFlowPulse` (price proxy + delta) + `ct_specialist_reads` (latest conviction/direction) + `ct_ticker_snapshots` (spot) (recommended)
   - (B) Phase-A-discovers in implementation — engine-room picks the cleanest shape from what's available

4. **Time-of-day boundary trigger.** Pick one:
   - (A) Strict 13:30 UTC RTH open / 20:00 UTC close (recommended)
   - (B) 14:00 UTC + 19:30 UTC with grace windows
   - (C) No auto-swap — captain manually picks order once and it sticks

5. **SystemWardenCard compact mode.** Pick one:
   - (A) Ship as-is; current auto-compact-when-healthy is sufficient for v1 (recommended)
   - (B) Refactor to add explicit `compact` prop forcing always-compact-with-click-to-expand even when failing

6. **Path placement for new components.** Pick one:
   - (A) `src/components/tape-v2/` (recommended — cleanest sibling to `command/`, `co-trader/`)
   - (B) `src/components/command-v2/` (sibling rename)
   - (C) `src/pages/TapeV2/` (page-level subdirectory — unusual)

7. **Phase 2 emission slot.** Pick one:
   - (A) Defer entirely; add when PR #63 substrate lands (recommended)
   - (B) Hidden placeholder behind localStorage feature flag for layout-test
   - (C) Always-rendered placeholder pane

---

## 11. Estimated complexity vs simplicity

**Read: moderate ship, high reuse, manageable risk.**

**Reuse (carries over unchanged):**
- AuthLayout + ChatPanel (left rail automatic)
- SystemWardenCard, FlowPulse, OvernightPositioning, Tape table, AlarmBanner, MacroBanner, NewsFeed
- All hooks for the tape table itself
- Existing realtime subscriptions (3 channels, 0 new)

**New code (engine-room estimate — explicitly not a time-budget):**
- `src/pages/TapeV2.tsx` — page shell, ~150–250 LOC mostly imports + layout
- `src/components/tape-v2/TapeReaderArc.tsx` — ARC component, ~100–150 LOC v1
- `src/components/tape-v2/SpecialistsTileRow.tsx` — 10-tile row, ~80–120 LOC
- `src/components/tape-v2/RightRail.tsx` — slot container + ordering, ~80 LOC
- `src/components/tape-v2/snapshots/` — 4 snapshot components (Heatmap, Flags, Alarms, BriefSwap), ~50–100 LOC each
- `src/hooks/useSpecialistsTileRow.ts` — compose hook, ~50–80 LOC
- `src/hooks/useTopActiveFlags.ts` — thin Flags hook, ~20–40 LOC
- `src/hooks/useEtPhaseBucket.ts` — ~20 LOC
- 1-line route addition in `src/App.tsx`

**Total new-file count:** ~10–12 components + 3 hooks + 1 page. ~1000–1500 LOC additive, all isolated to new files.

**Touchpoints to existing code:** 1 (the App.tsx route line).

**Risk read:**
- Realtime budget: zero risk (no new channels)
- Performance: low risk (composition density similar to /tape)
- Mobile responsive: low risk (mirroring existing pattern)
- Component coupling: low risk (clean parallel route, single migration cleanup)
- Hook adaptation: low-moderate risk (Specialists tile is the biggest unknown)
- Recharts integration: low risk for v1 simple ARC; moderate if 4-segment ribbon attempted in v1
- Brief substrate gaps: medium risk if captain picks "ship full spec" without landing PR #66/67/68 first

---

## 12. Brief-author-state-vs-intent verification

Per `discipline-brief-author-intent-over-state.md`, this brief contained empirical state assertions. Phase A verification:

| Brief assertion | Phase A finding | Verdict |
|---|---|---|
| "PR #61 prev_close anchor demonstrates Bundle Phase 2 organMetadata pattern" — substrate as exemplar | No `prev_close` per-entry `{value, as_of, source, status}` shape on main. Bundle Phase 2 abstract contract IS on main. | PARTIAL — pattern available abstractly; the prev_close-specific exemplar is branch-only |
| "PR #63 emission layer Phase 1 — `jac_emission_triggers` / `jac_emissions` / `compose_emission` / `emit`" | None of these tables/functions exist in `supabase/migrations/` on main | BRANCH-ONLY |
| "PR #65 re-enabled BB mode in FlowPulseChart toolbar" | `src/components/command/FlowPulseChart.tsx` has full BB-mode implementation on main (mode 'bb', cumulative bullish/bearish data, calculations at line 238–240) | TRUE |
| "PR #66 introduces `MiniFlowButterfly` + `useFlowPulseChart` multi-ticker fetching + the `/butterflies` route" | None on main: no `MiniFlowButterfly` component, no `useFlowPulseChart` hook, no `/butterflies` route. `useFlowPulse` exists with single-ticker `ticker?: string` param but no multi-ticker batch shape. | BRANCH-ONLY |
| "PR #67 introduces `src/lib/flowButterflyCrosses.ts`" | File does not exist in `src/lib/` on main | BRANCH-ONLY |
| "PR #68's `useNetPremiumExpirySplitMulti`" | Hook does not exist on main | BRANCH-ONLY |
| "PR #69 audit doc at `docs/audits/...`" | Doc not on main; existing dir is `docs/audit/` (singular). PR #69 body was readable via gh. | BRANCH-ONLY (and naming-corrected) |
| "Existing `useSpecialists` hook per runtime audit findings" | No `useSpecialists` hook on main. Actual hooks: `useSpecialistScoreboard` + `useSpecialistScoreboardV2` + `useSpecialistReads`. | RENAMED — hook name in brief doesn't match codebase |
| "ct_tape_commentary append-only table per runtime audit (1,129 rows / 13 days, market_tide per row — schema is ready)" | Table exists on main per `supabase/migrations/20260424000006_ct_tape_commentary.sql`. Append-only confirmed. Columns include `market_tide`, `vix_level`, `commentary`, `flag_ids`, `flow_ids`, `window_start`, `window_end`, `session_date`. Row count not re-verified in this audit. | TRUE on schema; row-count claim from PR #69 |
| "Existing SystemWardenCard component reused with a new compact mode" | Component exists; auto-renders compact when healthy; no `compact` prop. Adding one is a separate light refactor. | INTENT (refactor implied, not yet done) |
| "Existing CI gates apply. Layer 1 deno check (PR #59 covers `mcp/`)" | PR #59 is open, not on main — verified via `gh pr list`. Layer 1 covers `supabase/functions/**/*.ts` only on main. | BRANCH-ONLY (gate extension waits on #59) |
| "gated by CI workflow PR #57" | `.github/workflows/docs-pr-discipline.yml` does not exist on main. PR #57 open. | BRANCH-ONLY |

**Implication for the v2 build:** literal compliance with the brief's substrate references would fail at TypeScript build time (missing imports). Engine-room recommends one of:
- **Option A (recommended):** v1 ships only the substrate that's on main today. PRs #61/#63/#66/#67/#68 land on their own merge cadence. v1.1 follow-ups pick up substrate as it lands.
- **Option B:** captain bundles v2 with PRs #66/#67 (the directly-needed substrate) into a stack-of-PRs. Bigger review surface, tighter coupling, but ships full spec in one merge wave.
- **Option C:** captain waits for PRs #64–#68 to merge naturally, then ships v2 against a clean main with all substrate landed. No coupling risk; pays the wait cost.

This is precisely the kind of Phase A finding that the brief-author-state-vs-intent rule is designed to surface. Not a fault of the brief — empirically validated motivation for the rule.

---

## Recommendation

**Doable: YES.** Single PR, one-shot, with descopes called out.

**Ship cut: ONE-SHOT-DESCOPED v1.** Single PR. Reuse-heavy. ~10–12 new files in `src/components/tape-v2/`, 3 new hooks, 1 new page, 1-line route addition.

**Reasoning:**
- All eight Cowork-inventoried snapshots are READY-TO-SHIP per PR #69 — no structural blocker.
- Parallel-route `/tape-v2` keeps `/tape` untouched, preserving the read-path watch window for PR #70 and the Specialist Recall C1 measurement window through 5/15. Render-layer changes only; zero structural specialist-context edits.
- Brief substrate dependencies on open PRs #66/#67 force the descope choice: ALL-mode Flow Butterfly + 4-segment ARC ribbon defer to v1.1 (or captain picks Option B/C in section 12).
- Migration cleanup is one route line + one import line + one delete. App.tsx is the only consumer of Tape.tsx.
- Zero new realtime channels, zero new RPCs, no schema changes — substrate cost is zero.
- v1.1 follow-ups (ALL mode, ARC refinement, News compress, emission slot) are each single-purpose and unblocked once their substrate lands.

**What gets shipped in v1 (one PR):**
- `/tape-v2` route, hidden from nav
- Main col: SystemWardenCard (as-is) + Tape Reader ARC (simple) + Specialists 10-tile + FlowPulse + Flow Butterfly TICKER/MARKET + Overnight + Tape table
- Right rail: time-of-day-aware order of EOD/Brief swap + Alarms count+top-3 + Heatmap top-3 + Flags top-3 + NewsFeed (full size, bottom)
- Left rail: existing ChatPanel via AuthLayout (automatic)
- New: 10–12 components in `src/components/tape-v2/`, 3 hooks, 1 page

**What gets queued for v1.1 (each its own single-purpose PR):**
- Flow Butterfly ALL-mode (waits on PR #66 merge)
- Tape Reader ARC 4-segment ribbon refinement (waits on segment-source design lock)
- News compress redesign
- Pulse snapshot in right rail (after layout settles)
- Phase 2 emission event-feed slot (waits on PR #63 merge)
- Migration swap PR (after captain validates v1)
- Helper-extract cleanup PR (kernel cleanup, separate)

**Captain validates v1 via direct URL `/tape-v2`. Once validated, swap PR retires `/tape`.**

---

## Decisions for captain

Before scoping locks and v1 implementation begins, captain answers section 10's seven open questions. Engine-room recommendations are flagged inline. Highest-leverage among them are #1 (PR #66 sequencing) and #2 (ARC v1 scope) — both shape what lives in v1 vs v1.1. The other five are low-stakes preferences with engine-room defaults that are safe to pick if captain has no strong opinion.

Once those seven are answered, the v1 ship brief is paste-ready.

---

## Cross-references

- Cowork inventory: `cowork-cotrader/memory/tape-command-center-snapshot-inventory.md`
- Cowork tape audit: `cowork-cotrader/memory/tape-page-comprehensive-audit.md`
- Cowork decisions (5/8 entry): `cowork-cotrader/memory/decisions.md` line 822 onward
- PR #69 runtime audit: branch `docs/tape-command-center-runtime-feasibility-2026-05-08`
- Brief-author-state-vs-intent: `cowork-cotrader/memory/discipline-brief-author-intent-over-state.md`
- Existing Tape: `src/pages/Tape.tsx` (1,858 LOC; baseline)
- TapeReaderBanner: `src/components/command/TapeReaderBanner.tsx`
- useTapeReader: `src/hooks/useTapeReader.ts`
- ct_tape_commentary migration: `supabase/migrations/20260424000006_ct_tape_commentary.sql`
- App.tsx route table: `src/App.tsx:75–106`
