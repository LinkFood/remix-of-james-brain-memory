

# Launch Polish Plan: JAC Agent OS + Slack 2-Way

All previous batches remain the same. Adding Batch 4 for Slack inbound (talk to JAC from Slack).

---

## Batch 1: Backend Fixes (Critical Path)

### 1a. Fix Dispatcher Brain Context
**File**: `supabase/functions/jac-dispatcher/index.ts` (lines 157-189)
- Replace the broken `generate-embedding` + `search_entries_by_embedding` RPC call with a direct keyword search against the `entries` table
- Extract significant words from the user message, query with `ilike` on content/title and `contains` on tags
- Deduplicate and take top 5 results to build `brainContext`

### 1b. Fix `jac-save-agent` Bug
**File**: `supabase/functions/jac-save-agent/index.ts` (line 91)
- Change `await saveStep({ entryId, entryTitle, entryType })` to `await saveStep()` then `await log.info('save_result', { entryId, entryTitle, entryType })`

**Deploy + Test**: Send "search for [something saved]" on `/jac` -- JAC should now have brain context.

---

## Batch 2: Frontend Polish

### 2a. Move InstallPrompt Inside Router
**File**: `src/App.tsx`
- Move `<InstallPrompt />` from outside `BrowserRouter` to inside it

### 2b. Create Landing Page
**New file**: `src/pages/Landing.tsx`
- Dark, bold hero: "Your Personal AI Agent Swarm"
- 3 value props: Dispatch agents / 24-7 async / Results in your brain
- CTA: Sign In button linking to `/auth`
- Minimal footer with Terms/Privacy links

**File**: `src/App.tsx`
- Change `/` route from redirect to `Landing`

### 2c. Bridge Dashboard Assistant to JAC
**File**: `src/components/AssistantChat.tsx`
- Add a small "Open Command Center" link that navigates to `/jac`

**Test**: Visit `/` -- see landing page. Dashboard assistant has Command Center link.

---

## Batch 3: Vision + Assistant Prompt

### 3a. Update VISION.md
**File**: `VISION.md`
- Add "Layer 4 -- AGENTS (Cloud Intelligence)" describing JAC Agent OS
- Add Slack 2-way communication to the architecture
- Update tech stack to mention Anthropic Claude
- Update "What Jac Is" to include agent dispatch and Slack interface

### 3b. Update Assistant System Prompt
**File**: `supabase/functions/assistant-chat/index.ts`
- Add a line to the system prompt: "For complex research, analysis, or multi-step tasks, suggest the user open the JAC Command Center at /jac"

**Test**: Verify assistant mentions JAC for complex queries.

---

## Batch 4: Slack Inbound -- Talk to JAC from Your Phone (NEW)

This is the key missing piece. Currently agents send notifications TO Slack, but you can't send commands FROM Slack. This batch makes Slack a full 2-way interface.

### How It Works

```text
You (Slack) --> "Research the latest AI agent frameworks"
       |
       v
[slack-incoming edge function]
  - Validates x-slack-signature using SLACK_SIGNING_SECRET
  - Extracts message text and Slack channel/thread info
  - Looks up your user_id (single-user app, so hardcoded or from settings)
  - Calls jac-dispatcher with the message
  - Responds to Slack within 3 seconds (acknowledges receipt)
       |
       v
[jac-dispatcher] --> spawns Scout agent --> research happens async
       |
       v
[Agent completes] --> notifySlack() sends result back to your Slack channel
```

### 4a. Create `slack-incoming` Edge Function
**New file**: `supabase/functions/slack-incoming/index.ts`

Key implementation details:
- Verify request signature using `SLACK_SIGNING_SECRET` (HMAC-SHA256 of timestamp + body)
- Handle Slack's URL verification challenge (responds with `challenge` value)
- Handle `event_callback` events for `message` type (direct messages or mentions)
- Ignore bot messages (prevent loops -- check `event.bot_id`)
- Look up user ID: since this is a single-user app, query `profiles` table for the single user, or store a `slack_user_id` mapping in `user_settings`
- Fire-and-forget call to `jac-dispatcher` (don't wait for agent completion -- Slack has a 3-second timeout)
- Return 200 immediately with an acknowledgment
- Slack notification from the agent completing will serve as the "response"

### 4b. Update `supabase/config.toml`
- Add `[functions.slack-incoming]` with `verify_jwt = false` (Slack sends its own auth)

### 4c. Update `_shared/slack.ts` -- Thread-Aware Responses
**File**: `supabase/functions/_shared/slack.ts`
- Currently sends notifications via incoming webhook URL (one-way)
- For Slack inbound to feel conversational, agent results should reply in the SAME Slack thread
- Add an optional `slack_thread_ts` and `slack_channel` to the task input so agents can pass it through to `notifySlack`
- When thread info is available, use the Slack `chat.postMessage` API (via bot token) instead of the webhook to reply in-thread
- This requires the Slack bot token -- check if we should use the Lovable Slack connector or the existing custom app setup

### 4d. Store Slack Context in Tasks
**File**: `supabase/functions/slack-incoming/index.ts`
- When creating the task via `jac-dispatcher`, include `slack_channel` and `slack_thread_ts` in the task input
- Worker agents pass this through to `notifySlack`
- Result: you send a message in Slack, agents reply in the same thread

### 4e. Slack Bot Token Setup
The `SLACK_SIGNING_SECRET` is already configured, which means a custom Slack app exists. For sending replies back to a specific channel/thread, we also need a `SLACK_BOT_TOKEN`.

Options:
- **Option A**: Use the Lovable Slack connector (simplest -- provides `SLACK_API_KEY` automatically via connector gateway)
- **Option B**: Use the existing custom Slack app's bot token (requires adding `SLACK_BOT_TOKEN` as a secret)

Since you already have `SLACK_SIGNING_SECRET` for a custom app, and the connector can't receive events (it's send-only), the approach is:
- Keep the custom app for RECEIVING events (uses `SLACK_SIGNING_SECRET`)
- Use either the connector or a bot token for SENDING thread replies
- Simplest: add `SLACK_BOT_TOKEN` as a new secret from the same custom Slack app

I'll ask you for the bot token after building the function.

**Deploy + Test**:
1. Deploy `slack-incoming`
2. Configure the Slack app's Event Subscriptions URL to: `https://fhfmwdbousoycutlhvjh.supabase.co/functions/v1/slack-incoming`
3. Send a DM to the bot in Slack: "Research AI agent frameworks"
4. Should see task appear in Command Center and result come back in Slack

---

## Summary

| Batch | Scope | Files | Type |
|-------|-------|-------|------|
| 1 | Fix brain context + save bug | `jac-dispatcher`, `jac-save-agent` | Edge functions |
| 2 | Landing page + InstallPrompt + assistant bridge | `Landing.tsx` (new), `App.tsx`, `AssistantChat.tsx` | Frontend |
| 3 | Vision doc + assistant prompt | `VISION.md`, `assistant-chat` | Docs + Edge function |
| 4 | Slack inbound (talk to JAC from phone) | `slack-incoming` (new), `config.toml`, `_shared/slack.ts` | Edge functions |

Test after each batch before moving to the next.

### What You'll Need for Batch 4
- Your Slack app's **Bot User OAuth Token** (starts with `xoxb-`), found at: Your Slack App > OAuth & Permissions > Bot User OAuth Token
- Enable **Event Subscriptions** in the Slack app and point the Request URL to the edge function
- Subscribe to bot events: `message.im` (direct messages) and optionally `app_mention` (mentions in channels)

