

# Fix Slack DM Round-Trip: Two Bugs Found

## Bug 1: Signature Verification Failing (Primary Blocker)

Every incoming Slack event hits `[slack-incoming] Invalid signature` and gets rejected with 401. The `jac-dispatcher` never gets called.

**Root cause**: The signature verification is likely failing due to the `SLACK_SIGNING_SECRET` value being incorrect or stale. However, to make debugging easier and ensure we can see what's happening, we should add diagnostic logging to the signature check.

**Fix**: Add logging in `slack-incoming` to print the timestamp header and whether it's present, so we can see if Slack is sending the expected headers. Also add a log before and after the HMAC comparison to narrow down the failure point.

If the secret is correct but verification still fails, there may be a subtle encoding issue. We should add a temporary bypass with logging to confirm the rest of the pipeline works, then circle back to fix the signature check.

**Approach**: 
1. Add detailed debug logging to `verifySlackSignature` (log timestamp, whether signature header exists, first 10 chars of computed vs received signature)
2. Deploy and have you send another test message
3. Use the logs to determine if it's a wrong secret or a computation bug

## Bug 2: jac-dispatcher Auth Rejects Service Role Calls

Even if Bug 1 is fixed, the dispatcher will fail. Here's why:

- `slack-incoming` calls `jac-dispatcher` with `Authorization: Bearer ${serviceKey}` (the service role key)
- `jac-dispatcher` uses `extractUserId(req)` on line 93, which tries to validate this as a user JWT
- The service role key is NOT a user JWT, so `getClaims()` or `getUser()` will fail
- The dispatcher returns 401 and the message is silently dropped

**Fix**: Change `jac-dispatcher` to use `extractUserIdWithServiceRole(req, body)` instead of `extractUserId(req)`. This existing helper (in `_shared/auth.ts` line 120) checks if the request is a service role call, and if so, reads the `userId` from the request body instead. 

This also requires `slack-incoming` to pass `userId` in the body when dispatching. Currently it doesn't.

## Changes Required

### File 1: `supabase/functions/slack-incoming/index.ts`

- Add `userId` to the dispatch body (line 124-129) so `jac-dispatcher` can identify the user when receiving a service-role call
- Add debug logging to the signature verification to diagnose the failure

### File 2: `supabase/functions/jac-dispatcher/index.ts`

- Change line 93 from `extractUserId(req)` to `extractUserIdWithServiceRole(req, body)` 
- This requires reading the body BEFORE the auth check, so reorder slightly: parse body first, then auth with body passed in
- Import `extractUserIdWithServiceRole` instead of (or in addition to) `extractUserId`

### File 3: `supabase/functions/_shared/auth.ts`

No changes needed — `extractUserIdWithServiceRole` already exists and handles this pattern.

## Execution Order

1. Fix `slack-incoming` — add userId to dispatch payload + debug logging for signature
2. Fix `jac-dispatcher` — switch to `extractUserIdWithServiceRole`
3. Deploy both functions
4. Check logs after you send another test DM
5. If signature still fails, use the debug logs to determine whether to re-enter the signing secret

