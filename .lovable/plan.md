

# Fix: Slack URL Verification Challenge Failing

## The Problem

The logs show: `[slack-incoming] Invalid signature` -- the function rejects Slack's challenge request before it ever reaches the challenge handler on line 67.

The signature verification runs FIRST (line 58), fails, and returns 401. The challenge handler on line 67 never executes.

## The Fix

Move the `url_verification` challenge check BEFORE the signature verification. This is safe because:
- The challenge is a one-time handshake only used during app setup
- Once verified, Slack never sends it again
- All actual event callbacks still go through full signature verification

## File Change

**`supabase/functions/slack-incoming/index.ts`**

Reorder the logic so after reading `rawBody`, we parse it first, check if it's a `url_verification` challenge (respond immediately), and THEN do signature verification for everything else.

Specifically:
1. Read `rawBody` (line 53) -- keep as-is
2. Parse JSON immediately after reading the body
3. If `payload.type === 'url_verification'`, respond with `{ challenge: payload.challenge }` right away -- no signature check needed
4. For all other request types, proceed with signature verification as before

## After This Change

1. Deploy the updated `slack-incoming` function
2. Go back to your Slack app's Event Subscriptions page
3. Click **Retry** next to the Request URL
4. It should show a green checkmark -- "Verified"
5. Then add your bot events (`message.im`, `app_mention`) and save

