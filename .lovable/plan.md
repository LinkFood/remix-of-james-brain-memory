
# Fix Build Errors: `slack_channel` Out of Scope in Catch Blocks

## Problem

All 3 worker agents declare `slack_channel` with `const` inside a `try` block, but their `catch` blocks also reference `slack_channel` for error notifications. Since `const` is block-scoped, it's not visible in the `catch`.

## Fix (identical pattern in 3 files)

### 1. `supabase/functions/jac-research-agent/index.ts`
- Add `let slackChannel: string | undefined;` next to the other hoisted variables (after line 41)
- Change line 50 from `const slack_channel = body.slack_channel as string | undefined;` to `slackChannel = body.slack_channel as string | undefined;`
- Update both `notifySlack` calls (lines 261, 323) from `slackChannel: slack_channel` to `slackChannel: slackChannel` (already named correctly, just the variable changes)

### 2. `supabase/functions/jac-save-agent/index.ts`
- Add `let slackChannel: string | undefined;` after line 34
- Change line 42 from `const slack_channel = ...` to `slackChannel = body.slack_channel as string | undefined;`
- Update both `notifySlack` calls (lines 127, 188) to use `slackChannel` instead of `slack_channel`

### 3. `supabase/functions/jac-search-agent/index.ts`
- Add `let slackChannel: string | undefined;` after line 34
- Change line 42 from `const slack_channel = ...` to `slackChannel = body.slack_channel as string | undefined;`
- Update both `notifySlack` calls (lines 141, 205) to use `slackChannel` instead of `slack_channel`

## Deploy

After fixing, deploy all 5 edge functions:
- `jac-research-agent`
- `jac-save-agent`
- `jac-search-agent`
- `jac-dispatcher`
- `slack-incoming`
- `search-memory`

Then run the 4 Slack tests from the commit notes to verify everything works end-to-end.
