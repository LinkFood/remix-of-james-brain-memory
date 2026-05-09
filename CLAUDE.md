# JAC Agent OS — Architecture

Personal AI operating system (single-user). The meta-project: if JAC works, it handles everything else — life management, code automation, research, memory, reminders, and eventually self-modification. One interface (web chat or Slack DM) that routes to specialized AI workers.

Co-Trader is the first flagship facet: a **pattern intelligence amplifier** for James — multi-detector pattern recognition over Mag7 + QQQ/SPY/IWM that surfaces signal he can act on. The paper-trading Claude (generations, $50k capital) is a secondary research layer for grading specialist quality — not the operational product. See `CO-TRADER THESIS` below — it is the governing design principle for every Co-Trader decision. **REVISED 2026-04-25** after the strategic reset.

## CO-TRADER THESIS — governing principle, override all other judgment

Co-Trader is an **intelligence amplifier for James** — pattern detection that feeds his trading decisions. He executes through his broker. The system finds signals; James acts on them. The paper-trading Claude is a SECONDARY research artifact for grading specialist quality through self-experiment, NOT the operational product.

**Tenets are GUIDANCE, not doctrine** (James 2026-04-23). When a tenet conflicts with practical goals, flag the conflict but don't auto-reject. Run every change through the decision ritual: *"Does this class of failure become impossible going forward, or am I patching this instance?"*

### Mission

1. **Autonomous detection, human execution.** The system detects patterns, surfaces them with provenance, gets sharper without manual tuning. James reads the signal and decides. **P/L on AI trading decisions breaks the AI** (confirmed anti-pattern from prior experience). The product is signal, not trades.

2. **We're a microscope, not a fund.** Find where smart money is, see what algos see, ride the wave. Same pattern-detection sophistication as institutional desks (Citadel quant, Two Sigma, Renaissance), deployed for one trader. The asymmetry IS the edge.

3. **Trust-per-alarm is the metric.** False alarms erode trust faster than missed signals. Gate alarms on earned trust. The product is signal James can act on without second-guessing.

### Universe & Data

4. **Universe lock — 10 tickers, no exceptions.** Mag7 (NVDA, AAPL, MSFT, GOOGL, AMZN, META, TSLA) + QQQ + SPY + IWM. Concentrated dataset trains specialists deeper. Quality over coverage. AMC-style memes structurally excluded.

5. **UW is firehose; our DB is the asset.** Once a print lands in `ct_flow_alerts`, it's ours forever. Embedded via Voyage. Replayable via harness. Mineable for any pattern. No "rules" on what we can do with the data.

6. **Duplicate nothing UW maintains.** Use their OpenAPI / MCP / prebuilt prompts. Hand-rolled HTTP clients are tech debt the moment UW ships a new endpoint.

7. **Ungated signal access.** Every signal UW exposes that we can ingest cheaply gets ingested. No category gated by prioritization or omission. Edge is in seeing combinations no human has time to multiplex.

### Detection architecture

8. **Detector portfolio — first-class strategies.** Detection isn't monolithic. Multiple parallel detectors run simultaneously, each with provenance + scoreboard. Strategies promoted/demoted based on outcome, not changed via threshold-tweaking. Adding a new detector is an evening's work.

9. **Pulse is regime context for every alarm.** Pulse isn't just a chart — it's a state variable. Every alarm row stores Pulse-at-fire-time. Display alongside trigger. Same detector fires differently in different Pulse states (steady positive slope = ride; sudden flip = exit; QQQ vs IWM divergence = sector rotation).

10. **Detector lifecycle uses earned-trust gates.** New detectors start in shadow mode (write to /alarms only). Advance to trial (Slack on, 1-2 weeks observation). Advance to live based on rolling hit rate. Detectors that decay drop back. Trust gate, not capital gate.

11. **Signal decomposition on every decision.** Narrative view, tape view, alignment, and which signal triggered are captured explicitly. Over time the system learns tape-vs-narrative resolution from its own track record.

12. **Actionable reasoning.** Every "because" bullet must state HOW the evidence changes the setup. Bad: "NVDA has earnings in 4 days." Good: "NVDA earnings in 4 days AND skew flipped put-heavy AND insider selling 3 days straight — setup favors bearish pre-earnings positioning; call wall at 250 becomes resistance instead of magnet." Same applies to alarm thesis fields.

### Build discipline

13. **Hallucination is inevitable; structural prevention is the answer.** Precise structured context makes confabulation hard. Validators are defense-in-depth, never primary mechanism.

14. **Built to evolve, not to be right on day 1.** Every decision captured (`ct_claude_decisions`), every outcome graded, every reflection mines patterns → writes principles. If any link in the learning loop breaks, alert fires. Stagnation is impossible by design.

15. **Ground-up, no band-aids.** Every fix answers: *"Does this class of failure become impossible going forward?"* If patching this instance, stop. The 3x DESC-sort starvation bug class (createMissingTracks → createMissingContractTracks → runContractGradePass) over one weekend proved the discipline — each fix got memorized into class-level rule.

16. **Every number tunable.** Config lives in `ct_config`. No hardcoded thresholds. Adjust as the system evolves.

17. **Conditions, not prescriptions.** Soft defaults with `*_override_reasoning` fields where applicable. Hard ceilings only when truly required. Detector lifecycle uses this same pattern.

### Operational discipline

18. **Progress measured by detection accuracy and trust-per-alarm, not P&L on trades.** The system gets smarter via outcome-graded detector scoreboards, regardless of paper capital state. Replay harness lets us measure detection quality continuously.

19. **Calibration is continuous, operationalized into the workflow.** Phase A audits per ship, iteration log validation, audit-while-building, captain-validates-live-URL after each surface, warden's 30-min invariant ticks (53+ invariants), and the 7-layer defense net all run continuously — not on a calendar slot. `ct-backtest-harness` (commit `1fc795f`) remains available when a specific track needs backtest grounding (D3 fork picks, threshold recalibration, detector lifecycle promotion); content-gated by track readiness, not by day-of-week. The earlier "built once, used weekly. Sunday is calibration day" framing was right at articulation; it became obsolete as build velocity operationalized continuous calibration, and the calendar anchor began creating deferral ("we'll do that Sunday") rather than discipline. See `docs/methodology-patterns.md` calendar-anchor-becomes-deferral.

