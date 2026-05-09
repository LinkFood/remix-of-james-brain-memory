# Tape V2 Alpha Surface — Audit & Design Doc

**Date:** 2026-05-09
**Scope:** Diagnose-only design doc for a NEW route (separate from `/tape` and `/tape-v2`, which both stay as v1-class surfaces). The leading-indicator surgical-grade flow diagnostic where the system's intelligence becomes visible to captain. NO CODE SHIPS FROM THIS BRIEF.
**Pairs with:** Cowork CLAUDE.md 5/8 evening v2 alpha-surface reframe + the iteration log at `docs/audit/tape-v2-iteration-log.md` for the v1-class /tape-v2 work.

---

## TL;DR

**Doable.** All four alpha surfaces have substrate today. Layout is dense-Bloomberg-class achievable with existing components + 3-4 new ones.

**One critical structural blocker:** v2's "system flags me, I don't visualize" architecture **depends on Phase 2 emission triggers shipping first**. PR #63 shipped Phase 1 (kernel + `hot_contract` trigger only). 9 emission triggers are gaps; 3 of them (specialist_flag_fired, specialist_conviction_shift, news_flow_causality) **block v2 launch** — without them, v2 has to render signals that should push.

**One structural opportunity surfaced:** the **embedding layer is alive but load-bearing recall is chronological, not semantic**. Captain's quote in the brief — "THE CAPTAIN EMBEDS EVERYTHING ... AND likely the most underutilized substrate" — is empirically validated. 838 embedded rows in `ct_embeddings`, 100% coverage on critical tables, but specialist_recall organ pulls last-N-by-timestamp (not most-similar-by-vector). Tape commentary not embedded at write time. Activating semantic recall on the three v2 surfaces is **1-PR (tape) + multi-PR (butterfly, heatmap)** of structural lift.

**Recommended route name:** `/alpha` (engine-room recommendation; captain decides in section 10).

**Recommended ship sequence:** three-stage. (1) Phase 2 emission triggers (unblocks page minimization), (2) v2 page composition with the 4 alpha surfaces, (3) semantic recall activation post-C1 measurement window close (5/15+).

---

## A1 — Claude's Reads Pipeline Inventory

Engine-room mapped 7 active Claude-reading pipelines plus 2 long-form digests. Every one writes structured output with as_of metadata; most are Bundle Phase 2 organMetadata-complete. Only 2 of the 7 currently surface visually anywhere on the site.

