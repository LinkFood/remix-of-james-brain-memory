

# Store Slack Bot Token + Test End-to-End

## Step 1: Store the Bot Token
Store `SLACK_BOT_TOKEN` with value `xoxb-10560308463476-10558761354466-Yz8kC68gzkX0e6qiBSaIpjYC` as a backend secret so the `_shared/slack.ts` module can use it for thread-aware replies.

## Step 2: Verify Edge Function is Ready
Check `slack-incoming` edge function logs to confirm it's deployed and booted. Also verify `jac-dispatcher` is deployed since that's what `slack-incoming` calls.

## Step 3: Send a Test Message via Slack API
Use the bot token to call `chat.postMessage` to your Slack DM to confirm JAC can talk to you. This tests the outbound path.

## Step 4: Confirm Inbound Path
Once you receive the test message, you can DM the bot in Slack (e.g. "Research AI agents") to test the full round-trip:
- You send message in Slack
- `slack-incoming` receives it, verifies signature, dispatches to `jac-dispatcher`
- `jac-dispatcher` parses intent, spawns agent
- Agent completes, `notifySlack` replies in your Slack thread

## Technical Details
- The bot token is used in `_shared/slack.ts` (line ~97) via `Deno.env.get('SLACK_BOT_TOKEN')` for thread replies
- `slack-incoming` looks up your user ID from the `profiles` table (single-user app)
- The dispatcher passes `slack_channel` and `slack_thread_ts` through to worker agents

