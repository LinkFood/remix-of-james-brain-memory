# JAC Agent OS — Architecture

Personal AI operating system (single-user). The meta-project: if JAC works, it handles everything else — life management, code automation, research, memory, reminders, and eventually self-modification. One interface (web chat or Slack DM) that routes to specialized AI workers.

## What Works Right Now

| Capability | Status | How |
|---|---|---|
| Brain dumps (notes, ideas, links) | Working | Chat/Slack -> dispatcher -> save-agent -> entries table |
| Reminders ("remind me to buy eggs Tuesday") | Working (manual cron) | smart-save extracts event_date + reminder_minutes -> calendar-reminder-check fires Slack |
| Event scheduling | Working | smart-save extracts dates, recurring patterns; schedule injected into every conversation |
| Research (weather, news, facts) | Working | dispatcher -> research-agent (Tavily + Claude synthesis) |
| Semantic search over saved entries | Working | pgvector embeddings + keyword hybrid via search-memory |
| Code: read repos, plan, write, commit, PR | Working | dispatcher -> code-agent -> GitHub API -> branch + PR |
| Slack: bidirectional chat + proactive reminders | Working | slack-incoming (HMAC verified) -> dispatcher; reminders via calendar-reminder-check |
| Kill switch (stop all agents) | Working | Slack keywords or web UI -> cancels all running/queued tasks |
| Dashboard NL queries | Working | jac-dashboard-query (Claude Haiku over entries + relationships) |

## What's Broken or Not Wired Up

| Issue | Detail |
|---|---|
| Reminder cron not scheduled | `calendar-reminder-check` works but pg_cron needs manual setup in DB |
| Self-deploy blocked | `supabase-management.ts` written but needs standalone Supabase (migration pending) |
| File content not viewable in code UI | File tree shows but clicking shows placeholder; server-side read only during coding tasks |
| `task-dispatcher` is a dead stub | Never called; `jac-dispatcher` is the real entry point. Remove it. |
| `assistant-chat` has duplicate intent detection | Regex-based classify that duplicates/conflicts with dispatcher's Claude-based routing |
| Brain context uses keyword not semantic | Dispatcher injects brain context via ilike, not embeddings ("embedding endpoint unreliable") |
| Embedding failures = unsearchable entries | No retry/backfill job committed |
| KnowledgeGraph memory leak | THREE.js geometry/materials never disposed |
| Dead product code remains | useSubscription, UpgradeModal, /pricing in Settings, broken Delete Account |

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, TypeScript, Tailwind, shadcn/ui |
| Routing | react-router-dom v6 |
| Server state | TanStack React Query v5 |
| Auth | Supabase Auth (Google OAuth, JWT) |
| Database | Supabase Postgres + pgvector (768-dim, HNSW) |
| Edge functions | Deno (Supabase Edge Functions) |
| AI | Claude Sonnet 4 (dispatcher, research, code), Claude Haiku 4.5 (classify, dashboard) |
| Voice | ElevenLabs (STT + TTS) |
| Web search | Tavily API |
| GitHub | REST API via PAT |
| Hosting | Vercel (frontend), Supabase (backend) |

## Directory Structure

