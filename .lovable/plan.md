

# Deploy 3 Updated Edge Functions

## Summary
All code changes from the latest push are already in the codebase. No database migrations or schema changes are needed. The only action is deploying 3 backend functions so the live versions reflect the new code.

## What gets deployed

1. **slack-incoming** -- Now persists `slack_channel_id` to `user_settings` on every incoming Slack message (merge-upsert, non-blocking). This ensures `calendar-reminder-check` can find the user's Slack channel even if their last interaction was from the web UI.

2. **jac-dispatcher** -- Now imports `getUserContext()` from `_shared/context.ts` and injects the user's schedule (today's events, overdue items, upcoming week) into the general-intent system prompt. Calendar/schedule queries route to "general" (assistant-chat) with full context.

3. **calendar-reminder-check** -- Already deployed previously, but redeploying ensures it picks up the latest `_shared/context.ts` and `_shared/slack.ts` shared modules.

The shared module `_shared/context.ts` deploys automatically with any function that imports it.

## No other changes needed
- No migrations (user_settings table and entries columns already exist)
- No new secrets (SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET already configured)
- No RLS changes (edge functions use service role key)
- No frontend changes

## Technical steps
1. Deploy `slack-incoming`
2. Deploy `jac-dispatcher`
3. Deploy `calendar-reminder-check`

All three can be deployed in parallel.

