

# Fix: Send Slack Reply for General Intent Messages

## The Real Problem

The entire pipeline is actually working correctly now:
- Slack signature verification: PASSING
- Profile lookup: FOUND
- Dispatcher processing: WORKING (returned 200, created task, generated response)
- AI response generated: "Yes, this is working! I can see your test #4..."

But **LinkJac never replies in Slack** because the `jac-dispatcher` doesn't send Slack messages for `general` intent. It marks the task as completed and returns the response in the HTTP body (which only the web UI uses). The worker agents (research, save, search) handle their own Slack replies, but `general` has no worker.

## Solution

Add a Slack reply in `jac-dispatcher` for `general` intent when the message came from Slack. After marking the task complete, use the `SLACK_BOT_TOKEN` to post the AI response back in the original Slack thread.

## Changes

### 1. `supabase/functions/jac-dispatcher/index.ts`

In the `else if (intent === 'general')` block (around line 352), after marking the task completed, add code to reply in Slack:

```text
} else if (intent === 'general') {
  // Mark parent as completed immediately
  await supabase
    .from('agent_tasks')
    .update({ status: 'completed', completed_at: new Date().toISOString() })
    .eq('id', parentTask.id);

  // NEW: Reply in Slack if message came from Slack
  if (slack_channel && slack_thread_ts) {
    const botToken = Deno.env.get('SLACK_BOT_TOKEN');
    if (botToken) {
      fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${botToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          channel: slack_channel,
          thread_ts: slack_thread_ts,
          text: response,
        }),
      }).then(async (res) => {
        if (res.ok) {
          await supabase.from('agent_tasks')
            .update({ slack_notified: true })
            .eq('id', parentTask.id);
        }
      }).catch(err => {
        console.warn('[jac-dispatcher] Slack reply failed:', err);
      });
    }
  }
}
```

This uses the same `SLACK_BOT_TOKEN` that already exists in your secrets. It replies in the same Slack thread the user sent the message from.

## Why Previous Fixes Didn't Help

| What we tried | Status | Why it wasn't enough |
|---|---|---|
| Fixed signing secret | Working | Signature now verifies correctly |
| Inserted profile row | Working | Profile lookup now succeeds |
| **Slack reply for general** | **Missing** | **This is the actual gap** |

## No Database Changes Needed

Only one file changes: `supabase/functions/jac-dispatcher/index.ts`

