

# Pass 1 — Foundation Execution

Execute steps 1-7. Stop after task-dispatcher. No worker agents yet.

## Step 1-3: Request Secrets

Prompt the user to add three secrets:
- `ANTHROPIC_API_KEY` (required)
- `FINNHUB_API_KEY` (required for stocks later, but add now)
- `SLACK_SIGNING_SECRET` (optional, for Slack later)

## Step 4: Database Migration

Single migration creating:

**`agent_tasks`** -- 18 columns including `next_run_at`, indexes on `(user_id, status)`, `(user_id, cron_active)`, and `(next_run_at)`, RLS for SELECT/INSERT/UPDATE, realtime enabled, `updated_at` trigger.

**`user_settings`** -- 7 columns, UNIQUE on `user_id`, RLS for ALL, `updated_at` trigger.

## Step 5: Create `_shared/anthropic.ts`

Shared helper with:
- `getAnthropicHeaders()` -- x-api-key + anthropic-version
- `callClaude(options)` -- fetch wrapper with error handling
- `parseToolUse(response)` -- extracts tool_use content block
- `CLAUDE_RATES` and `calculateCost(usage)` for cost tracking

## Step 6: Swap AI in 5 Edge Functions

All swap from `ai.gateway.lovable.dev` + `LOVABLE_API_KEY` to `api.anthropic.com` + `ANTHROPIC_API_KEY`.

| Function | Key Changes |
|----------|-------------|
| assistant-chat | Stream transform: Claude SSE to OpenAI-compatible SSE (Option A, zero frontend changes). System prompt to top-level field. |
| classify-content | Tool response: `content.find(c => c.type === 'tool_use').input` instead of `tool_calls[0].function.arguments`. `tool_choice` format change. |
| calculate-importance | Same tool parsing changes as classify-content. |
| enrich-entry | Drop `response_format: { type: 'json_object' }`, keep JSON instruction in prompt, parse `content[0].text`. |
| generate-brain-report | Tool parsing changes same as classify-content. |

## Step 7: Create `task-dispatcher/index.ts`

- Auth via `extractUserId`
- Rate limits: max 10 concurrent running tasks, max 200/day
- Claude analyzes intent, determines required agents
- Creates parent task in `agent_tasks`
- Spawns workers via parallel fetch (placeholder for Pass 2 agents)
- Collects results, saves to entries, updates task status

## Step 8: Update `config.toml`

Add `verify_jwt = false` entries for `task-dispatcher` (other new functions added in Pass 2).

## After Completion

User tests:
- Jac chat works with Claude streaming
- smart-save pipeline (dump -> classify -> embed -> importance)
- Brain report generation
- Enrich function
- New tables exist in database

No further work until user confirms Pass 1 is working.