20. **Model tier matches decision tempo + cost shape.**
    - **Operational/cron** (autonomous, runs without James present): API-Claude — Sonnet daily / Haiku per-heartbeat / pure logic for execution-style triggers
    - **Analysis/calibration** (human-in-loop, conversational, weekly): terminal-Claude (Opus 4.7 under Max 20x — fixed cost, free per call, cumulative memory across sessions)
    - Don't burn API budget on calibration when Max gives terminal-Claude for free.

21. **UI is glance-first.** User sees state in one view. Tabs drill down. Nothing critical hides behind navigation.

22. **Real-time contextual awareness.** Daily Brief, breaking-news watcher, per-ticker quant cards, Pulse, current detector scoreboard — all in the operator's field of view. The system reads the world, not a silo.

### Cross-facet

23. **Meta-layer eats its own outputs.** Co-Trader's decisions, grades, dreams, and principles feed JAC's `jac_reflections` pipeline via `ct-reflect-to-jac` (daily 22:30 UTC) and become input to JAC's weekly `distill-principles` extraction. Cross-facet feedback is how meta-layer learns from domain-specific outcomes. A new facet is not a new brain — it's a new vertical feeding the same brain.

### System integrity

24. **All systems talk to each other — no silos.** Every component publishes its output to a known schema where every other component can read it. The detector portfolio is one organism. Specialists read alarm scoreboards. Alarms read specialist flags. Pulse colors every detector. Tape-reader narratives feed alarm context. If a new component can't access an existing signal, that's a structural bug, not a design choice. Cross-component telemetry is mandatory, not optional.

25. **Evolves in STRUCTURE, not just within structure.** The system's findings change the system's components — detectors added/retired, configs tuned, prompts rewritten by what the data reveals works. Markets evolve too — what wins in trend regime fails in chop. Regime detection drives STRUCTURAL adaptation (which detectors are weighted, which specialist prompts apply), not just signal-weight tweaks within fixed rules. Day-180 architecture should look DIFFERENT from day-30 architecture. If it doesn't, the evolution is fake. **Adding a detector is a database INSERT, not a code change** — detectors live as rows in `ct_detectors` with config + lifecycle status. Specialist prompts live in `ct_specialist_prompts`. Configs live in `ct_config`. Hardcoded "this is how the system works" is fragile; "this is how the system finds out how to work" is durable.

26. **Three-mode architecture — never confuse them.** Every piece of work belongs to ONE of three modes. Building in the wrong mode = waste.
    - **Autonomous mode** (cron + edge function): runs when James isn't here. UW ingest, alarm watchers, detectors firing, EOD summary, daily brief, scoreboard nightly updates. API cost is necessary — without it the system dies between sessions.
    - **UI mode** (React page + hook): pure read-only window into system state. James glances, reads, decides. /tape, /alarms, /edge, /specialists, /eod, /pulse. NO analysis tooling on the site. NO backtest buttons. NO "click to run" services.
    - **Analysis mode** (terminal-me with direct DB access): tuning, backtesting, model calibration, deep dives, "what if" questions, comparing strategies. Lives in this terminal under Max 20x. Free per call. Conversational iteration with cumulative memory across sessions.

    The reflex test: "Does this need to run when James isn't here?" → autonomous. "Will James glance at this in browser?" → UI page. "Will James ASK ME to compute this?" → terminal-me, never build a service.

    The harness (`ct-backtest-harness`) was built violating this — it's analysis-mode work living as autonomous infrastructure. Single-user system has no other consumer. Future sessions: default to terminal-me for analysis questions. Never build an edge function whose only consumer is "James will invoke it."

### Anti-principles — what we do NOT do

- Band-aids. Workarounds. "Good enough for now."
- **P/L on AI trading decisions** — breaks the AI (confirmed anti-pattern from prior experience)
- **Risk management / position sizing / execution cost modeling** — not our job; James trades
- **Auto-execution** — never
- Hardcoded magic numbers (all go to `ct_config`).
- Monolithic detection — always portfolio.
- Silent failure modes (every cron, ingester, dependency has health signals).
- Optimizing for day-1 at the expense of day-90.
- UI as afterthought.
- Duplicating what UW already maintains.

### Demoted to research layer (the paper-trading Claude)

