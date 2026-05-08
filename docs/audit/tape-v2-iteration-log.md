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

**PR / commit:** TBD on push

---
