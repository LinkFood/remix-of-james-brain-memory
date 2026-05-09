# Tape V2 — Iteration Log

**Append-only log of /tape-v2 iterations from PR #73 ship through captain-validated done state.**

## Why this exists

Captain is iterating directly with engine-room on /tape-v2 — small UI / interaction tunings (color thresholds, layout density, redundant components, copy tweaks, snapshot composition adjustments). Cowork (the navigator agent) stays out of per-iteration loops to avoid paste-pattern overhead, but needs end-state understanding when v2 wraps so back-end work (emission Phase 2/3 site feed + triggers, vendor abstraction Phase 2A, specialist hierarchy Phase 2B) can resume with Cowork in the loop.

Cowork reads this file via local clone (`git pull` in `source/`) at any time to catch up. When captain marks v2 done, Cowork integrates into memory and back-end cadence resumes.

## How to use this

**Engine-room appends one entry per substantive iteration.** Append-only — never edit prior entries. The journey is the document, not just the destination.

**Per-entry format:**

```
## YYYY-MM-DD — [short iteration title]

**What changed:** [1-2 sentences diffing from prior state]

**Why:** [captain articulation or empirical reason]

**End-state:** [what this piece looks like after the change]

**PR / commit:** #N or commit hash
```

**Ships with code.** When an iteration ships code, append the log entry in the same PR (preferred — log update rides with the change). If multiple entries accumulate without code shipping (pure design conversation, scoping pivots), periodic docs PR is fine.

**Brief entries.** This is for memory, not narrative. Keep overhead minimal so engine-room writes entries naturally.

## Done-state trigger

When captain says "v2 is done":
1. Engine-room appends a final "completion state" entry summarizing the design at done-time.
2. Cowork pulls `source/`, reads the log + final component code, writes `memory/tape-v2-design-state.md` capturing the canonical state.
3. Cowork ↔ engine-room paste-pattern resumes for back-end work (emission Phase 2/3, vendor abstraction Phase 2A, specialist hierarchy Phase 2B).

---

## 2026-05-08 — PR #73 ships, captain first reaction

**What changed:** /tape-v2 parallel route shipped to production via PR #73 squash-merge at 16:23:27Z. 13 new files (page shell + 4 main-col components + 4 right-rail snapshots + 3 hooks) + 1-line route addition + 1-line nav exposure (Trade dropdown). Old /tape untouched.

**Why:** Captain-locked Tape command-center vision (memory/decisions.md 5/8 entries) — the captain efficiency gap is a composition gap, not a data gap. Same components, same data, different composition surface. Tenet 24 manifesting at the UX layer.

**End-state:** Production /tape-v2 live. Trade dropdown shows Tape v2 sibling to Tape. Layout: AuthLayout (left chat sidebar implicit) + main col (Warden / MacroBanner / AlarmBanner / TapeReaderArc / SpecialistsTileRow / FlowPulse / FlowButterflySection / OvernightPositioning + footer link to /tape for raw prints) + right rail (phase-aware: BriefSwap / Alarms / Heatmap / Flags / News). v1 deferrals captured in PR #73 description: tape table on legacy /tape, ARC simple-line not 4-segment, news full-size not compressed, no Pulse-on-rail, no emission slot.

Captain first reaction: "good bones, needs work, alot of small different things." Specific deviations surfaced at first production render:
- **Redundant per-ticker breadth views** — SpecialistsTileRow (NEW) renders alongside FlowPulse's per-ticker table and OvernightPositioning's per-ticker rows. Design intent was the 10-tile row REPLACING the per-ticker breadth surface, not augmenting it.
- **Specialists conviction colors mostly muted gray** — threshold-to-color mapping in `convictionTileClass()` likely not matching captain's mental mockup. Either thresholds need re-banding or upstream conviction values are clustering below 50 such that most tiles fall into the neutral band.
- **ARC sparkline subtle** — acceptable per Decision 2 simple-line v1 lock; captain noted but not flagged for change.
- **Rest of layout structurally aligned with intent** — composition shape working.

**PR / commit:** #73 (squash 8e1ca4c)

---

## 2026-05-08 — Flow Butterfly iteration #1: quick alpha wins

**What changed:** Four bundled visual upgrades to the Flow Butterfly chart (shared across `/tape`, `/tape-v2`, and `/butterflies`):

1. **Cross label cutoff fixed.** `LineChart`/`AreaChart` `margin.top` 8 → 28 in both `ButterflyCp` and `ButterflyBb`. Cross magnitude labels (`↗ $4.9M`) at `position: 'top'` with `offset: 4` no longer clip against the chart container's top edge.
2. **Tighter time windows.** `RangeKey` extended `'today' | '1h' | '30m'` → `'today' | '1h' | '30m' | '15m' | '10m' | '5m'`. `rangeToMin` covers the new keys. Toolbar tabs in `FlowPulseChart`, `FlowButterflySection` (ALL mode), and `Butterflies.tsx` all extended. Captain reads individual cross events when prints land every 2-5 min.
3. **Magnitude tertile chip + stroke styling per cross.** `flowButterflyCrosses.ts` now classifies each `CrossEvent` into `s` / `m` / `L` per the empirical thresholds from PR #64 design pass (small ≤ $164,123 = noise; mid ≤ $510,149 = bullish-midday cell hits 71.9%; large > $510,149 = bearish reverse-hit 77.8%). Cross labels render as `↗ $4.9M [L]`. Stroke style scales with tertile: large = bold/full opacity/`4 2` dash; mid = current; small = hairline/40% opacity/`2 4` dash. Eye reads magnitude tier before reading the label.
4. **Empirical session-phase shading underlay (ButterflyCp only in v1).** `computePhaseSpans()` helper classifies each data point's `bucket_time` into `open_hour` / `midday` / `mid_afternoon` / `close_hour` per PR #64 § A.4. Renders `ReferenceArea` per consecutive-same-phase run with subtle 4–6% fill — amber for open, emerald for midday (high-signal cell), slate for mid_afternoon, rose for close. Captain reads phase without computing minutes-since-bell.

**Why:** Captain pain points from screenshots 2026-05-08 (3:51, 3:53, 3:54, 4:03 PM) plus alpha-tightness — the empirical pass found magnitude tertile + session phase are the two strongest signal-conditioning axes. Surfacing them visually moves the captain's read from "compute filter in head" to "see filter on chart."

**End-state:**
- Cross labels render fully visible (no clipping).
- Range tabs offer Today / 1h / 30m / 15m / 10m / 5m. Captain picks tighter windows during high-flow moments.
- Each cross visually encodes magnitude tier via stroke + label `[s]` / `[m]` / `[L]` chip.
- ButterflyCp chart background carries faint phase-shading bands (amber=open, emerald=midday, slate=PM, rose=close) showing the empirical signal-rich vs noisy phases.
- All four changes propagate to `/tape` as well (shared FlowPulseChart) — bug fixes are a feature there, not a regression.

**Deferred to iteration #2 (overlay alignment fix) and #3 (ALL-mode + Past-mode polish):** captain's other flagged issues from same screenshots — overlays out-of-axis, ALL mode visual density, Past-mode lookback polish.

**PR / commit:** #75 (squash 08e3fb6)

---

## 2026-05-08 — Flow Butterfly iteration #2: overlay alignment structural fix

**What changed:** XAxis switched from categorical `time` strings to numeric `x_ms` (epoch ms via `Date.parse(bucket_time)`) on `ButterflyCp`, `ButterflyBb`, and `MiniFlowButterfly`. New `rebaseSeriesToToday()` helper shifts each overlay's `x_ms` values onto today's NY-tz session date while preserving HH:MM. `CrossEvent` and `PhaseSpan` types both carry `x_ms` now. `FourSeriesPoint` and `ButterflyPoint` types both carry `x_ms`. Tooltip `labelFormatter` reads `time` string from the payload (not from the numeric axis value). XAxis `tickFormatter` calls `formatXMsTick(v, multiDay)` so multi-day still shows date prefixes.

**Why:** Pre-iter-#2, the XAxis used `dataKey="time"` in default categorical mode. `fmtTime()` returns labels like `"1:35 PM"` with no date prefix. Today's `1:35 PM` and 5/4's `1:35 PM` collapsed into the same axis category — Recharts then merged today's data and overlay data onto colliding categories with non-deterministic ordering. Visible symptom (captain screenshot 4:03:53 PM): x-axis labels out of chronological order (`1:35 PM, 2:40 PM, 3:45 PM, 2:05 PM…`); ghost overlays clipped onto the wrong axis range.

