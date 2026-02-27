# JAC Agent OS — Architecture

Personal AI agent OS (single-user). Brain for capturing notes/events/reminders, agent swarm that dispatches AI workers (research, save, search, code), code workspace for autonomous GitHub PRs, Slack interface. React/Vite on Vercel; Supabase (Postgres + Edge Functions on Deno).

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, TypeScript, Tailwind, shadcn/ui |
| Routing | react-router-dom v6 |
| Server state | TanStack React Query v5 |
| Auth | Supabase Auth (Google OAuth, JWT) |
| Database | Supabase Postgres + pgvector (768-dim, HNSW) |
| Edge functions | Deno (Supabase Edge Functions) |
| AI | Claude Sonnet 4 (dispatcher), Claude Haiku 4.5 (workers) |
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

## Routes

| Path | Page | Auth |
|---|---|---|
| `/` | Landing | Public |
| `/auth` | Google sign-in | Public |
| `/dashboard` | Brain entries | Required (page-level check) |
| `/jac` | Agent command center | Required (page-level check) |
| `/code` | Code workspace | Required (page-level check) |
| `/settings` | Settings | Required (page-level check) |

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
| `assistant-chat` | Streaming chat with brain context |
| `smart-save` | Classify + save dump input |
| `enrich-entry` | AI enrichment for entries |
| `generate-embedding` | Vector embedding generation |
| `search-memory` | pgvector semantic search |

## Database (core tables)

| Table | Purpose |
|---|---|
| `profiles` | User profile, auto-created on signup |
| `entries` | Brain: content, tags, embedding, importance, event_date, starred |
| `agent_tasks` | Task queue: type, status, agent, input/output JSONB, parent_task_id |
| `agent_conversations` | Chat history per user |
| `agent_activity_log` | Per-step agent logs |
| `code_projects` | Registered GitHub repos |
| `code_sessions` | Active coding sessions |

All tables have RLS (`auth.uid() = user_id`). Service role bypasses for agent workers.

## Data Flow

1. **Dump:** Input -> `smart-save` -> classify -> insert entry -> `enrich-entry` (fire-and-forget) -> realtime updates UI
2. **Jac chat:** Message -> `jac-dispatcher` -> Claude parses intent -> parent task -> worker dispatched -> client watches via realtime
3. **Slack:** DM -> `slack-incoming` (HMAC verify) -> `jac-dispatcher` -> worker -> response posted to Slack
4. **Code:** Intent -> `jac-code-agent` -> read repo -> plan -> write -> commit -> PR

## Auth Flow

1. `supabase.auth.signInWithOAuth({ provider: 'google' })`
2. JWT stored by supabase-js, sent as `Authorization: Bearer` to edge functions
3. Edge functions: `extractUserId` (JWT) or service-role + userId (Slack path)
4. RLS enforces per-user data isolation

## Conventions

- All edge functions use `_shared/cors.ts` (dynamic origin check) + `_shared/auth.ts`
- Agent pattern: parent task -> child task -> fire-and-forget worker
- Workers log to `agent_activity_log` via `createAgentLogger`
- Rate limit: 50 req/min; loop guard: 5 tasks/60s auto-cancels; daily cap: 200 tasks
- SQL migrations are idempotent (IF NOT EXISTS / DO $$ EXCEPTION blocks)
- Code agent: always branches, never commits to main/master
- `escapeForLike()` from `_shared/validation.ts` MUST be used for any `.ilike()` patterns with user input
- Conversation updates use row ID, never content string matching

## Security

- CORS: dynamic origin checking via `_shared/cors.ts` — never use `'*'`
- Slack: HMAC-SHA256 with constant-time comparison
- ilike injection: all user input escaped via `escapeForLike()`
- GitHub PAT: scoped to specific repos, code agent can never commit to main
- Rate limiting: in-memory (per-isolate) + DB-backed (concurrent/daily limits)
- Kill switch: Slack keywords or web UI -> cancels all running tasks

## Env Vars

**Vercel:** `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`
**Supabase secrets:** `ANTHROPIC_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `GITHUB_PAT`, `TAVILY_API_KEY`