```
src/
├── pages/          # Route components (Auth, Dashboard, Jac, CodeWorkspace, Settings)
├── components/     # UI components (feature + shadcn)
├── hooks/          # All data + business logic
├── integrations/supabase/  # client.ts + types.ts
└── lib/            # utils
supabase/
├── functions/      # Edge functions (one dir per function)
│   └── _shared/    # anthropic, auth, cors, github, logger, slack, context, response, validation, rateLimit
└── migrations/     # SQL migrations (42 files)
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

Rate limits: 50 req/min, 10 concurrent tasks, 200 tasks/day. Loop guard: 5+ tasks in 60s -> auto-cancel all.

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
3. Content types: `code`, `list`, `idea`, `link`, `contact`, `event`, `reminder`, `note`, `image`, `document`
4. After save: `generate-embedding` (fire-and-forget) -> pgvector storage -> `entry_relationships` via semantic similarity
5. `enrich-entry` adds AI enrichment (also fire-and-forget)

## Calendar / Reminders

- `calendar-reminder-check`: queries entries where `reminder_sent = false` and reminder is due
- Sends Slack message with bell emoji, title, date, countdown
- Sets `reminder_sent = true` after send
- Schedule context (`_shared/context.ts`): today's events, overdue items, next 7 days — injected into every dispatcher and assistant-chat conversation
- **Needs:** pg_cron setup (2x/day for date-only, every 15 min for timed events via `timed_only: true`)

## Database (core tables)

| Table | Purpose |
|---|---|
| `profiles` | User profile, auto-created on signup |
| `entries` | Brain: content, tags, embedding, importance, event_date, starred, reminder_minutes, reminder_sent |
| `agent_tasks` | Task queue: type, status, agent, input/output JSONB, parent_task_id, cost_usd, tokens_in/out |
| `agent_conversations` | Chat history per user |
| `agent_activity_log` | Per-step agent logs |
| `code_projects` | Registered GitHub repos (name, repo_full_name, default_branch, tech_stack, file_tree_cache) |
| `code_sessions` | Active coding sessions |
| `user_settings` | Per-user settings JSONB (includes slack_channel_id) |
| `entry_relationships` | Semantic links between entries |

All tables have RLS (`auth.uid() = user_id`). Service role bypasses for agent workers.

## Auth Flow

1. `supabase.auth.signInWithOAuth({ provider: 'google' })`
2. JWT stored by supabase-js, sent as `Authorization: Bearer` to edge functions
3. Edge functions: `extractUserId` (JWT) or service-role + userId (Slack/cron path)
4. RLS enforces per-user data isolation

## Security Conventions

- CORS: dynamic origin checking via `_shared/cors.ts` — NEVER use `'*'`
- Slack: HMAC-SHA256 with constant-time comparison (not `===`)
- ilike injection: all user input escaped via `escapeForLike()` from `_shared/validation.ts`
- Conversation updates: use row ID, NEVER content string matching (PostgREST ignores .order/.limit on UPDATE)
- GitHub PAT: scoped to specific repos, code agent blocks main/master commits
- Rate limiting: in-memory (per-isolate) + DB-backed (concurrent/daily limits)
- Kill switch: Slack keywords or web UI -> cancels all running tasks
- Code agent file blocks: `.env`, `.pem`, `.key`, `credentials`, `secret`

## Edge Functions

| Function | Purpose |
|---|---|
| `jac-dispatcher` | Boss: parses intent via Claude, creates tasks, fires workers |
| `jac-research-agent` | Web research (Tavily + Claude synthesis) |
| `jac-save-agent` | Saves content to entries |
| `jac-search-agent` | Semantic search (embedding + keyword) |
| `jac-code-agent` | GitHub: read, write, commit, PR |
| `jac-kill-switch` | Cancels all running/queued tasks |
| `jac-dashboard-query` | NL queries over entries (Claude Haiku) |
| `slack-incoming` | Slack webhook -> dispatcher (HMAC-SHA256 verified) |
| `calendar-reminder-check` | Cron: due entries -> Slack reminders |
| `assistant-chat` | Streaming chat with brain context (legacy, predates dispatcher) |
| `smart-save` | Classify + save dump input |
| `enrich-entry` | AI enrichment for entries |
| `generate-embedding` | Vector embedding generation |
| `search-memory` | pgvector semantic search |
| `classify-content` | Claude Haiku content classification |
| `calculate-importance` | Importance scoring (1-10) |

## Routes

| Path | Page | Auth |
|---|---|---|
| `/` | Landing | Public |
| `/auth` | Google sign-in | Public |
| `/dashboard` | Brain entries + graph | Required |
| `/jac` | Agent command center (chat) | Required |
| `/code` | Code workspace | Required |
| `/settings` | Settings | Required |

## Env Vars

**Vercel:** `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`
**Supabase secrets:** `ANTHROPIC_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `GITHUB_PAT`, `TAVILY_API_KEY`
**Future (self-deploy):** `SUPABASE_MANAGEMENT_PAT`