**End-state:**
- Single-day live + historical: each point's `x_ms = Date.parse(bucket_time)`. Numeric XAxis. Tick labels render as time strings via `formatXMsTick`.
- Overlays: `rebaseSeriesToToday()` shifts each prior session's `x_ms` to today's date with same HH:MM. Today's `1:35 PM = 5/4's 1:35 PM` rebased = same numeric `x_ms`. Ghost lines collapse cleanly onto today's axis.
- Multi-day Past mode: each session's bucket_time has a different date, so numeric `x_ms` differs naturally. XAxis order is correct chronologically. `formatXMsTick(v, multiDay=true)` adds date prefix to ticks.
- Cross markers: `<ReferenceLine x={c.x_ms} />` — numeric, aligned.
- Phase shading: `<ReferenceArea x1={sp.x1} x2={sp.x2} />` — numeric, aligned.
- Tooltip: hover shows the original time string from the data payload (not the numeric x_ms value).
- MiniFlowButterfly inherits the same pattern (its hidden XAxis also numeric).

**Files touched:**
- `src/components/command/FlowPulseChart.tsx` — type defs, builders emit `x_ms`, new `rebaseSeriesToToday()` + `formatXMsTick()` helpers, ButterflyBb/Cp XAxis numeric + tickFormatter + labelFormatter + multiDay prop, `cpOverlays` rebases each overlay
- `src/lib/flowButterflyCrosses.ts` — `CpPoint` / `BbPoint` add `x_ms`, `CrossEvent` adds `x_ms`, both finders propagate
- `src/components/command/MiniFlowButterfly.tsx` — hidden XAxis switches to numeric `x_ms` + ReferenceLine x= numeric

**Deferred to iteration #3:** ALL-mode polish (per-panel y-axis unification toggle + cross magnitude micro-glyph) + Past-mode polish (day bands + quick-pick presets + per-day mini-summary chips).

**PR / commit:** #76 (squash; merged 2026-05-08 20:34Z)

---

## 2026-05-08 — Flow Butterfly iteration #3: ALL-mode + Past-mode polish

**What changed:** Three bundled polish items closing out the Flow Butterfly iteration sequence.

1. **Cross magnitude micro-glyph in MiniFlowButterfly.** Mini cross markers now carry a tiny `s` / `m` / `L` letter at the top of the dashed line (matching the full chart's `[s/m/L]` chip). Stroke weight + opacity scale with tertile (large=1.6 / 0.95; mid=1 / 0.7; small=0.8 / 0.4). Card height bumped 180 → 200 px to give the new label clearance. Eye reads tertile in the 10-up grid without needing a tooltip.
2. **Day bands in multi-day Past mode.** New `computeDaySpans()` helper emits one alternating subtle ReferenceArea per session day (5% / 2% gray fills). Renders in BOTH `ButterflyCp` and `ButterflyBb` when `multiDay=true`. Phase-shading underlay disables in multi-day mode (mixing layers was visually noisy); single-day modes keep phase-shading as before.
3. **Quick-pick date presets.** New row of `1d / 3d / 5d / 10d` preset buttons in the Past-mode date picker popover, above the From/To inputs. Each pick computes the N most-recent NY-tz weekday sessions ending yesterday (drops today since Past is for completed sessions only), commits the range, and closes the popover.

**Why:** Captain pain points from screenshots 2026-05-08 (4:03:17 ALL mode, 4:04:30 Past mode lookback). Quick-picks remove the typing-two-YYYY-MM-DD friction the captain flagged. Day bands resolve the "look back bays need fixed" cluttered visual.

**End-state:**
- ALL mode: 10-up grid panels carry tertile-encoded cross markers with `s` / `m` / `L` micro-glyphs. Captain reads magnitude tier on each panel without expanding to the full chart. Per-panel y-axis preserved (per /butterflies design philosophy of "read pattern shape, not magnitude across") — unified y-scale toggle deferred until captain asks.
- Past mode multi-day: alternating subtle gray bands separate session days clearly. Per-day reads stay independent (each session resets cumsum to zero per the existing sentinel-row mechanism) but the visual separation is now obvious.
- Date picker: `1d / 3d / 5d / 10d` quick-picks in popover header; manual From/To still works for arbitrary ranges.

**Files touched:**
- `src/components/command/FlowPulseChart.tsx` — `computeDaySpans()` + `DaySpan` interface; ButterflyCp + ButterflyBb render day bands when multiDay (instead of phase shading); quick-pick preset buttons in date popover
- `src/components/command/MiniFlowButterfly.tsx` — cross markers carry tertile-aware stroke + tiny `s/m/L` label; card height 180 → 200

**Iteration sequence closeout:** This wraps the Flow Butterfly bundle. Captain validates iter-#1 + iter-#2 + iter-#3 cumulatively on `/tape-v2` and `/tape`. Next direction at captain's call — likely the Rank 1 detector + grader autonomous build (per PR #64 design pass) which builds the 30-day grading corpus that unlocks "inline hit-rate per cross" alpha.

**PR / commit:** #77 (squash 692cb8a; merged 2026-05-08 20:45Z)

---

## 2026-05-08 — Best-alpha ship: `flow_butterfly` brain organ (Rank 2)

**What changed:** Shipped the 11th brain organ at `supabase/functions/_shared/flowButterflyContext.ts`. Computes per-ticker butterfly state (cross_state, magnitude tertile, session phase, ticker role, NextClose-direction signal heuristic) plus watchlist-aggregate state (consensus, first-cross leader) and surfaces both into `buildClaudeContext`. Captain explicitly asked for "the best alpha I can get" — this is it.

**Why this is "the best alpha":**
- Pre-organ, specialists fired flags **blind to the captain's strongest indicator** — butterfly state existed only as a chart for human eyes.
- The empirical pass at `docs/audits/flow-butterfly-empirical-design-pass.md` projects ~10–15pp hit-rate improvement on specialist flag quality once butterfly state composes into the brain payload.
- Compounds permanently — every flag fired from now on benefits.
- Doesn't require waiting for grading corpus. Uses the empirical thresholds + cells already locked in PR #64 § A.2-A.7.
- Detector + grader (Rank 1, queued next) will ground the heuristic in measured truth over 30+ days; the organ structure is already correct so wiring corpus → confidence is a one-line update later.

**Per-ticker fields:**
- `cross_state` — pre_cross / bull_crossed / bear_crossed
- `last_cross_at` + `cross_minutes_into_session` + `cross_phase` (open_hour / midday / mid_afternoon / close_hour per § A.4)
- `cross_magnitude_tertile` (small / mid / large per § A.3 thresholds $164k / $510k)
- `cross_magnitude_dollars`
- `gap_now` (signed cum_all_call − cum_all_put at latest data point)
- `cross_count_today` (noisy-day signal)
- `ticker_role` — fast_leader / index_carrier / slow_follower / lone_wolf per § A.7 first-cross-timing pattern (NVDA/MSFT/TSLA = fast_leader; QQQ/SPY = index_carrier; AAPL/META/GOOGL/AMZN = slow_follower; IWM = lone_wolf)
- `next_close_signal` — empirical heuristic per § A.3 + § A.4 cells:
  - large bearish (any phase) → bullish high-confidence (78% reverse-hit)
  - midday mid bullish → bullish high-confidence (72% hit)
  - midday bearish (mid+large) → bullish mid-confidence (69% reverse-hit)
  - bullish (other) → bullish mid-confidence (63% hit)
  - bearish (other) → bullish low-confidence (63% reverse-hit, weak contrarian)
  - small magnitude → null (noise)

**Watchlist fields:**
- `tickers_bullish` / `tickers_bearish` / `tickers_pre_cross` (counts across the 10)
- `consensus` — strong_bull (≥7 bull) / strong_bear (≥7 bear) / mixed / no_signal
- `cross_leader_today` — ticker with earliest cross today + direction (captures the QQQ-leads-Mag7 pattern empirically)

**How it's wired:**
- New file `supabase/functions/_shared/flowButterflyContext.ts` (~440 LOC). Implements full `ContextHelper<T>` contract per `_shared/contextHelper.ts`. Defensive-empty on error; never throws. organMetadata populated.
- `HelperName` union extended with `'flow_butterfly'` in `_shared/contextHelper.ts`.
- Wired into BOTH helper arrays in `_shared/claudeReadSurface.ts` (slim + standard buildClaudeContext variants) so every consumer that calls the orchestrator picks it up.
- `audienceFilter: ['cotrader', 'analyst', 'agent_internal']` — paper_claude stays isolated from operational tape signals per the firewall contract.
- Source: `ct_net_premium_expiry_split(p_ticker, p_since)` RPC (same source the FlowPulseChart UI reads from). 10 tickers in parallel via `Promise.all`. ~60s freshness covers one ingester tick.

**Files touched:**
- `supabase/functions/_shared/flowButterflyContext.ts` — NEW (440 LOC)
- `supabase/functions/_shared/contextHelper.ts` — `HelperName` += `'flow_butterfly'`
- `supabase/functions/_shared/claudeReadSurface.ts` — import + 2 helpers-array entries

**Deferred:**
- Rank 1 detector + grader cron (next ship) — captures every cross going forward into `ct_butterfly_cross_events`, grades outcomes at 5/15/30/60min/EOD/NextClose. Once 30+ days of corpus exist, the organ's `next_close_signal.confidence` switches from static empirical-pass thresholds to live rolling hit-rate.
- Warden invariants for the new organ data quality (cross_events_today_rth, hit_rate_drift, rpc_responsive). Pair-ship with Rank 1.
- 5min-delta gap, regime_hold_minutes, full cumsum_now snapshot — defer per "v1 captures highest-leverage fields only."

**Validation:** specialists pick up new organ on next read (after CI redeploys all `_shared/`-importing functions). Captain sees flag quality improvement empirically over the next several RTH days. No UI surface for this ship — it's autonomous-mode infrastructure (Tenet 26). Captain's primary surface (/tape-v2) doesn't change visually.

**PR / commit:** #78 (squash c54e044; merged 2026-05-09 00:19Z)

---

## 2026-05-09 — Best-alpha ship: Rank 1 detector + grader + warden invariants

**What changed:** Bundled corpus-building infrastructure completing PR #64 Rank 1.

1. **`ct_butterfly_cross_events` table** + `get_butterfly_hit_rates()` RPC (migration 20260510040000)
2. **`ct-butterfly-detector` edge function** — fires every 5 min RTH, UPSERTs new crosses into corpus
3. **`ct-butterfly-grader` edge function** — fires twice daily 20:30 UTC; intraday + NextClose grading from `ct_price_bars`
4. **4 EXISTS-guarded warden invariants** (migration 20260510040100): cross_events_today_rth, grader_intraday_lag, nextclose_grade_lag, rpc_responsive (critical)
5. **config.toml** registers both edge functions

**Why:** brain organ #78 uses STATIC thresholds. This ship builds the LIVE corpus that lets thresholds switch from heuristic to data-driven over 30+ RTH days. The corpus IS the long-term alpha compounding mechanism.

**End-state:** Detector fires every 5 min RTH starting Mon 5/11 ~13:35 UTC. Grader fires Mon-Fri 20:30 UTC. Warden invariants engage automatically once first cross row lands. Once corpus matures, organ's `nextCloseSignalFor()` upgradeable to rolling hit-rates with one-line query swap.

**Files touched:** 5 — 2 migrations (table + invariants), 2 edge fns (~700 LOC combined), 1 config.toml entry block.

**Verification path:** CI deploys edge functions (auto-discover); engine-room runs `npx supabase db push` post-merge to apply migrations + activate cron schedules. First corpus row Monday morning. Grader fires same day after RTH close.

**Bundle close:** Flow Butterfly is now alpha-tight (chart polish iters #1-#3) + brain-wired (#78) + corpus-capturing (this ship).

**PR / commit:** #79 (squash; merged 2026-05-09 00:33Z) + #80 phantom-fix recreate (squash; merged 2026-05-09 00:43Z, db push verified table live + 30 manual-fire corpus rows)

---

## 2026-05-09 — Flow Butterfly iteration #4: kill duplicate chart + sparse-data guard

**What changed:** Two visible production bugs captain flagged after first wall-clock validation pass:

1. **Duplicate chart rendering on /tape-v2.** `FlowPulse` (per-ticker table component) embeds `FlowPulseChartPanel` internally (line 379). Then `FlowButterflySection` ALSO renders a chart in MARKET / TICKER mode and a 10-grid in ALL mode. Result: two stacked Flow Butterfly charts on /tape-v2 — one from FlowPulse, one from FlowButterflySection. ALL mode doubly trash because the MARKET chart from FlowPulse stays visible above the 10-grid.
2. **Sparse-data trash in 5m / 10m windows.** Captain saw single diagonal lines per panel in ALL × 5m, "flat" labels for tickers with <2 points. Cause: chart connects whatever data points exist, so 1-2 points in a narrow window paints a misleading single-segment line. Same problem during slow-flow midday for low-volume tickers.

**Why:** Captain's wall-clock validation: "the all panel is still absolute trash. yes we added the smaller timeframes but if you click on said smaller timeframes they're worthless." Visual diagnosis via Chrome MCP confirmed both bugs at the DOM level.

**Fixes:**

1. **Kill the duplicate.** Added `showChartPanel?: boolean` prop to `FlowPulse` (default `true` preserves /tape behavior — propagation-safe). `TapeV2` passes `showChartPanel={false}`. v2 becomes: FlowPulse-table-only + FlowButterflySection-three-mode-chart-or-grid. Single chart surface, no doubling.

2. **Sparse-data guard.** In `MiniFlowButterfly` and both `ButterflyCp` + `ButterflyBb` renderers in `FlowPulseChart`, when `data.length > 0 && data.length < 3` (1-2 points = misleading single-segment line), render a "low density — N data point(s) in window · widen window" placeholder instead of the trashy line. Threshold = 3 because that's the minimum needed to draw any pattern shape (2 segments per series).

**End-state:**
- /tape-v2 renders ONE Flow Butterfly chart surface (controlled by FlowButterflySection's MARKET/TICKER/ALL toggle), not two stacked ones.
- 5m / 10m windows in ALL mode (and full chart) show "low density" placeholder when prints are sparse, instead of misleading single-line trash.
- /tape unaffected — `showChartPanel` default `true` keeps the legacy embedded chart there.

**Files touched:**
- `src/components/command/FlowPulse.tsx` — `showChartPanel?: boolean` prop, default true; conditional `{showChartPanel && <FlowPulseChartPanel ... />}`
- `src/pages/TapeV2.tsx` — pass `showChartPanel={false}`
- `src/components/command/MiniFlowButterfly.tsx` — sparse guard via `seriesLength < 3` → "low density" placeholder
- `src/components/command/FlowPulseChart.tsx` — sparse guard at top of `ButterflyCp` and `ButterflyBb` → same placeholder

**Validation:** Captain visual check on /tape-v2 production after deploy — only one chart, narrow windows show "low density" message instead of garbage lines.

**Bundle status:** Flow Butterfly v2 visual layer is now actually-clean (iter #1+#2+#3 polish + iter #4 dedup + sparse-guard) plus brain-organ-wired (#78) plus corpus-capturing (#79+#80 fix). The visible-on-/tape-v2 surface should now match what captain expects on first read.

**PR / commit:** #81 (squash; merged 2026-05-09 00:53Z) + #82 hotfix-React-error-300-from-iter-#4-conditional-hooks (squash; merged 2026-05-09 ~01:11Z)

---

## v2 ALPHA SURFACE — RESHAPED 2026-05-09: NEW route, separate from /tape and /tape-v2 (both stay v1-class)

Captain reframed during 5/8 evening vision-mode. The "v2 command-center" iteration sequence (PRs #73→#82 above) lives at /tape-v2 and is NOW v1-class. The new v2 is a NEW route — surgical-grade institutional flow diagnostic where the system's intelligence becomes visible. Three temporal layers stack (near + medium + long horizon). Push not render for non-alphas. Embedding-layer as the underutilized moat to activate.

Brief reshaped 2026-05-09 from "audit + design doc, no code" → "audit-while-building" because sandbox safety holds (separate route, single-PR rollback, captain validates iterations on the live URL).

Architecture-fundamental gates (A7 + A6) passed clean from the prior audit (PR #83 design doc):
- A7: tape commentary semantic recall = 1-PR ship; butterfly = multi-PR; heatmap GEX = JAC-core kernel work (separate scoping). NO blocker for v2 build.
- A6: long-dated positioning depth fully feasible from existing ct_oi_snapshots + ct_contract_tracks (both indefinite retention). NO blocker.

---

## 2026-05-09 — Alpha v2 iter #1: page shell + ClaudesRead + four-surface placeholders

**What changed:** New route `/alpha`. Page shell at `src/pages/Alpha.tsx`, three new components in `src/components/alpha/`. Hidden from top nav initially (captain validates via direct URL).

**Layout (per design doc Layout 1 "Stacked Diagnostic"):**
- Top strip: regime · tide · VIX · push count (existing useRegimeState + useTapeReader + useAlarmRealtime)
- **ClaudesRead full-width section** (the synthesis layer captain reads first): latest tape commentary + top 3 specialist reads by conviction. Reuses existing useTapeReader + useSpecialistsTileRow hooks from /tape-v2 — honest first cut, no new substrate.
- Two middle-layer surface placeholders: Flow Butterfly historical (multi-day arc) + Heatmap alpha-class
- Curated tape placeholder: filtered to flagged/stacked contracts only, future get_v2_curated_tape RPC
- Long-dated positioning placeholder: 10 tickers × 12-month OI momentum heatmap

**Why iter #1 ships placeholders for 4 of 5 surfaces:** captain validates the architecture + identity + Claude's-Read-as-leadership pattern immediately on the live URL, then iters wire each surface in turn. Honest about what's pending; not faking presence.

**Architecture identity locked:**
- Push-not-render footer rationale visible: "Specialists, Flow Pulse, full news panel, Stacking → off this page; arrive via Slack emission."
- Three temporal layers visibly stacked top-to-bottom
- Bloomberg-terminal-class minimal chrome (no consumer-dashboard padding/widgets)

**Files touched:**
- `src/pages/Alpha.tsx` — NEW page shell (~110 LOC)
- `src/components/alpha/AlphaTopStrip.tsx` — NEW (~95 LOC)
- `src/components/alpha/ClaudesRead.tsx` — NEW (~155 LOC)
- `src/components/alpha/AlphaPlaceholderSection.tsx` — NEW reusable placeholder component (~40 LOC)
- `src/App.tsx` — +1 import, +1 route (1-line route addition pattern, hidden from nav)

**Reuse:** AuthLayout (left chat sidebar automatic) + ChatPanel + Card + useRegimeState + useTapeReader + useAlarmRealtime + useSpecialistsTileRow. Zero edits to existing components or hooks.

**Iter #2 next ship:** Flow Butterfly historical-pattern surface (Shape A multi-day cross magnitude arc + Shape B watchlist consensus rollup). Reads from `ct_butterfly_cross_events` corpus shipped by PR #79/#80. First useful arc once corpus has ≥5 RTH days (~5/15).

**Iter #3 queue:** Heatmap alpha-class redesign (Shape D — baseline-comparison default, strike-side dominance badges, drill panel surfacing per-alert conviction).

**Iter #4 queue:** Curated tape via new `get_v2_curated_tape` RPC composing ct_scored_flow + ct_flags + ct_contract_tracks + ct_specialist_reads filters.

**Iter #5 queue:** Long-dated OI momentum heatmap (Shape E) — needs new `ct_oi_monthly_baselines` aggregation table + nightly cron + extended OI delta RPC.

**Iter #N (post-C1 5/15+):** semantic recall over tape commentary embedding (1-PR backend ship) — wires `ct-tape-reader` to embed each commentary at write-time + activates query in ClaudesRead via existing `ct_similar_items` RPC. The semantic-recall-on-tape ship is the deepest unlock per PR #83 audit.

**PR / commit:** TBD on push

---

## 2026-05-09 late evening — Phase 1: ct_tape_commentary embedded at write-time

**Audit anchor:** `docs/audit/2026-05-09-jac-os-fusion-ground-truth.md` Section B gap #2. First substrate ship in the audit-driven Phase 1→6 loop. Brought forward from "Iter #N post-5/15" because the audit + 5x bar required substrate before any more captain-visible iters.

**5x bar:** Substrate alone isn't captain-visible 5x; it enables Phases 3 + 4 (Tape Reader Arc + ClaudesRead semantic recall) which ARE the captain-visible 5x. Substrate ships as part of the stack so Path A surfaces have something real to render.

**What shipped:**
- Migration `20260510050000_ct_tape_commentary_embedding.sql` — `embedding extensions.vector(512)` + `rich_text` columns + HNSW COSINE index + `match_ct_tape_commentary_by_similarity` RPC + warden invariant `tape_commentary_embedding_backlog_1h`
- Migration `20260510050100_ct_embed_tape_commentary_cron.sql` — schedules `ct-embed-tape-commentary-rth` every 5 min RTH
- New edge function `supabase/functions/ct-embed-tape-commentary/` — backlog drainer (batch 1-100, internally chunks ≤20 per Voyage gotcha)
- Edited `supabase/functions/ct-tape-reader/index.ts` — imports `voyageEmbed`, after successful insert builds rich_text + voyageEmbeds + UPDATEs row. Fire-and-forget; never blocks response. Returns `embed: { ok, error }` in response shape
- New runbook `docs/runbooks/embedding_gate.md` — diagnosis sequence + manual backfill recipe for the embedding-gate invariant family
- `supabase/config.toml` — `ct-embed-tape-commentary` registered with verify_jwt=false

**rich_text shape (the cluster axis):**
```
TAPE_COMMENTARY | tide:bullish vix:18.50 flags:3 flow:12 | session:2026-05-09
<commentary text>
```
Header carries regime+state context so embeddings cluster by setup-shape, not just prose. Validated end-to-end: row 1178 (Sat pre-market, quiet tape, 0 flow, flat tide) returned 5 most-similar prior reads — ALL also quiet-tape/0-flow/flat-tide pre-market reads (cosine 0.86-0.88). Similar SETUPS cluster, not just similar words.

**Live state at ship:**
- 1,178 total tape commentary rows (~15+ days of substrate)
- 224 embedded immediately (manual fire + 10 parallel backfill drains)
- 954 remaining; cron drains over next RTH session (~hour)
- Write-time path verified live via row 1178 manual fire
- match RPC verified end-to-end with self-match query
- Warden invariant registered, dormant until next 30-min warden tick

**Files touched:** 7 — 2 migrations, 1 new edge function, 1 edge function edited, 1 config.toml entry, 1 runbook, 1 iteration log entry.

**No /alpha visible change yet.** Phases 3 + 4 ship the captain-visible 5x downstream from this substrate.

**Time:** ~30 min from "go" to substrate-live.

**PR:** #86 (squash-merged 2026-05-09 11:35Z, commit 93b03e2).

**Next:** Phase 2 — same substrate pattern for `ct_news_causality`. Then Phase 3 ships the first captain-visible 5x render off this substrate.

---

## 2026-05-09 late evening — Phase 3: Tape Reader Arc on /alpha

**FIRST CAPTAIN-VISIBLE 5x SHIP** of the audit-driven 1→6 loop.

**Captain articulation (prior session):** *"There's a tape reader every 10 minutes... Read the fucking text: green light, red light, blue light, blue light, blue light, red light. I don't even know how we'll design it."* — captain wants the system's evolving tape-reader "mood" as a glance-able visual primitive, not as scrollable prose.

**5x bar measured against /tape, /tape-v2, /tape-reader:**
- `/tape`: raw flow rows, no commentary structure
- `/tape-v2`: latest commentary text + 3 specialist tiles, snapshot only
- `/tape-reader`: full commentary timeline as scrollable prose list — captain reads minutes per session
- **Arc:** full session compressed to ~60 horizontal segments, structurally reads the day's mood evolution at a glance — sub-second alpha-density. Different surface, not "improved tape." Passes 5x bar.

**What shipped:**
- New hook `src/hooks/useTapeReaderArc.ts` — fetches today's chronological tape commentary (filtered by NY-tz session_date), oldest-first, refetches every 60s, derives dominant-tide rollup + intensity per segment (flag_count + flow_count/4)
- New component `src/components/alpha/TapeReaderArc.tsx` (~190 LOC) — horizontal segment strip with HoverCard per segment, click-to-pin behavior, latest-segment glow ring, `flag_interrupt` segments ringed amber, full-commentary detail strip below
- `src/pages/Alpha.tsx` — TapeReaderArc mounted between AlphaTopStrip and ClaudesRead

**Visual primitive design:**
- Segment color: `bullish=emerald-500`, `bearish=red-500`, `flat=blue-400` (per captain's "green/red/blue light" framing)
- Segment height: scaled 8-32px by intensity (flag count + flow count/4, capped at 16)
- Segment width: flex-1 min/max 6/14px — auto-fits a full RTH session (~60 reads)
- Latest segment: glow ring + 100% opacity (vs 80% prior)
- Pinned segment: ring-2 primary + bottom detail expansion
- `flag_interrupt` segments: amber 1px ring (separates manual interrupt reads from scheduled cron reads)

**Hover behavior:** any segment surfaces full commentary + tide + VIX + flag_count + flow_count + timestamp in a HoverCard. Captain reads the day arc, hovers any segment of interest, gets full context.

**Files touched:** 4 — 1 new hook, 1 new component, 1 page edit, 1 iteration log entry.

**Build state:** `npm run build` passes clean (vite, no type errors, 4158 modules). UI not visually verified locally — captain validates post-deploy on linkjac.cloud/alpha. If tide-color thresholds or segment density needs tuning, append iter #2 entry.

**Time:** ~25 min from "go" to ship-ready.

**Substrate dependency:** Uses `ct_tape_commentary.market_tide` + `vix_level` + `flag_ids` + `flow_ids` (all existing columns). Does NOT yet use Phase 1 embedding column — that powers Phase 4 (semantic recall in ClaudesRead) next.

**Next:** Phase 4 — wire semantic recall into `ClaudesRead` ("5 most-similar past reads + their outcomes"). The iter #2 hint at `ClaudesRead.tsx:154` becomes the actual surface, powered by Phase 1 substrate.

---

## 2026-05-09 late evening — Phase 4: Semantic recall in ClaudesRead

**The iter #2 hint becomes reality.** The footer text at `src/components/alpha/ClaudesRead.tsx:154` ("iter #2 · semantic recall over historical reads (5 most-similar past reads + NextClose outcomes)") had been pending since iter #1. Phase 4 ships the actual surface, powered by Phase 1 substrate.

**5x bar:** Captain reads "today is similar to 5/5 14:32 (0.87 cosine), 5/7 09:48 (0.85), ..." — pattern recall by setup-shape (tide + vix + flag-count + flow-count + commentary prose), not chronological scrolling. Surface doesn't exist anywhere on /tape, /tape-v2, /tape-reader. Structurally different.

**What shipped:**
- New hook `src/hooks/useSemanticTapeRecall.ts` — fetches latest tape commentary's embedding column, calls `match_ct_tape_commentary_by_similarity` RPC with that embedding (excludes the same-minute self-match), returns up to 5 most-similar prior rows. Refetches every 90s.
- `src/components/alpha/ClaudesRead.tsx` — replaced the "iter #2 hint" footer with the actual surface. New section "Today most resembles · semantic recall" renders 5 match rows: short date+time | tide chip | vix | flag/flow counts | commentary snippet | similarity %. Empty state when threshold not met.

**Match row layout:**
```
5/7 09:48 ET  flat   vix 17.2  f0/p0  Quiet pre-market, zero options flow...   87%
5/5 14:32 ET  bull   vix 18.5  f3/p12 Tape pivoting bullish on NVDA call...   84%
```

**Substrate verification (from Phase 1 ship):** row 1178 (Sat pre-market quiet tape, 0 flow, flat tide) returned 5 most-similar prior reads ALL also quiet-tape pre-market reads (cosine 0.86-0.88). Cluster axis works; surface now reads it.

**NextClose outcomes deferred:** the iter #2 hint mentioned "+ NextClose outcomes." That requires a join to ct_price_bars (compute SPY % change in 60min after the historical read). Deferred to iter #2 of Phase 4 — surface alone proves the substrate works; outcomes are an iteration on top.

**Files touched:** 3 — 1 new hook, 1 component edit, 1 iteration log entry.

**Build state:** vite build passes clean (4158 modules). No type errors. UI not visually verified locally — captain validates post-deploy.

**Time:** ~15 min from "Phase 3 done" to ship-ready.

**PR:** #89 (squash-merged 2026-05-09, commit TBD).

**Next:** Phase 5 — News Causality Graph on /alpha. Renders `ct_news_causality` substrate as nodes/edges in one of the iter #4/#5 placeholder slots.

---

## 2026-05-09 late evening — Phase 2: ct_breaking_news embedded (cron-only)

**Audit anchor:** `docs/audit/2026-05-09-jac-os-fusion-ground-truth.md` Section B (breaking news 0% embedding gap). Pivoted from original "ct_news_causality" target because that's structured numeric (no prose to embed); ct_news_analyses already gates at sig≥3 by design. **The actual 0%-embedded news gap is ct_breaking_news (1.2k rows, Tavily firehose).**

**Why cron-only (no producer edits):** Two producers (`ct-news-sweep`, `ct-tavily-news-watcher`) both insert without embedding. Streamlined approach: skip producer edits, accept ~5-min embed latency via cron-only drainer. Acceptable for breaking-news semantic recall — captain looks back at "5 most-similar prior news days," not "embed within 1 second of insert." Future write-time-embed is a 1-PR optimization if 5-min latency becomes load-bearing.

**5x bar:** Substrate enabling Phase 5 (News Causality Graph on /alpha). Substrate alone isn't captain-visible; Phase 5 is.

**What shipped:**
- Migration `20260510060000_ct_breaking_news_embedding.sql` — embedding + rich_text columns + HNSW + `match_ct_breaking_news_by_similarity` RPC (with ticker_filter + min_severity params) + warden invariant `breaking_news_embedding_backlog_10m`
- Migration `20260510060100_ct_embed_breaking_news_cron.sql` — schedules `ct-embed-breaking-news-24x7` every 5 min ALL hours (Tavily fires off-hours unlike RTH-only flow tables)
- New edge function `supabase/functions/ct-embed-breaking-news/` — backlog drainer, batch 1-100, internally chunks ≤20 per Voyage gotcha
- `supabase/config.toml` — `ct-embed-breaking-news` registered with verify_jwt=false

**rich_text shape:**
```
BREAKING_NEWS | sev:3 sent:bullish cat:sector tickers:[NVDA,AMZN] macro:false
<headline>
<summary>
```
Cluster axis is severity + sentiment + category + tickers, not just headline prose.

**Live state at ship:**
- 1,232 total breaking_news rows
- 184 embedded immediately (13 parallel drain batches, Voyage rate-limited)
- 1,048 remaining; cron drains over next ~hour
- match RPC verified end-to-end (1.000 self-match, 0.65-0.68 on related Amazon news)
- Warden invariant registered

**Files touched:** 5 — 2 migrations, 1 new edge function, 1 config.toml entry, 1 iteration log entry.

**Time:** ~20 min from "go" to substrate-live.

**Pivot finding:** ct_news_analyses gates embedding at significance≥3 by INTENTIONAL DESIGN ("keeps the corpus tight" per ct-news-ingester:198). 342/2030 = 17% coverage is correct, not a bug. The audit's call-out of "ct_news_causality needing embedding" was wrong (it's structured numeric). The real gap was ct_breaking_news firehose, now closed.

**Note:** shipped out of phase-number order — Phase 3 + Phase 4 already merged before Phase 2 because the captain prioritized captain-visible 5x surfaces ahead of pure backend substrate. ct_breaking_news embedding still required for Phase 5 (News Causality Matrix) consumer.

**PR:** #87 (squash-merged 2026-05-09).

**Next:** Phase 5 — News Causality Matrix on /alpha (renders empirical per-source × per-ticker hit rates).

---

## 2026-05-09 late evening — Phase 5: News Causality Matrix on /alpha

**The 2-month-old derived signal finally surfaces.** The `ct_news_causality` schema comment (migration 20260416000019, shipped 2026-04-16) explicitly designed the per-source × per-ticker hit-rate signal: *"Per-source hit rates become a novel derived signal ('Bloomberg moves NVDA flow 68% of the time, Tradex 12%')."* The cron has been computing it every 15 min for ~3 weeks. **No UI ever rendered it.** Phase 5 closes that gap.

**5x bar:** Surface doesn't exist anywhere in the system. Captain has been blind to which news sources reliably drive flow on which tickers. Source × ticker matrix renders the empirical edge in a single glance.

**What shipped:**
- Migration `20260510070000_get_news_causality_hit_rates.sql` — `get_news_causality_hit_rates(p_lookback_days, p_min_n, p_tickers)` RPC: aggregates ct_news_causality by (news_source, ticker), returns total_n + moved_count + hit_pct + flow_moved_count + dp_moved_count + premium totals. HAVING N >= p_min_n filters single-fluke noise.
- New hook `src/hooks/useNewsCausalityMatrix.ts` — calls RPC with watchlist filter + 7-day default lookback, reshapes flat list into source-keyed matrix, sorts sources by total_n DESC. Refetches every 5 min.
- New component `src/components/alpha/NewsCausalityMatrix.tsx` (~190 LOC) — compact source × ticker grid, cells colored by hit-rate band (60%+ emerald-bold, 40-60% emerald, 25-40% amber, 10-25% blue, <10% gray). HoverCard surfaces full breakdown (total_n, flow_moved, dp_moved, total premiums). Per-source mean column at right.
- `src/pages/Alpha.tsx` — `<NewsCausalityMatrix />` mounted between curated-tape placeholder and long-dated positioning placeholder.

**Live state at ship — RPC verification (sample query):**
```
Benzinga    NVDA  n= 52  moved= 18  hit=34.6%
Benzinga    SPY   n= 47  moved= 11  hit=23.4%
Benzinga    QQQ   n= 44  moved= 11  hit=25.0%
Benzinga    AMZN  n= 41  moved=  8  hit=19.5%
Benzinga    GOOGL n= 38  moved=  5  hit=13.2%
Benzinga    MSFT  n= 36  moved=  3  hit=8.3%
```

Real signal: Benzinga clearly the dominant news volume source; NVDA the most-moved ticker (34.6%); MSFT the most-noise (8.3%). **Captain has never seen this.**

**Files touched:** 4 — 1 migration, 1 new hook, 1 new component, 1 page edit, 1 iteration log entry.

**Build state:** vite build passes clean (4158 modules). UI not visually verified locally — captain validates post-deploy.

**Time:** ~25 min from "Phase 4 done" to ship-ready.

**Next:** Phase 6 — Regime Flip Journal. Renders `ct_regime_history` transitions on /pulse (or as another /alpha section) with trigger annotations. Last visible-5x phase before Phase 7 unlocks 2026-05-13 post-D2.2-verdict.

---

## 2026-05-09 evening — PR-D: migration-timestamp-collision CI class-kill

**What changed:** New CI workflow `.github/workflows/migration-timestamp-check.yml` that fails any `pull_request` adding a `supabase/migrations/*.sql` whose 14-digit timestamp prefix already exists on `origin/main`. Methodology entry appended under existing `## docs-PR-merge-doesnt-imply-migration-applied` heading in `docs/methodology-patterns.md` capturing both 5/9 fires and the class-kill rationale.

**Why:** Cascade `docs-PR-merge-doesnt-imply-migration-applied` fired twice on 2026-05-09 — morning (PR #70 ↔ PR #79 collision at `20260510040000` silently no-op'd the apikey fix; recovered via PR #92 fresh-timestamp re-apply) and evening (orphan PR #70 file on main caused duplicate-key error blocking `db push` of PR #94's new `20260510100000` migration; recovered via `migration repair --status applied` + temp file move). Two empirical fires in one day meets YAGNI threshold for write-time prevention. The collision does not surface as a git merge conflict (different filenames) — CI is the only pre-merge layer that can catch it.

**End-state:**
- `.github/workflows/migration-timestamp-check.yml` triggers on `pull_request` with paths matching `supabase/migrations/*.sql`.
- Enumerates timestamps already on `origin/main` via `git ls-tree` + sed/grep extraction.
- Enumerates new-migration timestamps in the PR via `git diff --diff-filter=A` from merge-base.
- Fails with explicit `::error file=…` annotation listing the conflicting timestamp, the new file, the existing file(s) on main, and the latest timestamp on main as a suggested fresh-stage point.
- Pre-existing collisions on main (PR #70 ↔ PR #79 orphan pair at `20260510040000`) are NOT flagged — regression-only.
- Branch protection should add this workflow as a required check once one PR exercises the rule live (captain gates).
- Methodology entry appended under existing `## docs-PR-merge-doesnt-imply-migration-applied` heading: 2026-05-09 evening orphan-blocks-push instance + class-kill ship explanation.

**Files touched:** 3 — 1 new workflow, 1 methodology-patterns entry append, 1 iteration log entry.

**Build state:** Workflow logic verified locally by simulating both branches: empty NEW_FILES (current worktree state, no migrations added) → exits 0 with "check N/A"; collision against `20260510040000` → correctly flagged WOULD FAIL; fresh `20260601000000` → correctly WOULD PASS. 481 distinct timestamps enumerated on origin/main. No false-positive risk; workflow does not flag pre-existing collisions.

**Single-purpose discipline:** PR contains only the workflow + methodology entry + this iteration log entry. Captain reviews; do not auto-merge.

**Cross-catalog parity flag (open):** Cowork-side `/Users/jameschellis/Documents/cowork-cotrader/memory/patterns.md` does NOT have an entry for `docs-PR-merge-doesnt-imply-migration-applied` at all (verified by grep on `migration|timestamp|schema_migrations|silently no-op|PR #70|PR #92|PR #94`). The brief asserted parity already existed; empirically it does not. Captain should paste a parallel entry — paste-ready text included in PR description.

**PR / commit:** PR-D (open via this branch).

---

## 2026-05-09 evening — PR-C: PWA install popup suppressed on /alpha + dismissals persist

**What changed:** `src/components/InstallPrompt.tsx` — added `/alpha` (and any `/alpha/*` sub-route) to the existing route-suppression guard alongside `/jac`, and migrated dismissal persistence from `sessionStorage` to `localStorage` (with one-shot legacy-flag migration so existing sessionStorage dismissals carry over). No other component edits.

**Why:** Cowork visual validation 5/9 afternoon flagged "Install LinkJac" PWA install popup appearing on /alpha — consumer-feel injection on a surgical-grade institutional flow surface. Identity violation. Same class as the existing /jac Nerve Center carve-out already in this file.

**Option C (both) over A or B alone:** Route guard closes the cited /alpha identity violation immediately and follows the precedent already encoded in the file (line 57 `pathname === '/jac'`). The sessionStorage→localStorage upgrade is the durable fix — without it, James dismisses the popup, closes the browser, and gets it again next session on every other route. Both are tiny; defense in depth on a pure UX class with zero downside.

**End-state:** Install popup never renders on `/jac`, `/alpha`, or `/alpha/*`. On all other routes (e.g. `/dashboard`), once dismissed, stays dismissed across sessions. Native `beforeinstallprompt` is still preempted (`e.preventDefault()`); browser will not auto-show its own install affordance.

**Phase A flag (not fixed in this PR):** InstallPrompt.tsx uses raw `window.location.pathname` instead of `useLocation()` from react-router. Works in practice (component re-renders on route nav because parent re-renders), but it's a subtle reactivity correctness gap — if the install event fires after a route change without parent re-render, the guard could read a stale path. Single-purpose discipline holds: PR-C is the suppress fix, the `useLocation()` switch is a separate cleanup if/when it actually bites.

**PR / commit:** PR-C in 5/9 evening bundle.

---

## 2026-05-09 — Phase 5 PR-B: News Causality Matrix below-threshold cell clarity

**What changed:** `src/components/alpha/NewsCausalityMatrix.tsx` — `MatrixCell` no-row branch swapped from a flat em-dash placeholder to an explicit `n<min` badge with hover explainer, plus a legend line distinguishing "below sample-size floor" from a 0% hit rate. No data layer or RPC change — frontend-only disambiguation.

**Why:** Captain's 5/9 afternoon visual validation flagged the Trades source row as anomalous: GOOGL 67%, MSFT 48%, NVDA 43%, AAPL 50%, AMZN 0%, META 0%, TSLA 25%. Phase A finding (c) — HAVING-filter renders below-threshold cells as ambiguous em-dash, captain reads as 0% hit rate. Empirical verification:

```
Tradex 7d watchlist (raw ct_news_causality):
  NVDA  total=7  moved=3  hit=42.9%   → RPC returns, renders 43
  AAPL  total=8  moved=4  hit=50.0%   → RPC returns, renders 50
  MSFT  total=5  moved=2  hit=40.0%   → RPC returns, renders 40
  GOOGL total=3  moved=2  hit=66.7%   → RPC returns, renders 67
  AMZN  total=2  moved=0  hit= 0.0%   → BELOW p_min_n=3 → em-dash → mis-read
  META  total=12 moved=1  hit= 8.3%   → RPC returns, renders 8 (genuine low)
  TSLA  total=4  moved=1  hit=25.0%   → RPC returns, renders 25
  QQQ/SPY/IWM total=0                 → no rows at all
```

AMZN's underlying data DOES exist (n=2, never moved) — the em-dash erased the distinction between "no coverage" / "below threshold" / "actual 0%." Two of those mean different things and one (actual 0%) wasn't even in play. RPC + data layer are both correct.

**Cascade instance surfaced:** the family **placeholder-glyph-collapses-three-states**. A single em-dash collapsed (a) "no rows at all," (b) "rows exist but below n_min," and (c) "rows exist and hit rate is 0%" into one visual. Sibling to other catalogued ambiguity-collapse classes — flagging for engine-room methodology-patterns.md follow-up.

**End-state:** Below-floor cells render as a small dashed-border `n<min` badge instead of em-dash. Hover surfaces "Below sample-size floor for the lookback window. Not enough news from this source on this ticker yet to produce a stable hit-rate cell. Not 0% — unknown." Legend line explicitly calls out the badge meaning. Captain reads coverage gap at a glance and can no longer mistake it for a 0% hit rate.

**Single-purpose:** PR is ONLY the Trades-row anomaly resolution. No matrix layout overhaul, no other source rows, no other consumers, no migration.

**Files touched:** 2 — 1 component edit, 1 iteration log entry.

**Build state:** vite build passes clean (4161 modules). UI captain-validates post-deploy.

**PR / commit:** TBD (PR-B in the bundle).

---

## 2026-05-09 evening — PR-A: TapeReaderArc / ClaudesRead prose dedup on /alpha

**Audit anchor:** Cowork visual validation 5/9 afternoon flagged that `ClaudesRead.tsx` (synthesis prose home, lines 132-138) and `TapeReaderArc.tsx` (mood-arc + bottom detail strip, lines 168-196) render the same latest tape commentary text within ~200vh on /alpha. Same `ct_tape_commentary` substrate via two paths (`useTapeReader` direct vs. `useTapeReaderArc` aggregated) — when `pinned === null` (default page state), the arc's bottom strip echoed the latest commentary already rendered above in ClaudesRead.

**Resolution chosen:** option (a) — distinguish structurally. The arc keeps its visual primitive (segment strip + tide colors + intensity heights + glow on latest + amber ring on flag_interrupt + per-segment HoverCard with full prose). ClaudesRead remains the prose home for the latest read. Bottom detail strip now activates only when the captain pins a non-latest segment — the strip becomes the historical drill-down surface, not a redundant latest-prose echo.

**Why (a) over (b) collapse:** the arc reads structurally distinct without the bottom prose strip — segments + glow already communicate latest position, HoverCard handles explore-on-hover for any segment including latest, and the pinned-segment drill-down is the unique value the strip carries (no other surface on /alpha lets the captain pin a 10:30 ET read while the latest is 14:50 ET).

**What changed:** `src/components/alpha/TapeReaderArc.tsx` — removed unused `latest` from useTapeReaderArc destructure (was only consumed by `pinned ?? latest` fallback); replaced fallback with `focused = pinned && !isLatestPinned ? pinned : null`; conditional render no longer branches on "pinned vs latest" label (always "pinned · HH:MM ET"); unpin button always visible when strip renders.

**End-state on /alpha:**
- ClaudesRead: latest tape commentary prose (13px) — single home for synthesis read.
- TapeReaderArc: header + segment strip + per-segment HoverCard. No bottom strip on first paint or after unpin. Bottom strip activates the moment captain clicks a non-latest segment; clicking the latest segment is a no-op (HoverCard already covers it).
- Captain's daily-glance flow: read latest from ClaudesRead, scan arc for mood evolution, click a historical segment to pin and drill — three distinct surfaces, no duplicated prose.

**Discipline gates run:**
- Engine-room write-time checklist: state-vs-intent ✓ (intent: dedup latest-prose; formula: gate strip on pinned && !isLatestPinned), no calendar anchor, cross-catalog parity N/A (UI-only), substrate verified (no schema touch), Tenet 24 N/A (no new surface).
- Single-purpose: one component, one logic gate, no specialist-tiles or placeholder edits (DECISION-1 / DECISION-2 captain-pending — not touched).
- `npx tsc --noEmit`: clean.
- `npm run build`: clean (4161 modules, 3.98s).

**Files touched:** 2 — 1 component edit, 1 iteration log entry.

**PR:** #TBD (single-purpose, no auto-merge — captain validates visually post-deploy on /alpha).

**Next:** captain validates dedup on live /alpha; if confirmed, the visual-validation cowork pass moves to its next /alpha item.

---

## 2026-05-09 evening — iter #2.6: surface compression per captain decisions

**Captain decisions locked (v2 identity reading):**

**DECISION-1 — Top Specialist Reads section: MOVE OFF /alpha.** v2 identity is surgical-grade institutional flow diagnostic, not specialist roster render. Specialists are graded sub-system outputs that feed Claude's synthesis; rendering top-3 conviction tiles alongside the synthesis is redundant. Specialists remain accessible via existing `/specialists` depth view + Slack emission triggers (when `specialist_conviction_shift` ships per PR #83 catalog).

**DECISION-2 — 4 "SHIPS ITER #X" placeholder sections: HIDE.** Surgical-grade surfaces don't render "coming soon" vapor. Bloomberg terminals don't display future-capability placeholders. Each iteration ships the surface; until then it doesn't render. `docs/audit/tape-v2-iteration-log.md` + `scope/` docs already capture trajectory.

(The brief said "5 placeholders" — `Alpha.tsx` actually had 4: Flow Butterfly multi-day arc, Heatmap alpha-class, Curated tape, Long-dated OI momentum. Same intent, accurate count.)

**What changed:**
- `src/components/alpha/ClaudesRead.tsx` — removed `useSpecialistsTileRow` import + `SpecialistTile` type + `Sparkles` icon + `convictionColor` helper + `arrowFor` helper + `topSpecialists` derivation + the entire "Specialist reads" render block. Latest commentary + semantic recall sections preserved unchanged. Header docstring updated.
- `src/pages/Alpha.tsx` — removed `AlphaPlaceholderSection` import + 4 placeholder render calls + the wrapping 2-column grid div + `Activity / Flame / Filter / Layers` icon imports (only used by the placeholder calls). Header docstring updated. Footer rationale tightened to reflect "future surfaces land when each iter ships" framing instead of pre-rendering the trajectory.
- `src/components/alpha/AlphaPlaceholderSection.tsx` — DELETED (orphan after removing the 4 calls).

**Phase A verification:**
- `useSpecialistsTileRow` still imported by `tape-v2/SpecialistsTileRow.tsx` and `tape-v2/FlowButterflySection.tsx` — hook stays. Only ClaudesRead's import removed.
- `AlphaPlaceholderSection` only used by `Alpha.tsx` (the 4 placeholder calls). Component deletion safe.
- Grep cross-check post-edit: zero remaining `AlphaPlaceholderSection` references in `src/`.

**End-state on /alpha:**
- Top strip · TapeReader Arc · Claude's Read (latest commentary + semantic recall) · News Causality Matrix · Footer rationale.
- 4 surfaces total — surgical, dense per glance.
- Specialists off-page; placeholders off-page.
- When iter #X ships its surface (Flow Butterfly multi-day arc, Heatmap alpha-class, Curated tape, Long-dated OI momentum), the surface lands in its temporal-layer position; no placeholder needed to have existed beforehand.

**Discipline gates run:**
- Engine-room write-time checklist: state-vs-intent ✓, no calendar anchors, cross-catalog parity N/A (UI-only), substrate verified (no schema touch), page-multiplication ✓ (this REMOVES surfaces, doesn't add).
- Single-purpose: PR is ONLY the surface compression. No Tenet 26 substrate touch (`ct_specialist_reads` untouched per the gate captain set).
- `npm run build`: clean.

**Files touched:** 4 — 2 component edits, 1 component deletion, 1 iteration log entry.

**5x bar:** post-iter-#2.6 the surface measures denser per glance; placeholder removal compresses vertical. Iter #5 fills the long-horizon position when long-dated OI substrate ships.

**PR:** #102 (single-purpose, no auto-merge — captain validates visually post-deploy on /alpha).

**Next:** captain validates compressed /alpha live. If captain disagrees with either decision after seeing the live result, iter #2.7 reverts the specific call. Decisions locked per current vision-state but not irreversible.

---

## 2026-05-09 evening — top-nav: /alpha exposed in Trade dropdown

**What changed:** `src/components/nav/TopNav.tsx` — added `{ path: '/alpha', label: 'Alpha' }` to the `Trade` group's items array, positioned right after `Tape v2`. Single-line addition. Mobile nav inherits via shared `NAV_GROUPS` constant.

**Why:** Iter #2.6 captain validation post-Vercel-deploy needs nav access; previously `/alpha` was direct-URL-only. Position (b) from brief — iter progression `Tape → Tape v2 → Alpha` reads as the natural surface evolution.

**End-state:** `/alpha` reachable from Trade dropdown in desktop NavBar + mobile Sheet menu. No other surface modifications.

**Discipline:**
- Single-purpose: ONE entry added, no other dropdowns or routes touched.
- Page consolidation question (/alpha vs /tape-v2 vs /tape) still captain's call — exposing /alpha doesn't commit to consolidation; consolidation pick later.
- page-multiplication-violates-no-silos compliant — adds a route to an already-rendered dropdown, doesn't ship a new surface.

**PR:** #103 (single-purpose).

---

## 2026-05-09 — Alpha v2 iter #3 PR-A: GEX Inference brain organ (substrate compute layer)

**What changed:** New brain organ `_shared/gexInferenceContext.ts` (the 13th — slots in alongside `flow_butterfly` as the 12th and `regime` as the 11th). `HelperName` union extended with `'gex_inference'`. Helper wired into BOTH helper arrays in `_shared/claudeReadSurface.ts` (slim + standard variants), mirroring the `flow_butterfly` precedent.

**Output shape (structured-numeric — no narrative):** Per-ticker × most-recent-snapshot — `gamma_flip_strike` (signed-interpolated zero crossing), `call_wall_strike`, `put_floor_strike`, `dealer_net_direction` (`positive_gamma | negative_gamma | flat`), `dealer_net_total`, `price_vs_flip` (`above | below | at` with 0.1% ε), top-3 `pin_attractor_strikes` by `abs(net_gex)`, `atm_strike_count`. Watchlist aggregate — `consensus_direction` (`broad_positive_gamma | broad_negative_gamma | mixed | no_signal`, ≥7-of-10 = broad), above/below/at-flip counts, `median_price_vs_flip_pct`. Always non-throwing, defensive-empty on error per ContextHelper contract.

**Source:** Reads `ct_gex_timeseries` directly (filtered `is_atm_band=true`, ordered by `strike` ascending, scoped to most-recent `snapshot_at` per ticker within 72h lookback). Two roundtrips per ticker × 10 tickers = ~20 round-trips when uncached; `cacheTtlSeconds: 60`. Helper-side compute, no new RPC — payload is small (~30 strikes/ticker × 10 tickers × ~8 numeric fields, well under 50KB) and the indexed `(ticker, snapshot_at DESC)` path makes per-ticker latency cheap. Out-of-scope per brief — DID NOT touch the 5 inline-inference edge functions (`ct-ticker-snapshot-builder`, `ct-hypothesis-proposer`, `ct-custom-rule-eval`, `ct-regime-watch`, `ct-eod-report`); their refactor onto this organ is iter #3.5.

**Audience:** `['cotrader', 'analyst', 'agent_internal']` — paper_claude stays isolated per the firewall contract (D3), same scope as `flow_butterfly` and `flow_heatmap`.

**Brief-author state-vs-intent fire (cascade #37 family):** Brief named the substrate as `ct_gex_snapshots` from memory; Phase A grep against `supabase/migrations/` caught the rename — the table was DROPPED via migration `20260417000001_drop_ct_gex_snapshots.sql` and the live substrate is `ct_gex_timeseries` (created in `20260416000010_ct_gex_timeseries.sql`). Brief author recovered before any code was written — Check 4 of `engine-room-write-time-checklist.md` (substrate-target verification) operationalized correctly. No code shipped against the dropped name.

**Why:** Captain-locked Path (iii) substrate compute layer. PR-B (`/heatmap` redesign) and PR-C (`/alpha` snapshot composition card) consume this surface. Per Tenet 24 (no silos) — every Co-Trader Claude-facing read should pull GEX inference from the same organ rather than each consumer reimplementing the strike-ladder math against `ct_gex_timeseries` with its own thresholds and edge cases.

**Discipline:**
- Single-purpose: ONLY the new helper + `HelperName` extension + `buildClaudeContext` wiring + this iteration log entry. No caller refactors. No UI work. No new RPC. No new migration (so no migration-timestamp collision risk).
- `deno check supabase/functions/_shared/gexInferenceContext.ts` clean. `claudeReadSurface.ts` retains its two pre-existing baseline errors (lines 1063 + `configCache.ts:62`) — neither introduced by this PR; verified via `git stash` baseline diff.
- Backward-compat: organs map is sparse `Partial<Record<HelperName, ...>>` — existing consumers that don't request `gex_inference` see no payload change. Consumers that opt-in via `organs: ['gex_inference', ...]` or `'all'` get the new organ.
- audience-gated → paper_claude unaffected.

**Cross-catalog parity flag for captain:** This entry generalizes a back-anchorability instance (cascade #29 in `docs/methodology-patterns.md`) — `ct_gex_timeseries` is append-only and the live substrate; no consumer should be reaching for the dropped `ct_gex_snapshots` overwrite-shape table. The 5 inline-inference edge functions all already read `ct_gex_timeseries` correctly per `grep ct_gex_timeseries supabase/functions/`. Iter #3.5 (caller refactor) is the right place to centralize the kernel logic; this PR ships the kernel.

**PR / commit:** PR-A in iter #3 stack. PR-B (`/heatmap` redesign) and PR-C (`/alpha` snapshot composition) follow. Captain reviews — no auto-merge.

---

## 2026-05-09 — Alpha v2 iter #3 PR-C: GEX Snapshot Card on /alpha (medium-temporal-layer surface)

**What changed:** New component `src/components/alpha/GexSnapshotCard.tsx` mounted on `/alpha` between `<ClaudesRead />` (synthesis layer) and `<NewsCausalityMatrix />` (information-rate layer) — the medium-temporal-layer position per the three-layer architecture comment in `Alpha.tsx`. New hook `src/hooks/useGexInference.ts`. New edge-function transport `supabase/functions/ct-gex-inference/index.ts` — thin wrapper around the `gex_inference` brain organ kernel (`_shared/gexInferenceContext.ts`, PR #104) so the strike-ladder math lives ONCE and every UI consumer pulls from the same source.

**Visual shape (terminal-class density, mirrors NewsCausalityMatrix identity bar):**
- **Header strip** — Crosshair icon + "GEX SNAPSHOT · DEALER POSITIONING" label, market-wide consensus_direction badge (BROAD POSITIVE GAMMA emerald / BROAD NEGATIVE GAMMA red / MIXED amber / NO SIGNAL muted), N tickers above flip / N below flip, generated_at relative timestamp.
- **Per-ticker grid** — one row per watchlist ticker in canonical order (NVDA, AAPL, MSFT, GOOGL, AMZN, META, TSLA, QQQ, SPY, IWM): ticker (font-bold mono) · dealer net direction badge (+γ / −γ / flat with color) · spot price · direction arrow ↑/↓/− vs flip · γ flip strike · call wall (dimmed when >3% from spot) · put floor (dimmed when >3% from spot). Click row → `/heatmap?ticker={t}` (PR-B mounts the depth view; query param is the agreed hand-off).
- **Footer** — populated/total count + organ_status when not `populated` + "+γ = mean reversion · −γ = momentum amplifier" legend + "Open /heatmap →" link.

**Data path (single source per Tenet 24 — NO SILOS):**
- Frontend hook `useGexInference` invokes `ct-gex-inference` edge function via `supabase.functions.invoke`.
- Edge function instantiates a service-role Supabase client and calls `getGexInferenceContext` from the brain organ — that's the kernel from PR #104. Returns the organ's structured-numeric output unchanged.
- **Why edge function over direct table reads:** the inference math (gamma flip linear interpolation, dealer-net-flat threshold, ATM-band filter, watchlist-aggregate consensus rule) all lives in `_shared/gexInferenceContext.ts`. Reaching for `ct_gex_timeseries` directly from a hook would re-implement that math in a third place (organ + edge fn + hook = drift surface). The edge wrapper costs one extra round-trip; the math discipline is worth it. Mirrors `useGexRadar` precedent — the page-edge-function pattern is already established for GEX surfaces. PR-B should consume the same hook OR re-invoke the same edge function so `/alpha` and `/heatmap` share the data path.
- Refetch cadence: 60s during RTH (matches the 60s `cacheTtlSeconds` on the organ), paused outside RTH.

**Coordination with PR-B:** PR-B (`/heatmap` alpha-class redesign, parallel agent) — recommended consumption pattern is `useGexInference()` directly when the depth view needs the same per-ticker inference. If PR-B picks a different path (e.g., a custom hook reading the organ via a different transport), captain can consolidate iter #3.5. Both ship against the same kernel either way.

**Why:** Captain-glance dealer-positioning state across the full watchlist in <5 seconds, mounted in the medium-temporal-layer position the brief calls out. The 5x-better-than-/tape bar — `/tape` and `/tape-v2` had no GEX strip; this surface compresses 10 tickers' worth of dealer positioning into one card-glance, the direct visual analog of an institutional desk's dealer-net board.

**Discipline:**
- Single-purpose: PR is ONLY the `GexSnapshotCard` component + `useGexInference` hook + `ct-gex-inference` edge function + `Alpha.tsx` mount + this iteration log entry. No `/heatmap` edits, no edits to `ClaudesRead` / `NewsCausalityMatrix` / `TapeReaderArc` / `AlphaTopStrip`, no Tenet 26 substrate touch (`ct_specialist_reads` / `specialistRecallContext` untouched), no edits to the 5 inline-inference edge functions (iter #3.5 scope).
- `npm run build`: clean. `tsc --noEmit`: clean. `deno check supabase/functions/ct-gex-inference/index.ts`: clean.
- Engine-room write-time checklist:
  1. State-vs-intent — composes existing organ rather than asserting new substrate.
  2. No calendar anchors on forward work.
  3. Cross-catalog parity — Cowork-side iter #3 stack tracks the same PR-A/B/C structure; this PR is PR-C.
  4. Substrate-target verification — kernel reads `ct_gex_timeseries` (verified live in PR #104, this PR doesn't touch substrate).
  5. Page-multiplication — adds ONE card to the existing `/alpha` route; doesn't ship a new page.

**Iteration log conflict expected** when PR-B and PR-C land in either order — both append to this file. Resolvable via rebase-and-keep-both per the chain pattern.

**5x bar:** `/tape` and `/tape-v2` have no compressed GEX board; the closest precedent is `/edge` showing one-ticker-at-a-time. This surface puts 10 tickers' dealer positioning + flip direction + walls in one grid the captain reads at a glance. Direct visual analog of an institutional dealer-net dashboard, deployed for one trader.

**PR / commit:** PR-C in iter #3 stack. Captain validates visually post-Vercel deploy on `/alpha` — no auto-merge.
