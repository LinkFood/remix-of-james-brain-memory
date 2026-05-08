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

**PR / commit:** TBD on push

---
