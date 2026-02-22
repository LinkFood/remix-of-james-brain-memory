

# JAC Agent OS — Launch Polish Plan

Three batches of fixes, tested between each batch. Each batch builds on the last.

---

## Batch 1: Fix Embeddings + Search (Critical)

The `generate-embedding` function calls `text-embedding-3-small` on the Lovable AI gateway, which only supports chat models -- not embedding models. Every embedding call fails with a 400 error, breaking all semantic search.

**Strategy**: Since Lovable AI doesn't support embedding models and adding another API key (OpenAI) adds complexity, the fix is to make the system work great WITHOUT embeddings by strengthening keyword search, while making embedding failures non-blocking everywhere.

### Changes

**1. `supabase/functions/generate-embedding/index.ts`**
- Replace the Lovable AI `/v1/embeddings` call with a call to Claude Haiku (via the existing Anthropic API key) that extracts a list of semantic keywords/tags from the text
- Use those keywords to build a lightweight "pseudo-embedding" -- or simpler: just return an error gracefully so callers fall back to keyword search
- Simplest approach: return a clear `501 Not Implemented` with a message, so all callers cleanly fall back

**2. `supabase/functions/search-memory/index.ts`**
- The semantic search path (lines 126-161) already has a try/catch that falls back to keyword search -- this is good
- Improve keyword search: also search with individual words from the query (not just exact phrase), which the tag search already does partially
- Add `ilike` matching for individual significant words to catch more results

**3. `supabase/functions/jac-dispatcher/index.ts`**
- Brain context search (lines 158-189) calls `generate-embedding` which always fails -- the `catch` already handles this gracefully (`brainContext` stays empty)
- No code changes needed here, it already handles the failure

**4. `supabase/functions/backfill-embeddings/index.ts`**
- Skip processing since embeddings aren't available -- add a check at the top that returns early with a message like "Embedding generation is not currently available"

### Deploy + Test
- Deploy: `generate-embedding`, `search-memory`, `backfill-embeddings`
- Test: Send "save this: Claude Code is the best IDE" then "search for Claude Code" -- should find it via keyword search
- Test: Research flow should still work (web search + keyword brain search + synthesis)

---

## Batch 2: Fix Duplicate Messages (High)

The duplicate message bug: when `sendMessage()` runs, it adds an optimistic assistant message to state. Then the dispatcher saves the same message to `agent_conversations`, which triggers a Realtime INSERT, which adds it again. The dedup logic only checks exact timestamp match (line 168), which fails because the optimistic message uses `new Date().toISOString()` (client time) while the DB uses `now()` (server time).

Worker agents (save, search, research) ALSO insert result messages into `agent_conversations` (e.g., "Saved to brain: ..."), causing a third message to appear via Realtime.

### Changes

**1. `src/hooks/useJacAgent.ts` -- Realtime dedup (lines 166-188)**
- Extend the dedup logic to also handle assistant messages: if a Realtime INSERT arrives for an assistant message whose content matches an existing assistant message within a 30s window, skip it
- This covers both the optimistic response and the worker result messages

**2. `src/hooks/useJacAgent.ts` -- sendMessage (lines 283-289)**
- Don't add the assistant response optimistically from the fetch response. Instead, let only the Realtime subscription handle assistant messages. This eliminates the root cause of duplicates.
- Alternative (simpler): keep the optimistic add but mark it with a flag, and in the Realtime handler, replace the optimistic message with the DB version (using content matching)

**Chosen approach**: Remove the optimistic assistant message add from `sendMessage()`. The dispatcher already saves the assistant message to `agent_conversations`, so the Realtime subscription will pick it up within ~100ms. This is fast enough and eliminates all duplicates.

### Deploy + Test
- No edge function changes -- frontend only
- Test: Send "Hey JAC" -- should see exactly ONE response, no duplicates
- Test: Send "save this: test note" -- should see JAC acknowledgment once, then Scribe result once
- Test: Send "search for test" -- same, no duplicates

---

## Batch 3: Stale Task Cleanup + UI Polish (Medium/Low)

### Changes

**1. `src/hooks/useJacAgent.ts` -- Stale task cleanup on load**
- In `loadInitial()`, after loading tasks, find any tasks stuck in `queued` or `running` for more than 5 minutes
- Update them to `failed` with error "Task timed out" via a Supabase update call
- This prevents the "1 AGENT ACTIVE" ghost state

**2. `src/components/jac/AgentRoster.tsx` -- "Coming Soon" badges**
- For `jac-report-agent` (Analyst) and `jac-monitor-agent` (Sentinel), add a "Coming Soon" badge overlay
- Reduce opacity further and disable the click handler for these agents

**3. `src/components/InstallPrompt.tsx` -- Auto-dismiss or route-aware**
- Hide the install prompt on the `/jac` page, or auto-dismiss after 5 seconds

### Deploy + Test
- No edge function changes -- frontend only
- Test: Visit /jac, verify no stale "active" agents
- Test: Verify Analyst and Sentinel show "Coming Soon"
- Test: Full end-to-end: save -> search -> research flows all work cleanly

---

## Summary

| Batch | Scope | Files Changed | Deploy |
|-------|-------|---------------|--------|
| 1 | Fix embeddings/search | `generate-embedding`, `search-memory`, `backfill-embeddings` | Edge functions |
| 2 | Fix duplicate messages | `useJacAgent.ts` | Frontend only |
| 3 | Stale cleanup + polish | `useJacAgent.ts`, `AgentRoster.tsx`, `InstallPrompt.tsx` | Frontend only |

Each batch is independently testable. We test after each before moving to the next.

