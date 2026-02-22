

# Fix: Slack Replies Not Working + Remove Threading

## Three Issues Found

### Issue 1: Worker agents (research, save, search) never reply in Slack
`_shared/slack.ts` line 48 exits early if no `slack_webhook_url` is configured in user_settings. The bot token reply path (line 91) is **unreachable** without a webhook URL. Since you use the bot token approach (not webhooks), all worker agent replies silently fail.

### Issue 2: Replies appear as threads instead of in the main DM
Both `_shared/slack.ts` and `jac-dispatcher` include `thread_ts` in `chat.postMessage`, causing Slack to nest replies as threads. Removing `thread_ts` makes replies appear directly in the DM conversation.

### Issue 3: General intent response quality
The "I'll help you check the time right now" answer is just the AI being vague. This is a prompt tuning issue — lower priority but noted.

## Fix (2 files)

### 1. `supabase/functions/_shared/slack.ts`

Restructure the function so the bot token path is checked **first**, independent of webhook URL:

```text
Current flow:
  1. Read webhook URL from user_settings
  2. If no webhook URL -> RETURN (bug! never reaches bot token)
  3. If slackChannel + slackThreadTs + botToken -> reply in thread
  4. Else -> use webhook

New flow:
  1. Check if slackChannel + botToken are present
  2. If yes -> post to channel (no thread_ts) and return
  3. Read webhook URL from user_settings
  4. If webhook URL -> use webhook
  5. If neither -> return silently
```

Also remove `thread_ts` from the `chat.postMessage` call so replies appear in the main DM flow.

### 2. `supabase/functions/jac-dispatcher/index.ts`

In the general intent Slack reply (line 370), remove `thread_ts` from the `chat.postMessage` body so the response appears in the main DM conversation, not as a thread.

## What This Fixes

| Issue | Before | After |
|---|---|---|
| Research/save/search replies | Silent failure (early return) | Replies in main DM |
| General replies | Thread | Main DM |
| Response style | No change needed | Same |

## No Database Changes Needed

Two edge function files change, then redeploy all affected functions.

