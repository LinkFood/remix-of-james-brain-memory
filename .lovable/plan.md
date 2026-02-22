

# Fix: Re-enter SLACK_SIGNING_SECRET (Wrong Value Stored)

## Problem

The `slack-incoming` edge function rejects every Slack message with "Invalid signature" because the `SLACK_SIGNING_SECRET` stored in backend secrets is incorrect.

**Evidence**: The logs show `secret length: 81`. A real Slack signing secret is approximately 32 characters long. The stored value is 81 characters, which means extra content was accidentally included when it was first entered (perhaps the full line from the Slack config page, surrounding quotes, or whitespace).

Because the HMAC key is wrong, the computed signature never matches Slack's signature, so every message is rejected at the door. The dispatcher and agents never get called.

## Fix

1. **Re-enter the correct `SLACK_SIGNING_SECRET`** — Go to your Slack app settings at https://api.slack.com/apps, select your LinkJac app, navigate to "Basic Information", and copy ONLY the "Signing Secret" value (should be ~32 hex characters, no quotes or spaces).
2. **Update the secret** in the backend using the secret management tool.
3. **Send another test DM** to LinkJac to confirm the signature now verifies and the full pipeline works.

No code changes are needed. The signature verification logic, dispatcher auth fix, and userId passing are all correct. The only issue is the wrong secret value.

## What Happens After the Fix

Once the signing secret is correct:
- Slack sends a message event to `slack-incoming`
- Signature verification passes
- `slack-incoming` looks up your user profile, dispatches to `jac-dispatcher` with your userId
- `jac-dispatcher` authenticates via service role + userId in body (already fixed)
- Claude parses intent, creates tasks, dispatches worker agent
- Worker completes, `notifySlack` replies in your Slack thread using the bot token

