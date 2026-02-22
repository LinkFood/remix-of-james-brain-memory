

# Update Tavily API Key

## What
Replace the invalid `TAVILY_API_KEY` secret with the new key you provided.

## Steps
1. Update the `TAVILY_API_KEY` secret to: `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`
2. Test `jac-web-search` with a sample query to confirm the key works
3. If successful, run a full research query to validate the end-to-end flow

## Technical Details
- The secret is already configured; this is a value replacement
- No code changes needed -- the edge functions already reference `TAVILY_API_KEY` via `Deno.env.get()`
- After updating, `jac-web-search`, `jac-research-agent`, and Slack research commands will all start returning real web sources

