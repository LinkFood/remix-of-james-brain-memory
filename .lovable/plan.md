

# Apply "Thinking..." Update-in-Place (Commit 6da8691)

Currently, the "Thinking..." message and the real response are two separate messages. This fix makes JAC post "Thinking..." first, capture its Slack timestamp, pipe it through the whole chain, and then use `chat.update` to replace it with the real answer -- one message, not two.

## Changes (6 files)

### 1. `supabase/functions/slack-incoming/index.ts`
Replace the `:brain:` emoji reaction (lines 120-134) with an awaited `chat.postMessage` that posts "_Thinking..._" and captures the returned `ts`. Pass `slack_thinking_ts` in the dispatch payload to `jac-dispatcher`.

### 2. `supabase/functions/jac-dispatcher/index.ts`
- Add `slack_thinking_ts` to the body type (line 97)
- Destructure `slack_thinking_ts` from body
- Include it in child task input (line 299)
- Include it in worker dispatch body (line 333)
- For general intent Slack reply (line 369): use `chat.update` with the thinking `ts` when available, fall back to `chat.postMessage` otherwise

### 3. `supabase/functions/_shared/slack.ts`
- Add `slackThinkingTs?: string` to `SlackPayload` interface (line 17)
- In bot token path (line 48): when `slackThinkingTs` is present, use `chat.update` with `ts: slackThinkingTs` instead of `chat.postMessage`

### 4. `supabase/functions/jac-research-agent/index.ts`
- Add `let slackThinkingTs: string | undefined;` after line 41
- Read `slackThinkingTs = body.slack_thinking_ts` after line 51
- Add `slackThinkingTs` to both `notifySlack` calls (lines 262 and 324)

### 5. `supabase/functions/jac-save-agent/index.ts`
- Add `let slackThinkingTs: string | undefined;` after line 34
- Read `slackThinkingTs = body.slack_thinking_ts` after line 43
- Add `slackThinkingTs` to both `notifySlack` calls (lines 128 and 189)

### 6. `supabase/functions/jac-search-agent/index.ts`
- Add `let slackThinkingTs: string | undefined;` after line 34
- Read `slackThinkingTs = body.slack_thinking_ts` after line 43
- Add `slackThinkingTs` to both `notifySlack` calls (lines 142 and 206)

## Deploy

All 6 edge functions:
- `slack-incoming`
- `jac-dispatcher`
- `jac-research-agent`
- `jac-save-agent`
- `jac-search-agent`
- `search-memory`

## Expected Result

Every Slack DM to LinkJac produces exactly ONE message that starts as "_Thinking..._" then transforms in-place into the real answer. No duplicate messages.

