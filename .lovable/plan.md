

# Fix All Worker Agents: Pass Slack Thread Info for In-Thread Replies

## Problem

The dispatcher already sends `slack_channel` and `slack_thread_ts` to every worker agent in the request body. But all three workers ignore those fields and call `notifySlack()` without them. Since `notifySlack()` only uses the bot token for thread replies when `slackChannel` and `slackThreadTs` are provided, it falls back to the webhook (or does nothing useful).

## Changes (3 files, identical pattern)

### 1. `supabase/functions/jac-research-agent/index.ts`

- Extract `slack_channel` and `slack_thread_ts` from `body` (after line 49)
- Pass `slackChannel: slack_channel` and `slackThreadTs: slack_thread_ts` to both `notifySlack()` calls (success on line 254 and error on line 315)

### 2. `supabase/functions/jac-save-agent/index.ts`

- Extract `slack_channel` and `slack_thread_ts` from `body` (after line 41)
- Pass `slackChannel: slack_channel` and `slackThreadTs: slack_thread_ts` to both `notifySlack()` calls (success on line 120 and error on line 180)

### 3. `supabase/functions/jac-search-agent/index.ts`

- Extract `slack_channel` and `slack_thread_ts` from `body` (after line 41)
- Pass `slackChannel: slack_channel` and `slackThreadTs: slack_thread_ts` to both `notifySlack()` calls (success on line 135 and error on line 197)

## How `notifySlack()` Already Works

The `_shared/slack.ts` already has this logic (no changes needed there):

```text
if (payload.slackChannel && payload.slackThreadTs && botToken) {
  // Reply in the Slack thread using chat.postMessage
} else {
  // Fall back to webhook
}
```

So simply passing the two fields is all that's needed.

## After This Fix

All agent types (research, save, search, general) will reply directly in the Slack thread where the user sent the message.

