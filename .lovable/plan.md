

# Apply Slack Threading Fix (from commit a0081b4)

The GitHub commit removed `slack_thread_ts` / `slackThreadTs` across 6 files, but those changes haven't synced to Lovable yet. Here's what needs to be applied:

## Changes (6 files)

### 1. `supabase/functions/slack-incoming/index.ts`
- Remove `slack_thread_ts: event.thread_ts || event.ts` from the dispatch payload (line 132)
- Keep only `slack_channel`, `message`, `userId`, and `source`

### 2. `supabase/functions/jac-dispatcher/index.ts`
- Remove `slack_thread_ts` from the body type definition (line 93)
- Remove `slack_thread_ts` from destructuring
- Remove it from task input storage
- Remove it from worker dispatch payload
- Change the general-intent Slack reply guard from `if (slack_channel && slack_thread_ts)` to `if (slack_channel)`

### 3. `supabase/functions/jac-research-agent/index.ts`
- Remove `slack_thread_ts` variable extraction
- Remove `slackThreadTs` from both `notifySlack()` calls (success + error)

### 4. `supabase/functions/jac-save-agent/index.ts`
- Same: remove `slack_thread_ts` and `slackThreadTs` from `notifySlack()` calls

### 5. `supabase/functions/jac-search-agent/index.ts`
- Same cleanup

### 6. `supabase/functions/_shared/slack.ts`
- Remove `slackThreadTs` from the `SlackPayload` interface (line 18)
- The `notifySlack` function's `chat.postMessage` call already doesn't use `thread_ts` (from the previous fix), so no other changes needed there

## Deploy

After applying changes, deploy all 6 edge functions:
- `slack-incoming`
- `jac-dispatcher`
- `jac-research-agent`
- `jac-save-agent`
- `jac-search-agent`

(Note: `_shared/slack.ts` is not deployed separately -- it's bundled with the agents that import it)

## Result

All JAC replies will appear as normal messages in the Slack DM conversation, not as threaded replies.

