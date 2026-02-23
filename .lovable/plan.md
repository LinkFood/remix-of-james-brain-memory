

# Fix Build Error + Deploy Edge Functions

## Build Error Fix

The log backfill code (added in commit 3931c51) references `sessionData` in a separate `try` block from where it was declared. The variable is scoped to the first `try` block (line 57) and not accessible in the second `try` block (line 79).

**Fix:** Move the log backfill logic inside the first `try` block, right after the session data is loaded (after line 73, before the closing `catch` on line 75). This keeps `sessionData` in scope and is the simplest correct fix.

## Edge Function Deploys

Redeploy both updated edge functions:
- `jac-code-agent` (Slack notification formatting, brain save formatting)
- `jac-dispatcher` (general intent system prompt update)

## Steps

1. Move lines 79-101 (the log backfill `try/catch`) into the outer `try` block, placing it after line 73 and before line 75
2. Deploy `jac-code-agent` and `jac-dispatcher`
3. Verify build succeeds and `/code` terminal shows historical logs

