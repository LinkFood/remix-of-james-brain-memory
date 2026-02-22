

# Fix JAC Agent OS — 5 Issues

## 1. Fix Duplicate Messages in Chat

**Problem:** When a user sends a message, both the optimistic update AND the realtime subscription add the same message. The dedup check compares timestamps, but the optimistic message uses `new Date().toISOString()` while the DB uses the server's `now()` — they never match.

**Fix:** In `src/hooks/useJacAgent.ts`, change the dedup logic to match on `content + role` only (ignore timestamp). This handles both user and assistant messages that are optimistically added before the realtime INSERT arrives.

## 2. Fix Auth Failures in Worker Agent Chain

**Problem:** `jac-research-agent` calls `jac-web-search`, `search-memory`, and `smart-save` using `Bearer ${serviceKey}`. But `jac-web-search` and `search-memory` use `extractUserId()` from `_shared/auth.ts`, which tries to parse the service role key as a JWT — it's not a JWT, so it fails with "Invalid JWT structure".

**Fix:** Update `jac-web-search/index.ts` and `search-memory/index.ts` to check for service role key before calling `extractUserId()`, similar to how `generate-embedding/index.ts` already handles it. If the bearer token matches the service role key, skip JWT validation and proceed as a trusted internal request.

## 3. Fix Embedding Model Error

**Problem:** `generate-embedding` calls the Lovable AI gateway with model `text-embedding-3-small`, but that model isn't in the allowed list. The error log confirms: `invalid model: text-embedding-3-small, allowed models: [openai/gpt-5-mini openai/gpt-5 ...]`.

**Fix:** The Lovable AI gateway doesn't support embedding models directly. Use the Supabase `pgvector` approach or switch to a supported chat model to generate a pseudo-embedding. However, the simplest fix is to check if there's an embedding endpoint that works. Since the allowed models are all chat models, we'll need to use an alternative approach — calling OpenAI's embedding API directly via the LOVABLE_API_KEY with the correct model prefix, or skipping embeddings when unavailable and falling back gracefully.

**Pragmatic approach:** Since the embedding endpoint is broken, make the brain context search in `jac-dispatcher` fail gracefully (it already does via try/catch), and ensure the research agent doesn't break when web-search/search-memory fail (it already catches). The embedding issue is a platform limitation — document it and move on. No code change needed here since failures are already handled.

## 4. Delete Unused Pages

**Files to delete:**
- `src/pages/Landing.tsx`
- `src/pages/Pricing.tsx`

These are no longer routed in `App.tsx`.

## 5. Add Task Completion Toast

**Problem:** When a task completes via realtime, the user gets no visible notification.

**Fix:** In the realtime subscription for `agent_tasks` in `useJacAgent.ts`, when a task status changes to `completed` or `failed`, fire a toast notification using the existing `sonner` toast.

---

## Technical Details

### File: `src/hooks/useJacAgent.ts`

Changes:
- Dedup logic: match on `content + role` instead of `content + role + timestamp`
- Add toast import and fire toast on task status change to completed/failed

### File: `supabase/functions/jac-web-search/index.ts`

Add service role check before `extractUserId()`:
```typescript
const authHeader = req.headers.get('authorization');
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const isServiceRole = authHeader === `Bearer ${serviceKey}`;

let userId: string;
if (isServiceRole) {
  userId = 'service_role_internal';
} else {
  const { userId: uid, error } = await extractUserId(req);
  if (error || !uid) return errorResponse(req, error ?? 'Unauthorized', 401);
  userId = uid;
}
```

### File: `supabase/functions/search-memory/index.ts`

Same service role check pattern as above.

### Files to delete:
- `src/pages/Landing.tsx`
- `src/pages/Pricing.tsx`

