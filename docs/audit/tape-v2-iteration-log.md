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

**PR / commit:** TBD on push

