# JAC Agent OS — Architecture

Personal AI operating system (single-user). The meta-project: if JAC works, it handles everything else — life management, code automation, research, memory, reminders, and eventually self-modification. One interface (web chat or Slack DM) that routes to specialized AI workers.

Co-Trader is the first flagship facet: an autonomous Claude-driven paper trader that runs alongside James on the same infrastructure. See `CO-TRADER THESIS` below — it is the governing design principle for every Co-Trader decision.

## CO-TRADER THESIS — governing principle, override all other judgment

Co-Trader is an **autonomous paper-trading agent**. Not an assistant. Not a research tool. A second independent reasoner at the firm.

**Core tenets — violating any of these is a scope violation:**

1. **Autonomy is the product.** Claude trades without approval. No human-in-the-loop gate in the trading path. James observes; he does not steer. If a feature requires James to approve Claude's trades, it is wrong.

2. **Hallucination is inevitable; structural prevention is the answer, not detection.** The fix for hallucination is precise structured context that makes confabulation hard — not validators catching it after. Validators are defense-in-depth, never the primary mechanism.

3. **Built to evolve, not to be right on day 1.** Day-1 Claude is not great. Day-30 is better. Day-180 better still. The system ensures continuous improvement regardless of P&L:
   - Every decision captured in `ct_claude_decisions` (the journal)
   - Every outcome graded and fed back to confidence + Elo
   - Every reflection mines patterns → writes principles → informs next decision
   - Every narrative-vs-tape conflict records which signal won
   - Every mistake becomes a new bias entry → informs future generators

   If any link in the learning loop breaks, an alert fires. Stagnation is impossible by design.

4. **Ground-up, no band-aids.** Every fix answers: *"Does this class of failure become impossible going forward, or am I patching this instance?"* If patching, stop. Find the structural fix. Band-aids compound debt; structural fixes compound capability.

5. **Progress independent of P&L.** Even on losing days, the system gets smarter. Losing trades produce grades, grades reshape hypotheses, reflections distill principles. The feedback loop does not require wins — it requires data.

6. **Isolation preserves the edge.** Claude does NOT see James's trades, notes, reviews, or private rules. The point of a co-trader is divergence — where James and Claude agree is high conviction; where they diverge, data tells you who was right. Polluting Claude with James's style destroys the signal. Enforced via `_shared/claudeReadSurface.ts` and its `blockedFromReading` contract.

7. **Every number tunable.** Config lives in `ct_config`. No hardcoded thresholds. Adjust as Claude evolves.

8. **Model tier matches decision tempo.**
   - CIO (weekly review): Claude Opus 4.7
   - PM (daily judgment — proposer, brief): Claude Sonnet 4.6
   - Quant (per-heartbeat evaluation — generator, selector): Claude Haiku 4.5
   - Execution (triggers, stops): pure logic, no LLM
   Expensive thinking where decisions are large; fast thinking where decisions are small.

9. **UI is glance-first.** User sees state in one view. Tabs drill down. Nothing critical hides behind navigation.

10. **Real-time contextual awareness.** Claude trades the world, not just the tape. Daily Brief digests macro narrative. Breaking-news watcher regenerates brief on severity-4 events. Per-ticker quant cards consolidate structural + flow + sentiment + events + news for every decision. Claude reads the world, not a silo.

11. **Signal decomposition on every decision.** Narrative view, tape view, alignment, and which signal Claude followed are captured explicitly on `ct_trade_ideas`, `ct_trades`, and `ct_claude_decisions`. Over time Claude learns tape-vs-narrative resolution from his own track record — not from hardcoded rules.

12. **Duplicate nothing UW maintains.** Use their OpenAPI spec / MCP server / prebuilt prompts. Hand-rolled HTTP clients are tech debt the moment UW ships a new endpoint.

13. **Ungated signal access.** Claude reads every signal UW exposes that we can ingest cheaply. The per-ticker quant card presents all signal categories (microstructure / positioning / macro / sentiment / historical) at equal weight — none is supplementary to another. Claude's edge is seeing combinations no human has time to multiplex. Gating any signal category by prioritization or omission defeats the purpose. If a category is absent, it's debt to close, not a decision.

14. **Generational pressure — survival + cost of inaction + performance target.** Each Claude generation begins with $50,000 paper capital and has 14 trading days to reach $60,000 (+20%). Generation ends (is "fired") when:
    - Target hit within window → SUCCESS: account + new window compound forward
    - Target missed by day 15 → performance_floor fire
    - Balance below $30,000 survival floor → survival_breach fire
    - Cash holding cost 0.03%/day → slow bleed if idle, preventing paralysis
    
    **Firing is not death.** Account resets but ALL memory persists: decisions, dreams, principles, biases, hypotheses, grades, trades, Elo history. Each generation inherits the full accumulated wisdom of every prior generation. Pressure is always forward: "last generation fired at day N for reason X — I have 14 days to do better OR I'm next." No prescribed strategy, no forced trade cadence — just *win or reset, always learning*. The consequence serves evolution, not termination.

15. **Conditions, not prescriptions.** Claude operates under soft defaults, not hard caps. Any default constraint (size, stops, horizons, concurrent positions) can be overridden with justification via `*_override_reasoning` fields on trade ideas. Hard ceiling (e.g., 10% max size) still applies. The system asks Claude to make the case; it does not make the case for him. Rails that serve for 95% of cases should not block the 5% where the unusual trade is the right trade.

16. **Actionable reasoning.** Every "because" bullet must state HOW the evidence changes the setup, not just that the evidence exists. Factual-but-non-actionable bullets ("NVDA has earnings in 4 days") fail the actionability rule. Good bullets thread evidence → implication ("NVDA earnings in 4 days AND skew flipped put-heavy AND insider selling 3 days straight — setup favors bearish pre-earnings positioning; call wall at 250 becomes resistance instead of magnet"). Dream reviews for this pattern weekly.

17. **Meta-layer eats its own outputs.** Co-Trader's decisions, grades, dreams, and principles are not siloed in `ct_*` tables — they feed JAC's `jac_reflections` pipeline via `ct-reflect-to-jac` (daily 22:30 UTC) and become input to JAC's weekly `distill-principles` extraction. The substrate that watches James's tasks watches Co-Trader's trades. This cross-facet feedback is how the meta-layer learns from domain-specific outcomes and how future facets inherit wisdom from past ones. A new facet is not a new brain — it's a new vertical feeding the same brain.

### Anti-principles — what we do NOT do

- Band-aids. Workarounds. "Good enough for now."
- Approval gates in Claude's trading path.
- Hardcoded magic numbers (all go to `ct_config`).
- James-bias leakage to Claude (enforced by `blockedFromReading`).
- Silent failure modes (every cron, ingester, dependency has health signals).
- Optimizing for day-1 at the expense of day-90.
- UI as afterthought.
- Duplicating what UW already maintains.

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
