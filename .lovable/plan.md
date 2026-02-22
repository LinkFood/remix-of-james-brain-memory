

# Pass 1 Execution — Ready to Go

You have all three API keys ready. Here's the execution sequence:

## Step 1: Add Secrets
Request you to input each secret one at a time:
1. `ANTHROPIC_API_KEY` — from console.anthropic.com
2. `FINNHUB_API_KEY` — from finnhub.io
3. `SLACK_SIGNING_SECRET` — from Slack app settings

## Step 2: Database Migration
Single SQL migration creating `agent_tasks` (18 columns, indexes, RLS, realtime) and `user_settings` (7 columns, RLS).

## Step 3: Create `_shared/anthropic.ts`
Shared helper with `callClaude()`, `parseToolUse()`, `getAnthropicHeaders()`, cost tracking constants.

## Step 4: Swap AI in 5 Edge Functions
Replace Lovable AI gateway with direct Anthropic Claude API in:
- `assistant-chat` (stream transform: Claude SSE to OpenAI-compatible SSE)
- `classify-content` (tool parsing update)
- `calculate-importance` (tool parsing update)
- `enrich-entry` (JSON response parsing)
- `generate-brain-report` (tool parsing update)

## Step 5: Create `task-dispatcher/index.ts`
Intent analysis, rate limiting (10 concurrent / 200 daily), agent spawning placeholder.

## Step 6: Update `config.toml`
Add `task-dispatcher` with `verify_jwt = false`.

## Checkpoint
Stop and wait for you to test: Jac chat streaming, smart-save pipeline, brain reports, enrich, and verify new tables exist.

