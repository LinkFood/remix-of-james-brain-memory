# JAC Agent OS — Architecture

Personal AI operating system (single-user). The meta-project: if JAC works, it handles everything else — life management, code automation, research, memory, reminders, and eventually self-modification. One interface (web chat or Slack DM) that routes to specialized AI workers.

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

**Critical patterns:**
- All supabase-js imports MUST pin to `@2.84.0` — unpinned `@2` causes version mismatch in Deno isolates
- Claude Haiku ignores `type: "array"` in tool schemas ~80% of the time — always normalize with `Array.isArray()` guards
- `retryWithBackoff` must NOT retry on 4xx errors (auth, rate limit, bad request) — only retry on 5xx/network
- Watch templates (`cron_expression IS NOT NULL`) sit in `running` status permanently — any query that bulk-cancels/fails running tasks MUST exclude them with `AND cron_expression IS NULL` or `.is('cron_expression', null)`
