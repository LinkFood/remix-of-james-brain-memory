

# Fix Build Errors in jac-dispatcher (Commit f484066)

## Problem

The outer `catch` block (line 420) references `slack_thinking_ts` and `slack_channel` as standalone variables, but they only exist as properties on `body`, which is declared inside the `try` block. This causes 4 TypeScript errors.

## Fix

**File: `supabase/functions/jac-dispatcher/index.ts`**

Hoist two variables before the outer `try` block (after line 94, before line 95):

```typescript
let slackChannel: string | undefined;
let slackThinkingTs: string | undefined;
```

After `body` is parsed (~line 99), assign them:

```typescript
slackChannel = body.slack_channel;
slackThinkingTs = body.slack_thinking_ts;
```

Then update the catch block (lines 427-431) to use the hoisted variables:

```typescript
if (typeof slackThinkingTs === 'string' && typeof slackChannel === 'string' && botToken) {
  fetch('https://slack.com/api/chat.update', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${botToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: slackChannel, ts: slackThinkingTs, text: ':x: Something went wrong. Try again.' }),
  }).catch(() => {});
}
```

## Deploy

After fixing, deploy:
- `slack-incoming`
- `jac-dispatcher`
- `jac-web-search`

## Test

Run the 4 tests from the commit notes (retry dedup, research quality, stale task cleanup, error handling).