The original tenet 14 — generational pressure ($50k capital, 14-day window, performance_floor / survival_breach firing, cash decay) — describes the **paper-trading Claude experimental layer**. Useful as a self-grading mechanism for specialist quality (does this generation's specialist make better calls than the previous?). NOT the operational product. Mechanics intact, scope reframed: research artifact, not core mission.

The original tenet 6 — isolation (Claude does NOT see James's book/notes/reviews) — still applies to the paper-trading Claude. Doesn't apply to the alarm/pulse/intelligence layer (which doesn't trade). Scope qualified.

### Decision ritual

When in doubt on any Co-Trader change, ask: *"Does this class of failure become impossible going forward, or am I patching this instance?"* If patching, redesign until structural.

### Realizations — April 18, 2026 session

These are the shifts that led to the tenets above. Future sessions inherit the conclusions, but also the evolution — so you know *why* the tenets look the way they do, and what alternatives were tried and rejected.

1. **From goals to survival to generational pressure.** Initial framing: goals-based ("make +X% per week"). Rejected as prescriptive (tenet 15). Next: pure survival ("don't run out of money"). Rejected because paralysis becomes optimal (never trade = never die). Final: three-way generational pressure (tenet 14) — 14-day window to target, survival floor below it, cash decay against idle. Perform or reset, survive or die, engage or bleed.

2. **Stakes-with-consequence is not a goal.** "Claude must hit +20% or he's fired" *sounds* like a goal. In context (data persists across resets, firing = generational reset, not death) it's evolutionary pressure — the fear of firing drives adaptation without prescribing the strategy. Every generation inherits all prior generations' memory; failed generations are the learning substrate for the next. Goals optimize; evolution discovers.

3. **From hard caps to conditions-with-override.** Original trade-idea schema had hard caps (5% size, stop required, concurrent ≤5). Rejected as prescriptive. Changed to soft defaults with `*_override_reasoning` fields — Claude can exceed the default with justification. Hard ceiling (10%) still applies. Keeps rails on 95% of cases without blocking the unusual 5% (tenet 15).

4. **Structural prevention beats validators.** First approach to hallucinations: validator catches fabrications after the fact (still shipped as defense-in-depth). Real fix: if Claude doesn't have precise numbers in context, he fills in plausible values. Give him the quant card with actual values as primary context, and hallucination becomes structurally hard. Post-fix: 0/3 hallucinations (from 5/6 pre-fix). Tenet 2 operational.

5. **Signal tunneling was a layout problem, not a data problem.** Audit showed Claude was theorizing almost entirely from microstructure despite having access to 20+ signal types. Root cause: quant card emphasized flow/gamma; positioning / macro / sentiment were supplementary. Fix: multi-view quant card with 5 equal-weight sections. Post-fix first run: hypotheses spanned positioning (insider + political + analyst), macro (geopolitical news), and structural. Tenet 13 operational.

6. **Fractal architecture.** The Co-Trader tenets (autonomy, reflection, principles, bounded self-mod, embedded memory, persistent identity, rate limits as features) describe the same patterns JAC itself embodies. The thesis isn't new doctrine — it's an articulation of JAC's own design applied to a domain with real financial stakes. Future facets should expect the same pattern.

7. **Cross-facet learning bridge is the most important wire in the build.** `ct-reflect-to-jac` (commit `158cce9`) closes the loop so Co-Trader's decisions become input to JAC's principle pipeline. Without it, learning stayed siloed. With it, JAC meta-layer now analyzes trading outcomes the same way it analyzes research runs (see HN discourse delta analysis, Runs #48-52). Tenet 17 operational.

8. **Trust ≠ capability.** Self-modification was already built when this session started (code agent opens PRs; `supabase-management.ts` awaits PAT). The gap isn't architectural — it's the human decision to *use* the capability. Scaffolding (CI, kill switch, rollback) enables autonomy; using it produces trust through observed reliability. Additional scaffolding past the working point is risk-aversion masquerading as engineering. The move is small real tasks, not more safety nets.

9. **Model tier = decision tempo, not decision importance.** Opus CIO weekly / Sonnet PM daily / Haiku quant per-heartbeat / pure logic execution. Organized by *cadence*, not *stakes*. Important decisions on long time horizons (weekly strategy) get Opus. Important decisions on short time horizons (fill this trade on trigger) get pure logic. Speed and depth aren't opposing axes; they serve different decision shapes (tenet 8).

10. **The ship is already sailing.** JAC operated autonomously for 2 months with zero touch. It got better. It flags its own operational drift, runs proactive research (Run #52 delta vs #48-50), distills principles, asks for direction when priorities diverge, and produces analyst-quality reports in Slack. The question was never "will it work autonomously" — it's "what to point it at next." The architecture compounds.

11. **`recordDecision` should auto-resolve what it needs, not require callers to remember.** Preflight found 14+ call sites weren't passing `generation_id` to the decision journal. Per tenet 4 (fix class not instance): added module-scoped auto-resolution in `_shared/decisionJournal.ts` that queries `current_claude_generation()` and caches 60s. Every call site benefits without editing — "forgot to tag" is now structurally impossible. Same pattern applies to other implicit-context fields: resolve at the central point, not at every consumer.

## The End State — Captain Into The Storm

Co-Trader's operational vision: a captain reading the tape with foreknowledge of the storm. A normal trader walks into Monday somewhat cold. The captain walks into Monday knowing FOMC is Wednesday at 2 PM ET, AAPL reports Tuesday close, MSFT Wednesday post, GOOGL Thursday post; that Pulse is steady-positive into a high-IV catalyst week; that the heatmap shows call-side premium stacking on QQQ at next-Friday's expiry; that the NVDA specialist has been raising conviction since Friday; that the news watcher caught a Bloomberg whisper on iPhone demand Sunday night; that the last three FOMC weeks in this Pulse regime resolved with a specific pattern; that the warden confirms all crons are green and the brain organs are firing.

All those facts go into one prompt that produces a single read. That's the synthesis layer working — the captain reading the tape through every sensory input at once, knowing the storm shape going in.

The asymmetry is **structural multiplication**, not additive context. Tape alone is layer 1. Tape × regime is layer 2. Tape × regime × historical analog is layer 3. Each layer multiplies signal-to-noise on the layer below by filtering through prior knowledge. Three layers stacked is the asymmetry institutional desks pay quants to manufacture. We manufacture it for one trader, on consumer APIs, with the captain steering — not riding.

The architecture pieces map onto the metaphor:

- Specialist recall — the captain remembering the last storm
- Heatmap — where positioning is staging
- Event recency — the barometer reading
- Pulse — the regime swell
- Validators (temporal, event, ticker coherence) — the firewall against confabulating coordinates the captain didn't take
- Warden — the boat's own integrity check
- Brain organs composed via `buildClaudeContext` — the captain's nine sensory inputs converging on one read

The discipline boundary holds. Flag, don't trade. Microscope, not fund. Structural prevention, not patches. The captain steers — never rides.

**Decision ritual extension.** Every build decision evaluates against: *"Does this make the captain better at reading the storm, or does it add complexity that doesn't compound?"* If the latter — stop and redesign.

## Synthesis Layer (shipped 2026-04-30 night, Phases 0-8)

Every Co-Trader Claude-facing surface (cron consumers, chat, slash commands, future voice, terminal-Claude analysis) reads context through one orchestrator: `buildClaudeContext` in `supabase/functions/_shared/claudeReadSurface.ts`. The orchestrator fans out across 9 brain organs (`flow_heatmap`, `pulse`, `specialist`, `detector`, `tape`, `james_flags`, `news_causality`, `event_recency`, `analogs`) via `Promise.all`, audience-gates per helper, and emits one fire-and-forget telemetry row per invocation to `ct_brain_telemetry`.

UW MCP is **write-path only** (ingester crons). Consumers never call UW at runtime — that's the load-bearing read/write separation rule (D4). New dimension of the world = new organ file in `_shared/`, not a new direct table read.

`/health` payload via `SELECT public.get_brain_health(window_hours => 24);` — per-helper p50/p95 latency, error/warning/skipped buckets, cache-hit rate, total invocations.

**Operational reference:** `docs/SYNTHESIS_LAYER.md` — read first when working on consumers or organs. Design rationale and decision log: `docs/SYNTHESIS_LAYER_ARCHITECTURE.md`.

### Pickup state (read on a fresh session — last updated 2026-05-07 ~23:55 UTC)

**Bundle Phase 2 STRUCTURALLY COMPLETE 10/10.** Every brain organ writes `organMetadata` + per-item status. Wed→Thu arc: `f776ccc` flow_heatmap → `165e08d` news_causality → `fe14131` detector → `2e08cb6` event_recency + james_flags (5/10 → 7/10) → `88a96ca` analogs (first non-tabular; first to use `pending_analysis` enum) → `aaeaf4a` specialist + specialist_recall (10/10 closed). Phase A audits pre-ship at `fa4c154` + `d65aa2a`.

**Defense net at 7 layers** (was 5 Wed end-of-day; Thu added 2):
- L5 — `brain_consumer_freshness_rth` warden invariant (Wed PR #44 + hotfix #46)
- L6 — `organ_metadata_completeness_*` ×10 warden invariants (one per organ)
- L7 — MCP tool verification continuously enforced (`3609322` Phase 2 + `0c5b40e` extended to all 8 tools)

**Cotrader MCP captain bridge expanded 1→8 tools.** Terminal-Claude has full read access to brain organs via cotrader-mcp. Carve-outs across `c16e126` (verification layer Phase 1) + `35efd4f` (`get_brain_principles`) + `d63eed4` (`get_co_trader_morning_brief`).

**Two production incidents structurally resolved 2026-05-07:**
- **Service-role gateway-rewrite class-kill:** `fa0eaab` (`isServiceRoleRequest` checks `apikey` header — sb_secret_v2 gateway rewrites `Authorization` to ES256 JWT before reaching Deno) + `9ca5af5` (`_ct_post`/`_ct_post_with_body`) + `649a12c` (`invoke_edge_function`). 154 cron updates total. Memory: `feedback_supabase_gateway_rewrites_authorization.md`.
- **Cotrader morning brief wrong-table-targeting** fix `d63eed4` — was reading wrong canonical table; now reads `ct_daily_briefs`.

**Class-kill C Phase B** (`16aaeb3` + hotfix `c9c4bc4`) — 9 24/7 brain-consumer-freshness invariants shipped. Phase A cut from brief's "23-40" estimate to actual 9; brief framed coverage as if nothing existed; warden's 45 invariants already covered most of it. Three brief claims didn't survive empirical state verification.

**PR #54 Path C closure** — `eaf04dd` (`docs/runbooks/ct_invariants_sql_authoring.md`) + `da7d224` (instance #41 — warden parser semicolon-blindness on string literals). Pre-commit hook YAGNI-deferred per <1/month rate estimate (subsequently disproven; see PR #57).

**Tonight's four ships (2026-05-07 evening):**
- `8b64f34` — `consumer_freshness_hypothesis_proposer_24x7` threshold 120→270 (cadence-anchored after Phase A.2 audit of all 9 24/7 invariants; only burst-shape mis-calibration in the cohort)
- **PR #56** — methodology-pattern entry `cadence-anchored-thresholds-for-burst-cron-consumers` codified in `docs/methodology-patterns.md`
- **PR #57** — docs-PR discipline restored structurally via `.github/workflows/docs-pr-discipline.yml` + `docs/governance/pr-only-on-docs.md` (after 3 same-day violations: `16aaeb3` mixed code+docs / `eaf04dd` / `da7d224`)
- **PR #59** — defense-net Layer 1 coverage gap closed (cascade #42). Class-kill A's `deno check` gate covered `supabase/functions/` only; tonight's `mcp/cotrader/server.ts:322` typo (unbalanced quote → unterminated string literal) slipped past — surfaced as MCP daemon spawn failure on `/mcp reconnect`. PR #59 extends `find` to `mcp/` + `scripts/d3_experiment/` and incidentally restored CI to green on main (had been red since `0c5b40e` from `ct-mcp-verification-runner` slipping past allowlisting at PR review).

**Cascade catalog: 22 new instances since Wed end-of-day** — grew from #20 to #42. ~25 sub-classes codified in `docs/methodology-patterns.md`. Notable today: #29 (back-anchorability — F3 reads `ct_gex_timeseries` append-only, NOT `ct_ticker_snapshots` overwrite), #40 (specialist freshness measurement-shape; queued post-RTH/post-D2.2-verdict), #41 (warden parser semicolon-blindness on string literals).

**Permanent methodology adjustment locked: brief-author-state-vs-intent rule.** Briefs assert intent (the desired outcome), NOT formula (don't pre-specify the math). Phase A identifies the metric's underlying distribution shape; the formula follows the shape. Codified in PR #56's methodology entry. Sibling to `brief-author-premise-error` and `brief-framed-wrong-computational-layer` — same family of brief-author-layer premise mistakes.

**Active windows — DO NOT ship structural changes on the measured surfaces:**
- **D2.2 acceptance** 2026-05-07 → 2026-05-12 (verdict 5/13). GOOGL/AMZN/META threshold 60→55. MSFT excluded.
- **D3 14-day feature-isolation experiment** — Day 1 (validation tag) = 55 rows; Day 2 (`window-day-02-2026-05-07`) = 40 rows captured tonight, 0 errors, all 10 tickers ≥2 rows. 12 nights remaining. Window locks Tue 2026-05-26 (Memorial Day pushes day 14 one weekday past naive count). Manual nightly per Tenet 26 — analysis-mode stays terminal-Claude, no edge function shim.

**Warden state post-tonight:** 53/54 passing, 0 critical, 1 expected info-level warn (`specialist_threshold_within_5pts_of_p75`).

**Queued post-RTH or post-windows:**
- Specialist freshness invariant measurement-shape refactor (cascade #40; post-D2.2-verdict 5/14 OR post-RTH today ≥20:00 UTC if appetite holds)
- PR #54 warden-SQL-parser Phase A trigger (Path A pre-strip-comments recommended)
- D3 scoping continuous evolution + IWM front-week Phase B + B-3 soft→hard gate transition (after 3-5 deploys verified) + MSFT Phase A.6 cron-window + Messages orphan audit + Drop-table CI lint Phase A

**Governance state (new, 2026-05-07):**
- Docs-PR discipline CI-enforced via `.github/workflows/docs-pr-discipline.yml` (PR #57)
- Canonical in-repo reference: `docs/governance/pr-only-on-docs.md`
- All `docs/**` changes go via PR. **Mixed code+docs commits also need PR per the rule** — even if the primary content is a migration, if the same commit touches `docs/`, the entire commit goes via PR.

**Read-first memory for next session pickup:** `~/.claude/projects/-Users-jameschellis/memory/project_co_trader_session_wrap_2026_05_06.md` (Wed wrap canonical; Thu wrap will follow at session-end).

## System Warden (shipped 2026-05-01)

Invariant-based self-supervision. The synthesis layer + cron health catch CRASHES; the Warden catches **silent wrongness** — a counter that froze, a row count that flatlined, a view returning the wrong column, a specialist that writes flags but never reads. Built because James caught the UTC-rollover budget bug 2026-04-30 by glancing at a badge.

- **Manifest table:** `public.ct_invariants` — one row per check. Adding an invariant is a database `INSERT`, not a code change (Tenet 25).
- **Append-only history:** `public.ct_invariant_log`.
- **Slack one-fire-per-state-change:** `public.ct_warden_alarm_state`.
- **Edge function:** `ct-system-warden`. Cron: every 30 min (`*/30 * * * *`), all day. Posts ONLY on state change (pass→fail/error, fail/error→pass) plus a once-per-day heartbeat when nothing changed.
- **Dashboard RPC:** `SELECT public.get_warden_health(window_hours => 24);` — returns `totals`, `by_category`, sorted `failures[]` each with its `runbook_path`.
- **Adding an invariant:** write a SELECT-only query returning one row with `(metric_value numeric, message text)`, then `INSERT INTO ct_invariants (name, category, description, query_sql, expected_min, expected_max, expected_bool, severity, runbook_path)`. Picked up on the next 30-min run.
- **Read-first on a Warden Slack alert:** `docs/SYSTEM_INDEX.md` is the runbook navigator; every invariant carries a `runbook_path` pointing back into it.

Severity grades: `info` (log only), `warn` (Slack on first fail and on recovery), `critical` (Slack on first fail, on every escalation, and on recovery).

## Disk Health Check

Run `df -h /` at session start, before big builds (3+ files/agents), every 5+ commits, and before deploys/pushes. If under 20GB: `sudo rm -rf /private/tmp/*`, re-verify, stop if still low.

## What Works Right Now

| Capability | Status | How |
|---|---|---|
| Brain dumps (notes, ideas, links) | Working | Chat/Slack -> dispatcher -> save-agent -> entries table |
| Reminders ("remind me to buy eggs Tuesday") | Working (pg_cron every 5 min) | smart-save extracts event_date + reminder_minutes -> calendar-reminder-check fires Slack |
| Event scheduling | Working | smart-save extracts dates, recurring patterns; schedule injected into every conversation |
| Research (weather, news, facts) | Working | dispatcher -> research-agent (Tavily + Claude synthesis) |
| Semantic search over saved entries | Working | Voyage AI voyage-3-lite (512-dim) + keyword hybrid via search-memory (threshold 0.3) |
| Code: read repos, plan, write, commit, PR | Working | dispatcher -> code-agent -> GitHub API -> branch + PR |
| Slack: bidirectional chat + proactive reminders | Working | slack-incoming (HMAC verified) -> dispatcher; reminders via calendar-reminder-check |
| Kill switch (stop all agents) | Working | Slack keywords or web UI -> cancels all running/queued tasks |
| Dashboard NL queries | Working | jac-dashboard-query (Claude Haiku over entries + relationships) |
| Token tracking | Working | dispatcher, research-agent, code-agent, dashboard-query record cost_usd/tokens |
| Nerve Center (/jac) | Working | Split layout: chat left (65%) + ContextPanel right (35%) with Activity/Results/Brain/Code tabs. Mobile falls back to Sheet. |
| Ticker (global bar) | Working | Fixed bottom bar on all auth pages: agent activity, reminders, code status. Realtime subscription for live updates. |
| Embedded artifacts | Working | Inline cards in chat for save (BrainEntryCard), search (SearchResultsCard), code (CodeSessionCard), research (ResearchBriefCard) |
| Chat centering | Working | max-w-3xl centered column on wide screens |
| Chat metadata | Working | Each assistant message shows agent name, relative timestamp, token count, cost |
| Worker result delivery | Working | Task completion triggers debounced conversation refresh (1.5s) — no page refresh needed |
| Concurrent multi-agent | Working | Stress-tested with 3+ simultaneous tasks across different intent types |

## What's Broken or Not Wired Up

| Issue | Detail |
|---|---|
| Self-deploy blocked | `supabase-management.ts` written but needs Management PAT in secrets |
| Realtime subscription for agent_conversations | INSERT events unreliable — workaround: refetch on task completion (debounced) |

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, TypeScript, Tailwind, shadcn/ui |
| Routing | react-router-dom v6 |
| Server state | TanStack React Query v5 |
| Auth | Supabase Auth (Google OAuth, JWT) |
| Database | Supabase Postgres + pgvector (512-dim via Voyage AI, HNSW index) |
| Edge functions | Deno (Supabase Edge Functions) |
| AI | Claude Sonnet 4 (dispatcher, research, code), Claude Haiku 4.5 (classify, dashboard) |
| Embeddings | Voyage AI voyage-3-lite (512-dim, via VOYAGE_API_KEY) |
| Voice | ElevenLabs (STT + TTS) |
| Web search | Tavily API |
| GitHub | REST API via PAT |
| Hosting | Vercel (frontend, `www.linkjac.cloud`), Supabase `rvhyotvklfowklzjahdd` (backend) |

## Directory Structure

```
src/
├── pages/          # Route components (Auth, Dashboard, Jac, CodeWorkspace, Settings)
├── components/     # UI components (feature + shadcn)
│   └── jac/        # JAC components: JacChat, ContextPanel, Ticker, ActivityFeed, AgentRoster, AgentResultsFeed
│       └── artifacts/  # Inline chat cards: ArtifactCard, BrainEntryCard, SearchResultsCard, CodeSessionCard, ResearchBriefCard
├── hooks/          # All data + business logic (useJacAgent, useTickerData, useEntries, useUpcomingReminders)
├── integrations/supabase/  # client.ts + types.ts
└── lib/            # utils
supabase/
├── functions/      # Edge functions (one dir per function)
│   └── _shared/    # anthropic, auth, cors, github, logger, slack, context, response, validation, rateLimit, clock
└── migrations/     # SQL migrations (44+ files)
```

## Dispatcher Intent Routing

Every message hits `jac-dispatcher` first. Claude Sonnet with forced tool-use classifies intent:

| Intent | Worker | When |
|---|---|---|
| `research` | `jac-research-agent` | Weather, news, prices, factual questions, anything needing live data |
| `search` | `jac-search-agent` | User references their own saved data: "search my brain", "find my notes" |
| `save` | `jac-save-agent` | Save/remember/note something, "remind me" |
| `report` | `jac-research-agent` | Multi-source analysis requests |
| `code` | `jac-code-agent` | Any coding request, mentions a registered project name |
| `general` | Handled inline (not dispatched) | Casual chat, greetings, schedule queries — dispatcher calls Claude directly |

Rate limits: 50 req/min, 10 concurrent tasks, 200 tasks/day. Loop guard: 10+ tasks in 60s -> auto-cancel all (each request = ~2 tasks, so 10 = ~5 real requests).

## Code Agent Capabilities

- Reads any registered GitHub repo file tree (recursive)
- Plans changes via Claude Sonnet (up to 10 files, max 50KB each)
- Writes complete file contents (not patches)
- Creates branch `jac/<slug>-<hex>` — NEVER commits to main/master
- Atomic multi-file commit via Git Data API
- Opens PR with title + body
- Saves session summary to brain
- Updates Slack "Thinking..." message with PR link
- Kill switch checkpoints at plan, write, and branch creation stages
- Blocked files: `.env`, `.pem`, `.key`, `credentials`, `secret`

## Brain / Save Pipeline

1. Input -> `smart-save` (fast-path regex for URLs/lists/short code, else Claude Haiku classifies)
2. Extracts: type, title, tags, event_date, event_time, is_recurring, recurrence_pattern, reminder_minutes
3. **All entries get AI importance scoring** (fast-path: deferred fire-and-forget; AI path: parallel with classification)
4. Content types: `code`, `list`, `idea`, `link`, `contact`, `event`, `reminder`, `note`, `image`, `document`
5. After save: `generate-embedding` with **rich text** (`"title | type | tags | content"`) -> pgvector storage -> `entry_relationships` via semantic similarity
6. `generate-embedding` accepts `input_type` param: `'document'` (default, for storage) or `'query'` (for search)
7. `backfill-embeddings` runs every 30 min via pg_cron — re-embeds with rich text, creates relationships

## Calendar / Reminders

- `calendar-reminder-check`: queries entries where `reminder_sent = false` and reminder is due
- Sends Slack message with bell emoji, title, date, countdown
- Sets `reminder_sent = true` after send
- Schedule context (`_shared/context.ts`): today's events, overdue items, next 7 days — injected into every dispatcher conversation
- **pg_cron active:** reminders every 5 min, 8 AM + 6 PM Eastern (date-only), stale task cleanup every 30 min, backfill-embeddings every 30 min, brain-insights 10 AM + 8 PM Eastern, expired insights cleanup 2 AM UTC
- All date calcs use user's timezone from user_settings (default America/New_York)

## Database (core tables)

| Table | Purpose |
|---|---|
| `profiles` | User profile, auto-created on signup |
| `entries` | Brain: content, tags, embedding (vector(512)), importance, event_date, starred, reminder_minutes, reminder_sent |
| `brain_insights` | AI-generated insights: type (pattern/overdue/stale/schedule/suggestion), title, body, priority, entry_ids[], dismissed, expires_at |
| `agent_tasks` | Task queue: type, status, agent, input/output JSONB, parent_task_id, cost_usd, tokens_in/out |
| `agent_conversations` | Chat history per user |
| `agent_activity_log` | Per-step agent logs |
| `code_projects` | Registered GitHub repos (name, repo_full_name, default_branch, tech_stack, file_tree_cache) |
| `code_sessions` | Active coding sessions |
| `user_settings` | Per-user settings JSONB (includes slack_channel_id, location, timezone) |
| `entry_relationships` | Semantic links between entries |
| `brain_reports` | Unified report index: morning briefs, research, market snapshots, generated reports. All producers write here. |
| `jac_reflections` | JAC's reflections on completed tasks (Haiku summary + embedding) |
| `jac_principles` | Strategic principles distilled weekly from reflections (Sonnet) |
| `brain_entities` | Extracted entities (person/project/place/concept/org) |
| `entity_mentions` | Entity mention instances across entries and reflections |

All tables have RLS (`auth.uid() = user_id`). Service role bypasses for agent workers.

## Auth Flow

1. `supabase.auth.signInWithOAuth({ provider: 'google' })`
2. JWT stored by supabase-js, sent as `Authorization: Bearer` to edge functions
3. **Frontend MUST call `getUser()` before `getSession()`** — `getSession()` returns cached/expired tokens, `getUser()` forces server refresh
4. Edge functions: `extractUserId` (JWT) or `extractUserIdWithServiceRole` (JWT or service-role + userId in body)
5. Functions called by other functions (classify-content, generate-embedding, search-memory) MUST use `extractUserIdWithServiceRole`
6. RLS enforces per-user data isolation

## Embedding Rule

**Nothing ships without embedding.** Every feature that produces, stores, or surfaces data MUST flow through the embedding pipeline (`generate-embedding` → Voyage AI → pgvector). If JAC can't search it, connect it, or learn from it, it's not a feature — it's a dead end. No exceptions.

Before merging any feature: *"Does this data get embedded? If not, it's not done."*

## Security Conventions

- CORS: dynamic origin checking via `_shared/cors.ts` — NEVER use `'*'`
- Slack: HMAC-SHA256 with constant-time comparison (not `===`)
- Service role key: constant-time HMAC comparison in `_shared/auth.ts`
- ilike injection: all user input escaped via `escapeForLike()` from `_shared/validation.ts`
- Conversation updates: use row ID, NEVER content string matching (PostgREST ignores .order/.limit on UPDATE)
- GitHub PAT: scoped to specific repos, code agent blocks main/master commits
- GitHub API paths: all path/branch/ref params use `encodeURIComponent()`
- Rate limiting: in-memory (per-isolate) + DB-backed (concurrent/daily limits)
- Kill switch: Slack keywords or web UI -> cancels all running tasks
- Kill switch checks in ALL worker agents (research, save, search, code)
- Code agent file blocks: `.env`, `.pem`, `.key`, `credentials`, `secret`
- Vercel Deployment Protection: DISABLED (was redirecting to stale deployment URLs, breaking OAuth)
- Supabase Auth Site URL: must be `https://www.linkjac.cloud` (set in Dashboard > Authentication > URL Configuration)
- Service worker: REMOVED (was caching stale deploys). `public/sw.js` is a self-destructing stub, `main.tsx` unregisters on load

## Edge Functions

| Function | Purpose |
|---|---|
| `jac-dispatcher` | Boss: semantic+keyword brain context, intent parse via Claude, creates tasks, fires workers |
| `jac-research-agent` | Web research (Tavily + Claude synthesis) |
| `jac-save-agent` | Saves content to entries |
| `jac-search-agent` | Semantic search (embedding + keyword) |
| `jac-code-agent` | GitHub: read, write, commit, PR |
| `jac-web-search` | Tavily web search (called by research-agent internally) |
| `jac-kill-switch` | Cancels all running/queued tasks |
| `trigger-watch-run` | Frontend bridge for Run Now + Skip Next watch actions (JWT auth) |
| `jac-watch-scheduler` | Cron: fires due watches, creates child tasks, advances next_run_at |
| `jac-dashboard-query` | NL queries over entries (Claude Haiku) |
| `slack-incoming` | Slack webhook -> dispatcher (HMAC-SHA256 verified) |
| `calendar-reminder-check` | Cron: due entries -> Slack reminders |
| `smart-save` | Classify + save dump input |
| `enrich-entry` | AI enrichment for entries (dormant — UI removed) |
| `generate-embedding` | Voyage AI voyage-3-lite (512-dim), accepts `input_type` (document/query) |
| `search-memory` | Semantic (vector, threshold 0.3) + keyword hybrid search |
| `classify-content` | Claude Haiku content classification |
| `calculate-importance` | Importance scoring (1-10) — runs on ALL entries now |
| `backfill-embeddings` | Batch embed with rich text + create relationships (cron every 30 min) |
| `brain-insights` | AI insight generation via Claude Haiku (cron 10 AM + 8 PM Eastern) |
| `generate-brain-report` | Claude Haiku analyzes entries in date range → structured report (on-demand) |
| `jac-morning-brief` | Daily 8 AM ET cron: compiles schedule, activity, brain, markets into brief → insights + reports + Slack |
| `market-snapshot` | Weekday 5 PM ET cron: fetches market quotes, saves to brain + reports |
| `market-quotes` | Fetches Finnhub API for SPY, QQQ, DIA, GLD, USO, BTC, ETH |
| `jac-reflect` | Fire-and-forget from all workers: Haiku reflection + Voyage embed |
| `extract-entities` | Haiku entity extraction from entries and reflections |
| `jac-heartbeat` | Cron every 30 min: proactive heartbeat insights |
| `distill-principles` | Weekly cron (Sunday 3 AM UTC): Sonnet distills principles from reflections |
| `elevenlabs-tts` | ElevenLabs text-to-speech |

All functions listed in `config.toml` with `verify_jwt = false` — auth is handled in function code, not at gateway. This is required for internal agent→agent calls that use service role.

## Shared Modules (`_shared/`)

| Module | Purpose |
|---|---|
| `anthropic.ts` | Claude API calls + `recordTokenUsage()` helper |
| `auth.ts` | JWT extraction, service-role validation (constant-time) |
| `cors.ts` | Dynamic origin CORS headers |
| `github.ts` | GitHub REST API with `encodeURIComponent()` on all paths |
| `logger.ts` | Activity log writing |
| `slack.ts` | Slack message posting/updating |
| `context.ts` | Schedule context injection (timezone-aware) |
| `response.ts` | Standard response formatting |
| `validation.ts` | Input validation + `escapeForLike()` |
| `rateLimit.ts` | Rate limiting (in-memory + DB) |
| `clock.ts` | Timezone-aware date/time utilities |

## Routes

| Path | Page | Auth |
|---|---|---|
| `/` | Landing | Public |
| `/auth` | Google sign-in | Public |
| `/dashboard` | Widget grid dashboard (20 widgets) | Required |
| `/jac` | Nerve Center: split chat + context panel (desktop), Sheet fallback (mobile) | Required |
| `/code` | Code workspace | Required |
| `/calendar` | Calendar view | Required |
| `/search` | Search page | Required |
| `/activity` | Activity log | Required |
| `/agents` | Agent cards with stats, status, task history | Required |
| `/brain` | Brain Inspector: entries, reflections, entities, principles | Required |
| `/crons` | System jobs (pg_cron) + Watches control panel | Required |
| `/reports` | Unified report hub: briefs, research, market snapshots, generated reports | Required |
| `/settings` | Settings | Required |

## Env Vars

**Vercel:** `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`
**Supabase secrets:** `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `GITHUB_PAT`, `TAVILY_API_KEY`
**Future (self-deploy):** `SUPABASE_MANAGEMENT_PAT`

**Supabase Vault (for pg_cron):** `project_url`, `supabase_url` (both = `https://rvhyotvklfowklzjahdd.supabase.co`), `service_role_key`. Both URL key names must exist — different crons use different names.

## Roadmap (March 2026)

Priority order. User may push back on some — these are candidates, not commitments.

| # | Feature | What | Why | Scope |
|---|---------|------|-----|-------|
| 1 | **Conversational Memory** | Group `agent_conversations` into sessions. Inject recent session context into dispatcher. JAC remembers "we talked about X yesterday." | Biggest gap between tool and OS. Data already exists in agent_conversations — needs session boundaries + context injection. | `conversation_sessions` table or session_id on agent_conversations, dispatcher context injection, session boundary detection |
| 2 | **Inline JAC on Dashboard** | Slide-up command bar or persistent bottom panel on dashboard. Type anywhere, results update widgets in place. | Dashboard is passive display — can't act on anything without navigating to /jac. "Chat IS the navigation" vision. | CommandBar component, widget action dispatch, dashboard integration |
| 3 | **Widget Action Hooks** | Every widget gets 1-2 inline actions that dispatch to JAC. DriftRadar: "Remind me" / "Archive." SparkBoard: "Research this." Agent Outputs: "Follow up." | Turns dashboard from read-only into control surface. | Per-widget action buttons, dispatcher integration, toast feedback |
| 4 | **Proactive Actionable Outreach** | Heartbeat insights become actionable: "You saved 3 ideas about X but never followed up. Want me to synthesize?" with one-click "Yes" / "Snooze." | Current heartbeat insights are passive banners. Making them actionable closes the loop. | Heartbeat enhancement, Slack action buttons or web UI action cards |
| 5 | **Entity Graph Visualization** | Click entity in BrainInspector → see all mentions, related entities (co-occurrence), timeline, connected entries ranked by relevance. | Graph data exists (`brain_entities`, `entity_mentions`, `entry_relationships`) but displayed as flat list. | BrainInspector entity detail view, co-occurrence queries, timeline component |

### Tech Debt to Address
- `Dashboard.tsx` uses `getSession()` without `getUser()` first — violates own gotcha list.
- Dashboard layout in localStorage only — should persist to `user_settings.dashboard_layout` for cross-device.
- 40+ edge functions each bundle `_shared/` — missed redeploy = stale auth code. No automated drift detection.
- No error alerting — crons can fail silently for days. Heartbeat should check cron health.
- `enrich-entry` function is dormant — delete or use.
- `agent_conversations` loads last 200 rows with no pagination or session concept.

### Backlog (lower priority)
- Agent Replay widget (animated task timelines)
- Agent config UI (model selection, skills, creating new agents)
- Model escalation (Sonnet fails → retry with Opus)
- Search result thread linking
- Live preview iframe for code tasks
- Deploy agent Phase 2

**JAC-Specific Gotchas:**

NEVER call `getSession()` without `getUser()` first — `getSession()` returns stale cached JWTs. `getUser()` forces server refresh.

NEVER rely on `agent_conversations` Realtime INSERT events — unreliable with service role. Fetch on task completion instead.

NEVER create child tasks (watch runs, sub-tasks) without setting `intent` — column has NOT NULL constraint. Inherit from parent task.

NEVER bulk-cancel/fail running tasks without excluding watch templates — add `AND cron_expression IS NULL` (SQL) or `.is('cron_expression', null)` (PostgREST). Watch templates sit in `running` status permanently. This applies to BOTH the success path (parent-completion) AND the error path (parent-fail on child error) in all worker agents.

NEVER mark a parent task as `completed` without checking `.is('cron_expression', null)` — watch templates are parents too. All 4 agents have parent-completion logic that must skip watches.

NEVER commit to main/master from the code agent — always `jac/{slug}-{hex}` branches.

ALWAYS use `extractUserIdWithServiceRole()` for functions callable both from frontend and internally (classify-content, smart-save, generate-embedding, search-memory, calculate-importance).

## Memory Layer

**How the brain works — don't break this pipeline:**

1. **Input** → `smart-save` classifies (regex fast-path or Haiku)
2. **Store** → `entries` table: title, content, content_type, tags, event_date, importance_score
3. **Embed** → Voyage AI voyage-3-lite (512-dim) on rich text: `"title | type | tags | content"`
4. **Link** → `entry_relationships` created via semantic similarity after embedding
5. **Backfill** → Cron every 30 min catches un-embedded entries (batch 20)
6. **Search** → Hybrid: embedding similarity (threshold 0.3) + keyword ilike. `input_type: 'query'` for search, `'document'` for storage
7. **Context** → `getUserContext()` injects today + overdue + 7-day schedule into every agent system prompt
8. **Reflect** → `jac-reflect` fires after every task. Haiku summary → `jac_reflections` with embedding
9. **Distill** → Weekly cron (Sonnet) extracts principles from reflections → `jac_principles`
10. **Entities** → `extract-entities` (Haiku) pulls people/projects/places/concepts → `brain_entities`

**Don't touch without flagging:** `entries` table schema, embedding dimensions (512), `search_entries_by_embedding` RPC signature, `smart-save` classification logic, `backfill-embeddings` batch size or cron timing.

## Crons (JAC)
Active jobs: reminders (5m), backfill (30m), heartbeat (30m), insights (2x daily), morning brief (8AM ET), principles (weekly).

## Slack Integration
```
Bot token:       SLACK_BOT_TOKEN (Supabase secret)
Signing secret:  SLACK_SIGNING_SECRET (HMAC-SHA256)
User channel:    user_settings.settings.slack_channel_id
Incoming:        slack-incoming edge function (HMAC verified)
Outgoing:        chat.postMessage or chat.update via bot token
```
Best-effort Slack. Always try/catch — never throw from Slack code.