| Pipeline | Edge fn | Cron | Output table | Model | Bundle Phase 2? | Visual surface today |
|---|---|---|---|---|---|---|
| Tape narrative | `ct-tape-reader` | 10m RTH + flag-interrupt | `ct_tape_commentary` | Haiku | ✓ | `/tape`, `/tape-reader`, `/tape-v2` (TapeReaderArc, iter #1) |
| News severity/sentiment | `ct-news-sweep` | 30m RTH | `ct_breaking_news` (source='tavily_sweep') | Haiku | ✓ | `/breaking-news`, daily brief |
| Per-ticker specialist (×10) | `ct-specialist-{T}` | 15m RTH + event | `ct_specialist_reads` + `ct_flags` | Sonnet 4 | ✓ | `/edge` ticker cards |
| Flag grader | `ct-flag-grader` | 30m 24/7 | `ct_specialist_grade_axes` | (pure logic) | — | `/scoreboard`, flag detail |
| EOD narrative | `ct-eod-summary` | 20:30 UTC weekday | `ct_eod_summaries` | Sonnet 4 | ✓ | `/eod` + Slack |
| Daily brief | `ct-daily-brief` | 7am ET + re-brief | `ct_daily_briefs` | Sonnet 4 | ✓ | `/daily-brief` + Slack + chat context |
| JAC morning brief | `jac-morning-brief` | 8am ET | `brain_insights` (type=morning_brief) | Haiku | partial | `/brain` + Slack |

**Three observations that shape v2:**

1. **The "Claude's reads" surface captain wants on v2 is not a new producer** — it's a render-layer composition over `ct_specialist_reads` + `ct_tape_commentary` + `ct_eod_summaries` + `ct_daily_briefs`. Every read already exists; v2 just composes them.
2. **Specialist reads (10× per 15min) carry per-ticker conviction + direction_lean + 2-3 sentence read_text**. This is the densest leading-indicator surface available. Per-ticker tile with this content + the brain organ's `next_close_signal` heuristic from PR #78 is the v2 read-tile primitive.
3. **organMetadata is populated** on every read. The "as_of" framing captain wants is already there — surface-time staleness reads correctly out of the box.

---

## A2 — Flow Butterfly Historical-Pattern Surface

**Substrate:** `ct_butterfly_cross_events` table (PR #79/#80, append-only corpus), `flow_butterfly` brain organ (PR #78, per-ticker + watchlist state with empirical heuristic), `ct-butterfly-grader` (forward-window outcomes settled twice daily), `get_butterfly_hit_rates` RPC for hit-rate cube. First corpus rows land Mon 5/11 13:35 UTC; first graded outcomes Mon 5/11 20:30 UTC.

**Three visual shapes engine-room proposes:**

### Shape A — Cross magnitude rollup chart (multi-day arc)
- **What:** Per-ticker cross magnitude arc — Y-axis = signed gap dollars at each cross, X-axis = trading days (last 5d / 10d / 30d), point colored by tertile (s/m/L). Faint phase shading (open/midday/PM/close) per day.
- **Source:** `SELECT ticker, cross_at, gap_dollars, magnitude_tertile, session_phase FROM ct_butterfly_cross_events WHERE session_date >= today - N`
- **Why it's the alpha:** Captures "positioning building across the recent window" — the medium-term temporal layer. Captain reads "TSLA has been firing more large bullish midday crosses each session" at-a-glance.
- **Effort:** S. New hook (~50 LOC) + new component (~200 LOC).

### Shape B — Watchlist consensus rollup
- **What:** 10-row × N-day grid — each cell = consensus state at end of that day (`strong_bull`/`strong_bear`/`mixed`/`no_signal` per `flow_butterfly.watchlist.consensus`). Colored cell, count subscript.
- **Source:** Compose from `ct_butterfly_cross_events` rolled up per-day per-ticker, plus the brain organ's consensus calculation per day.
- **Why it's the alpha:** "Day-level coherence is high. 5-9 of 10 tickers usually agree on EOD direction" per PR #64 § A.8. Captain sees regime continuity at a glance — when consensus flips, the row colors flip.
- **Effort:** S-M. Need a `get_butterfly_watchlist_history` RPC or per-day rollup.

### Shape C — Per-ticker hit-rate trend (post-grader-corpus)
- **What:** Per-ticker line chart — Y-axis = NextClose hit-rate over rolling 30d, X-axis = days. Reference line at 50%. Points colored by tertile.
- **Source:** `get_butterfly_hit_rates(p_since=today-30, p_ticker=X)` per ticker, daily refresh.
- **Why it's the alpha:** Catches **drift** — "NVDA's mid-bull cell was 71% historical, last 5d it's 40% — something changed." Powers the warden hit_rate_drift invariant captain queued for Phase 4.
- **Effort:** XS. RPC exists; just chart it.
- **Caveat:** Needs ≥30d of corpus to be meaningful. First useful read: ~6/10/2026.

**Engine-room recommendation:** Ship **Shape A + Shape B as v2 launch composition** (Shape C joins after corpus matures). A handles the medium-horizon "pattern accumulation" layer; B handles the consensus coherence read. Together they solve "Flow Butterfly day-by-day historical pattern tracking" the brief calls out.

**Critical fix coming with this:** the existing `/tape-v2` Flow Butterfly section is structurally crammed (per Chrome MCP audit captain dropped earlier — ALL view too small, sparse-window placeholder, label overlap). v2 page gives Flow Butterfly **dedicated full-canvas real estate** instead of cramming it as a section.

---

## A3 — Heatmap Alpha-Class Treatment

**Substrate:** `/heatmap` page exists at `src/pages/Heatmap.tsx` with 5 math modes (`total`, `net_signed`, `aggressive_directional_raw`, `aggressive_directional_decay`, `voi_unusual`), per-ticker drill, baseline mode, multi-mode-agreement detector. **Underutilized:** baseline comparison is off by default; per-ticker view caps at top-20 strikes; multi-mode agreement marker exists but unsurfaced.

**Critical gap surfaced by Phase A:** the heatmap is **broken for long-dated visibility**. `maxExpiryDays` defaults to 365 (12-month window) but `lookbackHours` defaults to 168 (7-day scan). A NVDA Jun 2026 cell renders EMPTY because the flow that built that position happened weeks/months ago and aged out of the 7d scan window. **The positioning is in `ct_oi_snapshots` and `ct_contract_tracks` but invisible to the heatmap.**

**Two redesign shapes:**

### Shape D — Alpha-class heatmap (intraday/weekly, current data path)
- **What:** Same grid mechanics, but with:
  - Baseline-comparison ON by default (color encodes Δ-vs-baseline, not absolute magnitude)
  - Strike-side dominant direction badge per cell (bull/bear chip overlay)
  - Drill panel surfaces per-alert conviction score + T+1 OI confirmation status + multi-mode agreement
  - Multi-mode consensus marker visible (2-of-3 / 3-of-3 directional alignment)
- **Why it's the alpha:** captures the captain's "where positioning is staging" read for near-term (intraday) and weekly (next-Friday) horizons.
- **Effort:** M. Refactor of current Heatmap controls + drill.

### Shape E — Long-dated OI momentum heatmap (NEW data path)
- **What:** 10 tickers × 12 month buckets (Jan/Feb/.../Dec out to +12mo). Cell value = (1-month OI change % for that bucket). Color encodes momentum direction (building → emerald, leaking → rose).
- **Source needed:** `ct_oi_monthly_baselines` (NEW nightly rollup of P25/P50/P75 OI per ticker × month-of-expiry); `oi_delta_30d` extension to existing OI snapshot logic.
- **Why it's the alpha:** the **long-term temporal layer** — surfaces "where institutions are positioned 6-12 months out" the brief explicitly calls out. The MU 400C Jun 2026 question: when MU/equivalent shows up on the watchlist, this surface reveals whether the position has been building or leaking.
- **Effort:** M-L. Needs new aggregation table + nightly cron + new RPC. Not blocking v2 launch — **ship as Shape A+B-then-Shape-D-then-Shape-E sequence**.

**Engine-room recommendation:** v2 launches with **Shape D (alpha-class current-data heatmap)**. **Shape E (long-dated OI momentum) is the third temporal layer** the brief locks in — ship in a follow-up after corpus + retention design lock (see A6).

**Side benefit:** Shape D informs a future standalone `/heatmap` page redesign separate from v2 composition — same component reuses.

---

## A4 — Filtered Live Tape Source Data Path

**Question:** what backs "flagged/stacked contracts only" tape — not the firehose?

**Substrate audit findings:**

- **`ct_flags`** carries `source_flow_ids` (bigint[]) joinable to `ct_scored_flow.id` via array contains check. **Composition possible but ad-hoc** — every consumer rebuilds the join.
- **`ct_contract_tracks`** has `track_status='WORKING'` for actively-tracked contracts. Filterable.
- **`ct_scored_flow`** with `score >= 70 AND premium >= $250k` filter approximates "notable contracts."
- **`jac_emissions` (PR #63)** has `hot_contract` trigger that fires `signal` (score≥80, premium≥$250k, ~1.9 events/day) and `alert` (score≥80, premium≥$500k, ~1.0 event/day) tiers. **Currently emits to Slack only** — not surfaced anywhere on site.
- **`ct_tape_commentary.flag_ids`** + `flow_ids` already record which specific events the tape-reader narrated.

**No single canonical "filtered tape" table exists today.** Each consumer composes filters at query time.

**Engine-room recommendation:** **NEW materialized RPC `get_v2_curated_tape(p_window_min)`** that:
1. Pulls latest `ct_scored_flow` rows in window
2. Joins to `ct_flags.source_flow_ids` for "is this flagged?" status
3. Joins to `ct_contract_tracks` for "what's the peak P&L on this contract today?" (post-grader)
4. Joins to `ct_specialist_reads` for "is any specialist's `read_text` mentioning this contract right now?"
5. Returns 10-30 rows ordered by composite signal score (flag conviction × premium × stacking)
6. Bundle Phase 2 organMetadata wrapped

**Effort:** S. Single RPC + per-tick frontend hook. Use the same `hot_contract` emission criterion as the floor; surface the tier (signal/alert) as a column.

**Why not just consume `jac_emissions.hot_contract` rows directly?** Emissions are dedup'd over 60min — they're the captain's Slack push surface, not a real-time tape feed. v2 needs both: (a) the curated tape rows for the live-render surface, (b) the Slack push for "I'm away from screen" — same underlying detection, different consumption.

---

## A5 — Long-Term Positioning Depth Surface

Already covered in A3 Shape E (OI momentum heatmap). Reiterating the structural points:

- **Tables that hold long-dated positioning:**
  - `ct_oi_snapshots` — 3×/day snapshots, indefinite retention, year-back queryable
  - `ct_contract_tracks` — lifetime ledger per contract (entry → expiry+1d), indefinite retention
  - `ct_flow_alerts` — raw firehose, possibly aged out by UW budget after N days

- **MU 400C Jun 2026 use case:** `ct_contract_tracks` shows price evolution but NOT the **ongoing accumulation sequence**. A contract showing peak_pct=500% on day 60 of 180-day track looks identical whether it was a 1-day pump or a 60-day monotonic climb with 3 follow-on alert accumulations.

- **Visualization shapes ranked:**
  1. **Shape E (OI momentum heatmap)** — reveals "where institutions are positioned + whether positioning is BUILDING or LEAKING" at watchlist scale. Recommended for v2.
  2. **Per-ticker OI strip chart** (top-20 strikes by lifetime max OI) — single-ticker drill into "magnet" strikes. Sequenceable as v2 follow-up.
  3. **Contract accumulation scatter** (entry_days × peak_pct, colored by ticker/expiry-bucket) — high information density but needs interactivity. Defer.

**Feasibility: HIGH** for Shape E. All necessary data exists. ~400 LOC SQL + 3-4 RPCs to support.

---

## A6 — Data Retention Reality + Recommendation

**Findings:**

- **Only 2 tables have explicit TTL deletion:** `ct_price_ticks` (7-day rolling, migration `20260420000026`) and `brain_insights` (expires_at-driven, daily 2am UTC).
- **Everything else: keep-forever.** Including `ct_flow_alerts`, `ct_scored_flow`, `ct_specialist_reads`, `ct_tape_commentary`, `ct_oi_snapshots`, `ct_contract_tracks`, `ct_butterfly_cross_events`, `entries`, `jac_reflections`.
- **3 highest-volume tables (ct_flow_alerts, ct_scored_flow, ct_specialist_reads)** project to:
  - 30 days: ~900GB combined
  - 6 months: ~1.8TB
  - 12 months: ~3.6TB

**Constraint check on long-term positioning visibility:**
- `ct_oi_snapshots` (indefinite, 3×/day) → can reconstruct OI state any date back to launch (2026-04-23). **Sufficient** for Shape E OI momentum heatmap with current retention.
- `ct_contract_tracks` (indefinite, lifecycle = entry → expiry+1d) → preserves lifetime contract evolution. **Sufficient** for MU-400C-Jun-2026-style queries.
- `ct_flow_alerts` (currently keep-forever; UW budget bounded) → raw flow can age out under budget pressure. The alpha-class long-dated reads don't depend on raw flow — they depend on snapshots + tracks. **No constraint.**

**Recommended canonical retention pattern (formalize):**
- **Raw prints** (ct_flow_alerts, ct_dark_pool_prints, ct_price_ticks) → 7-14 day rolling. Cheap to delete, expensive to replay multi-year.
- **Scored / structured** (ct_scored_flow, ct_specialist_reads, ct_tape_commentary) → keep forever. Cost of storage << value of multi-year pattern library.
- **Graded outcomes** (ct_butterfly_cross_events, ct_flag_grades, ct_specialist_grade_axes) → keep forever. Empirical corpus.
- **Daily aggregates** (ct_daily_briefs, ct_eod_reports, ct_oi_monthly_baselines if/when created) → keep forever. Narrative audit trail + summarization.

**Action item (separate ship, not blocking v2):** Apply explicit pg_cron retention policies to `ct_flow_alerts`, `ct_dark_pool_prints` (14-day rolling). Document in `docs/runbooks/retention-policy.md`.

---

## A7 — Embedding Layer Utilization (THE big finding)

**This is where the audit surfaces the largest structural opportunity.**

### Current state — embedding infrastructure is alive

Voyage 512-dim embeddings, `ct_embeddings` polymorphic table holding **838 rows** (462 observations + 267 news + 52 flags + 34 alerts + 16 reports + 7 lessons). Plus `voyage-3-lite` integration on `entries` (JAC side, 1024-dim post-migration) + `jac_reflections` + `jac_principles`.

| Table | Embedding column | Coverage | Write path | Semantic-recall consumer at decision time |
|---|---|---|---|---|
| `ct_observations` | 100% | Write-time hook | NOT USED — pulled chronologically only |
| `ct_specialist_memory` | 2 rows, dead | (defunct writer) | Never invoked |
| `ct_regime_history` | 100% | `ct-regime-capture` | `regimeContext.ts` calls `search_ct_regime_analogs` — **0 invocations / 7d** |
| `ct_session_embeddings` | 1 row sparse | `ct-session-analog` | `analogsContext.ts` calls `search_ct_session_analogs` — **440 calls / 7d, 0 successes** |
| `ct_embeddings` | 838 rows | `generate-embedding` | `ct_similar_items` RPC — used only by `memoryRecall.getSimilarPastSetups` |
| `entries` (JAC) | ~3k+ | backfill cron + write-time | `search_entries_by_embedding` — actively used |
| `jac_reflections` | 1k+ | `jac-reflect` on task | `distill-principles` weekly use |
| `jac_principles` | sparse | weekly distill | `jac-dispatcher` context injection |

### The load-bearing finding

**Specialist recall is chronological, not semantic.** Per `_shared/specialistRecallContext.ts:293-312`:
```
.order('updated_at', { ascending: false }).limit(5)
```

That's "last 5 reads by timestamp" — NOT "5 most-similar reads by embedding vector." The C1 hit-rate measurement window (through 2026-05-15) is measuring **filter-by-time behavior**, not semantic-similarity behavior.

**Per the Cowork glossary "C1 interpretation caveat":** *"Whatever C1 shows, the semantic version is a separate experiment that hasn't been run yet."*

### v2's three alpha surfaces × semantic recall — activation map

| Surface | What semantic recall would ADD | Current state | Activation effort |
|---|---|---|---|
| **Flow Butterfly cross fires** | "Show 5 most-similar historical crosses across watchlist + their forward returns at 1d / 3d / NextClose" | `ct_butterfly_cross_events` has NO embedding column | **Multi-PR**: embedding column + `get_similar_butterfly_crosses` RPC + organ |
| **Heatmap GEX positioning** | "Show historical positioning structures most similar to this — what played out next?" | `ct_gex_snapshots` (or equivalent) has no embedding; positioning is state-rich (strike ladder + OI distribution) | **Multi-PR + design**: representation decision is hard (what gets embedded — strike ladder vector? premium concentration profile?), then RPC + organ |
| **Claude's tape read produces commentary** | "Show most-similar historical tape reads — what tended to follow them?" | `memoryRecall.getSimilarPastSetups` exists + uses `ct_similar_items` RPC. But `ct_tape_commentary.commentary` is **NOT embedded at write time** | **1-PR ship**: add embedding write to `ct-tape-reader` + test in existing `memoryRecall` query |

### Engine-room recommendation

**Three-tier semantic activation sequencing:**

1. **NOW (1-PR ship, post-C1 window 5/15+):** Wire `ct-tape-reader` to embed each commentary at write time. Hook `memoryRecall.getSimilarPastSetups` to query similar tape reads. v2's "Claude's reads" surface gains semantic recall — captain hovers a tape read, sees "5 most-similar historical reads + their NextClose outcomes." Lowest cost, highest immediate alpha lift.

2. **MEDIUM-TERM (multi-PR after corpus matures, ~6/10):** Add embedding column to `ct_butterfly_cross_events`. Embed the cross signature (gap_dollars + magnitude_tertile + session_phase + ticker_role + recent flow context). Build `get_similar_butterfly_crosses(p_event_id, p_limit=5)` RPC. Wire into `flow_butterfly` brain organ as a new field.

3. **LONG-TERM (separate scoping doc, kernel-side):** Heatmap GEX positioning embedding requires representation decision (strike ladder × DTE × OI-distribution → vector?). This is a JAC-core kernel feature — vendor-agnostic positioning vector representation that any application could use. Flag for the JAC-core Phase 2 vendor-abstraction layer roadmap.

**Cross-cutting fix:** Post-C1, transition `specialist_recall` from chronological → semantic. Replaces the load-bearing C1 measurement baseline with measurement-of-semantic-recall (C2 experiment per Cowork glossary post-C1 queue).

---

## A8 — Composition / Layout Feasibility

**Constraints:**
- Surgical-grade institutional-flow-diagnostic identity (Bloomberg-terminal class)
- Three temporal layers stacked (near + medium + long horizon)
- Push-not-render for non-alphas (specialists, full news panel, Flow Pulse, Stacking → off page)
- Full canvas for the 4 surfaces; no cramming

**Two layout shapes engine-room proposes:**

### Layout 1 — "Stacked Diagnostic" (recommended)

```
┌─────────────────────────────────────────────────────────────────────┐
│  [Top strip: VIX · regime pill · consensus chip · breaking-news ticker · Slack-push-count] │
├─────────────────────────────────────────────────────────────────────┤
│  CLAUDE'S READ — full-width                                         │
│  Latest tape commentary + recent specialist reads (top 3 by         │
│  conviction shift) + most-similar historical reads (semantic)       │
│  As-of stamp, tertile chip per cited cross                          │
├──────────────────────────────────────┬──────────────────────────────┤
│  FLOW BUTTERFLY (medium-term)        │  HEATMAP (near-term)          │
│  Shape A: cross magnitude arc per    │  Shape D: alpha-class current │
│  ticker × last 5d. Shape B watchlist │  intraday/weekly heatmap with │
│  consensus rollup row above.         │  baseline-Δ default + drill   │
├──────────────────────────────────────┼──────────────────────────────┤
│  LONG-DATED POSITIONING (long-term)  │  CURATED TAPE (live filtered) │
│  Shape E: 10 tickers × 12 month      │  get_v2_curated_tape stream:  │
│  buckets, OI momentum colored        │  flagged/stacked contracts    │
│  (build/leak)                        │  only, ranked by composite    │
│                                      │  signal score                 │
└──────────────────────────────────────┴──────────────────────────────┘
```

**Why this works:**
- Three temporal layers visibly stacked top-to-bottom (Claude's read = synthesis, Butterfly + Heatmap = medium/near, OI momentum + curated tape = long + live)
- Captain scans top-to-bottom: read first (the synthesis), then check the surfaces feeding it, then drill long-dated for context
- Each surface has full half-canvas (no cramming)
- Push-not-render: every individual specialist read is OFF the page; specialist signal arrives via Slack emission. Page renders aggregate consensus chip in the top strip.

### Layout 2 — "Reads-Centric" (alternative)

```
┌─────────────────────────────────────────────────────────────────────┐
│  Top strip (same)                                                   │
├──────────────────────────────────────┬──────────────────────────────┤
│  CLAUDE'S READ                       │  CURATED TAPE                 │
│  (~60% width)                        │  (~40% width)                 │
│  Tape commentary + specialist reads  │  Live filtered to flagged     │
│  + semantic recall hover panel       │  contracts only               │
│                                      │                               │
├──────────────────────────────────────┼──────────────────────────────┤
│  FLOW BUTTERFLY                      │  HEATMAP                      │
│  Shape A + B                         │  Shape D                      │
├──────────────────────────────────────┴──────────────────────────────┤
│  LONG-DATED POSITIONING — full-width OI momentum heatmap            │
└─────────────────────────────────────────────────────────────────────┘
```

**Why alternative:** puts Claude's read alongside the live curated tape — captain sees the read AND the live flow that's feeding it side-by-side. Trade-off: less vertical real estate for the long-dated layer.

**Engine-room recommendation: Layout 1.** Three temporal layers stacked is the load-bearing identity per the brief. Layout 2 reads more like a single-temporal-layer dashboard.

**Mobile responsive:** below `lg` breakpoint, layout collapses to single column. Surgical-grade is desktop-first by design.

---

## A9 — Push-Not-Render Emission Gap Analysis

**Phase 1 (PR #63) shipped:** kernel infrastructure (`jac_emission_triggers`, `jac_emissions`, `compose_emission`, `emit`, `jac-emission-detector` cron) + 1 trigger (`hot_contract`).

**9 emission triggers gap-analyzed.** Three of them BLOCK v2 launch (without them, v2 has to render signals captain explicitly said push, don't visualize):

| # | Trigger | Status | Detection | Composition | Effort | v2 BLOCKER? | Ship priority |
|---|---|---|---|---|---|---|---|
| 1 | `specialist_flag_fired_v2` | gap | LOW (query `ct_flags` score+gating) | MED (cotrader_specialist_flag_fired_v1 template) | 1.5h | **YES** — without this, AlarmBanner stays on page | 1 |
| 2 | `specialist_conviction_shift` | gap | LOW (LAG over `ct_specialist_reads.conviction`) | MED | 1h | **YES** — without this, specialist widgets stay on page | 2 |
| 3 | `news_flow_causality` | gap | MED (correlate `ct_breaking_news` + `ct_scored_flow` by ticker + 60min) | HIGH | 1.5h | **YES** — without this, news panel stays on page | 3 |
| 4 | `regime_transition` | gap | LOW (LAG over `ct_regime_classifications`) | MED | 0.75h | no — top-strip regime pill captures this | 4 |
| 5 | `heatmap_breakout` | gap | MED (cell ≥ Nσ above baseline) | MED | 1h | no — Shape D heatmap captures this visually | 5 |
| 6 | `butterfly_cross` (large + midday) | gap | MED (cross-fire detect from cron) | HIGH (regime-alignment + analog) | 2h | no — Shape A captures this visually | 6 |
| 7 | `tape_interrupt` | gap | LOW (`trigger_kind='flag_interrupt'`) | LOW (restate commentary) | 0.5h | no | 7 |
| 8 | `first_daily_cross_leader` | gap | MED (state table per ticker per day) | MED | 1.5h | no | 8 |
| 9 | `consensus_flip` | gap | MED (count tickers per direction) | MED | 1h | no — top-strip consensus chip captures this | 9 |

**Phase 2 unblocking bundle (engine-room recommendation):**
**Ship triggers #1 + #2 + #3 as a single coherent emission Phase 2 PR before v2 launch.** ~4-5 hours combined work. Once the three Slack pushes fire reliably, AlarmBanner / specialist widgets / News panel all become deletable from v2 page.

**Phase 3 nice-to-haves (#4-#9):** queue post-v2-launch. None block.

**Two architectural callouts:**
- **Specialist v1 vs v2 gating** (per CO_TRADER_V2_SCOPE): v1 = score≥80, v2 = hit-rate ≥ 55% AND conviction ≥ 4. Push gating logic INTO the detection RPC (via `detection_params` JSONB), not at emit-time. Avoids wasting Sonnet tokens composing flags that won't send.
- **AlarmBanner pattern is already a dual-render** (renders banner AND `signature_alarm` may push to Slack). Verify current behavior, replace with emission trigger-only after Phase 2 ships.

---

## A10 — Route + Naming

**Existing route convention:** `/tape`, `/tape-v2`, `/flags`, `/heatmap`, `/butterflies`, `/edge`, `/specialists`, `/alarms`, `/eod`, `/eod-report`, `/morning-brief`, `/pulse`, `/patterns`, `/cost`, `/budget`, `/health`, `/crons`, `/agents`.

**Captain's framing:** surgical-grade institutional flow diagnostic where the system's intelligence becomes visible.

**Engine-room candidates (ranked):**

1. **`/alpha`** ← engine-room recommendation
   - One word, captures identity (alpha = leading-indicator signal)
   - Doesn't reuse "tape" branding (clear separation from v1-class /tape and /tape-v2)
   - Names what the page IS, not what it composes

2. **`/command`**
   - Captures "captain at the command station"
   - But: less specific to the alpha/leading-indicator framing
   - Could conflict with future "command center" framing for other pages

3. **`/diagnostic`**
   - Captures "surgical-grade diagnostic" identity precisely
   - But: feels more clinical than alpha-trading
   - Doesn't communicate forward-looking nature

4. **`/tape-v3`**
   - Sequential progression from v1/v2
   - But: the brief explicitly reframed v2 as "different job entirely" — naming as -v3 muddles the structural reframe

**Engine-room recommendation: `/alpha`.** Captain locks in section 10.

---

## Phase B Ship Plan Outline

**Three-stage ship sequence:**

### Stage 1 — Emission Phase 2 (BLOCKS v2 launch)
- Migration: `20260512_emission_phase_2_specialist_news_triggers.sql`
- 3 detection RPCs: `detect_specialist_flags_v2`, `detect_specialist_conviction_shifts`, `detect_news_flow_correlation`
- 3 composition templates: `cotrader_specialist_flag_fired_v1`, `cotrader_specialist_conviction_shift_v1`, `cotrader_news_flow_causality_v1`
- 3 trigger registry inserts
- ~4-5h work, single PR
- **Validation:** captain observes 3-5d, tunes thresholds via `detection_params` UPDATEs
- **Output:** AlarmBanner / specialist widgets / News panel become deletable

### Stage 2 — v2 page composition (after Stage 1 validates)
- New route `/alpha` in `src/App.tsx`
- New page `src/pages/Alpha.tsx`
- New components in `src/components/alpha/`:
  - `ClaudesRead.tsx` (top section — tape + specialist conviction + recent semantic-recall)
  - `FlowButterflyArc.tsx` (Shape A — multi-day cross magnitude)
  - `WatchlistConsensusRow.tsx` (Shape B)
  - `AlphaHeatmap.tsx` (Shape D — alpha-class current heatmap)
  - `CuratedTapeStream.tsx` (curated filtered tape)
  - `OiMomentumHeatmap.tsx` placeholder (Shape E — empty state until Stage 3 substrate ships)
- New RPC: `get_v2_curated_tape(p_window_min)`
- New hook: `useCuratedTape`
- Layout: Layout 1 (Stacked Diagnostic)
- ~2-3 days work, single PR or small stack
- **Hidden from nav initially**, captain validates via direct URL

### Stage 3 — Long-dated + semantic recall (post-corpus + post-C1)
- Migration: `ct_oi_monthly_baselines` table + nightly rollup cron + `oi_delta_30d` RPC extension
- Wire `OiMomentumHeatmap` to live data
- Wire `ct-tape-reader` to embed commentary at write time + activate semantic recall query in `ClaudesRead`
- Multi-PR sequence post-C1 window close (5/15+)
- Specialist recall transition chronological → semantic post-C1 (separate ship in `_shared/specialistRecallContext.ts`)

### Total v2 substrate substrate-debt pre-ship checklist
- [ ] Stage 1 emission Phase 2 shipped + captain-validated
- [ ] Flow Butterfly corpus ≥ 1 week of grader passes (~5/18+)
- [ ] `get_v2_curated_tape` RPC tested
- [ ] Captain locks decisions in section 10 below

---

## Open Questions Requiring Captain Decision

| # | Question | Engine-room recommendation | Why captain decides |
|---|---|---|---|
| 1 | Route name | `/alpha` | Captain owns naming convention |
| 2 | Phase 2 emission triggers — wait for them, or ship v2 with placeholder reads while triggers cook? | Wait. v2 launching with rendered AlarmBanner contradicts the "system tells me, I don't visualize" architecture. | Architectural identity decision |
| 3 | Long-dated retention — keep current keep-forever (3.6TB at 12mo) or formalize the recommended pattern (raw 7-14d rolling, scored/structured forever)? | Formalize. Apply explicit pg_cron retention to raw flow tables. Separate ship from v2. | Cost/operational tradeoff |
| 4 | Semantic recall scope for v2 launch — just tape commentary embedding (1-PR), or also butterfly + heatmap (multi-PR each)? | Tape commentary only at v2 launch. Butterfly semantic activates once corpus has 30+ days. Heatmap GEX is JAC-core kernel work — separate scoping doc. | Scope vs ship-velocity tradeoff |
| 5 | Long-dated OI momentum heatmap (Shape E) — ship at v2 launch or sequence after? | Sequence after. Shape E needs new aggregation table + nightly cron + new RPC. Shape A + B + D + Curated Tape + Claude's Read is enough for v2 launch; Shape E joins as Stage 3. | Scope vs first-impression tradeoff |
| 6 | If captain wants to KEEP one of the "off-page" elements (e.g., Pulse mini-strip), is that OK? | Captain's call. Engine-room's strict reading: nothing on the page that should push instead. But a 1-line top-strip regime pill compresses Pulse to glance-only. | Brief interpretation |
| 7 | Specialist recall chronological → semantic transition — wait for C1 window to close (5/15) or run as parallel experiment? | Wait. C1 measurement is in flight; switching mid-window contaminates the experiment. Plan transition as C2 experiment post-5/15 with explicit before/after measurement. | Empirical-discipline call |

---

## Catalog Candidates Surfaced During Audit

Engine-room captured 3 cascade catalog candidates worth memorizing post-design-doc-merge:

1. **`render-mode-creep-when-push-doesnt-exist-yet`** — sub-class of `dual-rendering-when-emission-gap-blocks-removal`. Pattern: a UI element renders signal X. The architectural intent is "X should push, not render." But the push trigger doesn't exist, so the UI keeps rendering. Future captures: every time a "page minimization" effort hits a "but where will the user see this?" moment, check if the corresponding emission trigger exists.

2. **`embedding-stored-recall-chronological`** — load-bearing recall reads timestamps despite vectors being embedded at write-time. Specialist recall lines 293-312 is the canonical instance. Future captures: any query against an embedded table that uses `.order('updated_at')` instead of `embedding <=>` is a candidate for semantic-lift refactor.

3. **`heatmap-window-mismatch-with-display-range`** — `maxExpiryDays=365` displays 12 months of cells but `lookbackHours=168` only scans last 7 days for flow. Long-dated cells render empty because the flow that built them aged out of scan window. Pattern: any visualization with display-range > scan-range should explicitly source from snapshot-tables (state) not flow-tables (events).

---

## Recommendation

**Doable** as a 3-stage ship sequence. Engine-room recommends:
- Captain locks the 7 open questions above
- Stage 1 (Phase 2 emission triggers) ships next, ~4-5h, blocks v2 launch
- Stage 2 (v2 page composition at `/alpha`) ships after captain validates Phase 2, ~2-3 days
- Stage 3 (long-dated + semantic recall) ships post-corpus-mature + post-C1-close, multi-PR sequence

**Why this sequence:** the brief's "system tells me, I don't visualize" architecture is the load-bearing constraint. Without Phase 2 emission triggers, v2 page can't shrink to its surgical-grade form — it'd render the very signals that should push. Captain's separate decision: whether to wait for Phase 2 (engine-room recommendation) or accept v2 launching with placeholder reads.

**The audit surfaced one structural moat opportunity** the brief explicitly anticipated: embeddings exist but aren't queried semantically at decision time. Activating semantic recall on the three v2 surfaces (tape 1-PR, butterfly multi-PR, heatmap kernel-work) compounds the alpha advantage exponentially over time.

---

## Cross-references

- `docs/audit/tape-v2-iteration-log.md` — append-only log for v1-class /tape-v2 iterations (PRs #73-#82)
- `docs/audits/flow-butterfly-empirical-design-pass.md` — PR #64 empirical baseline
- `docs/audit/2026-05-08-tape-v2-feasibility-scoping.md` — PR #71 feasibility audit for v1-class /tape-v2
- Cowork CLAUDE.md — strategic memory + 5/8 evening v2 alpha-surface reframe
- Cowork `memory/discipline-brief-author-intent-over-state.md` — discipline this audit followed
- Cowork `memory/glossary.md` post-C1 queue + C1 interpretation caveat

---

**End of audit + design doc. Captain reviews, locks decisions, separate ship brief follows for Stage 1 emission Phase 2.**
