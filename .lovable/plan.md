
# Fix Build Errors: `rateLimit` Scope Issue

## Problem

In both `jac-web-search/index.ts` and `search-memory/index.ts`, the variable `rateLimit` is declared inside an `if (!isInternal)` block at the top, but referenced at the bottom when calling `successResponse(req, ..., 200, rateLimit)`. When a request comes from a service role (internal agent call), the code skips the rate limit block, so `rateLimit` is never defined -- causing a TypeScript error.

## Fix

Declare `rateLimit` before the `if` block with a default value, so it's always in scope.

### `supabase/functions/jac-web-search/index.ts` (line ~90)

Change from:
```typescript
const isInternal = isServiceRoleRequest(req);
if (!isInternal) {
  const rateLimit = checkRateLimit(userId, RATE_LIMIT_CONFIGS.search);
```

To:
```typescript
const isInternal = isServiceRoleRequest(req);
let rateLimit: ReturnType<typeof checkRateLimit> | undefined;
if (!isInternal) {
  rateLimit = checkRateLimit(userId, RATE_LIMIT_CONFIGS.search);
```

### `supabase/functions/search-memory/index.ts` (line ~63)

Same pattern -- hoist the `rateLimit` declaration above the `if` block.

### Redeploy

Both `jac-web-search` and `search-memory` edge functions need redeployment after the fix.

## Files Changed

| File | Change |
|------|--------|
| `supabase/functions/jac-web-search/index.ts` | Hoist `rateLimit` declaration |
| `supabase/functions/search-memory/index.ts` | Hoist `rateLimit` declaration |
