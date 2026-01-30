
# Fix: Jac Dashboard Query Suggestions Failing

## Problem Identified

When you click one of the suggested queries in the Jac assistant (like "What patterns do you see?"), the request fails with a 404 error because the `jac-dashboard-query` edge function **exists in code but is NOT deployed**.

### Root Cause

The edge function was created in the codebase at `supabase/functions/jac-dashboard-query/index.ts`, but it was never deployed to the Supabase backend. When the app tries to call it, it gets:

```
404 NOT_FOUND: Requested function was not found
```

### How It Fails

1. User clicks a suggestion like "Find patterns" or types a pattern-related query
2. The `isDashboardQuery()` function detects it as a dashboard transformation query
3. It routes to `onJacDashboardQuery(text)` which calls `useJacDashboard.sendQuery()`
4. The hook tries to fetch `/functions/v1/jac-dashboard-query`
5. Response: 404 - function not found
6. Toast shows "Jac couldn't process that"

---

## Solution

**Deploy the existing edge function.** The code is already complete and well-structured - it just needs to be deployed.

---

## Technical Details

### Files Already in Place (no changes needed)

| File | Status |
|------|--------|
| `supabase/functions/jac-dashboard-query/index.ts` | Complete, ready to deploy |
| `src/hooks/useJacDashboard.ts` | Working, calls the function |
| `src/components/JacInsightCard.tsx` | UI ready |
| `src/components/Dashboard.tsx` | Integration ready |

### What the Function Does

When deployed, `jac-dashboard-query` will:
1. Fetch user's recent entries (up to 50)
2. Fetch entry relationships for pattern detection
3. Send to AI with structured output request
4. Return dashboard transformation commands:
   - `highlightEntryIds` - entries to glow/pulse
   - `connections` - lines between related entries
   - `clusters` - groupings by theme
   - `insightCard` - Jac's insight to display
   - `surfaceEntryIds` - entries to bring to top

---

## Implementation

### Step 1: Deploy the Edge Function

The function at `supabase/functions/jac-dashboard-query/index.ts` needs to be deployed.

### Step 2: Test the Flow

After deployment:
1. Open Jac assistant
2. Click "Find patterns" suggestion or ask "What patterns do you see?"
3. Should see JacInsightCard appear on dashboard
4. Relevant entries should highlight

---

## Expected Result After Fix

**Before:** Click suggestion → "Jac couldn't process that" error toast

**After:** Click suggestion → Jac Insight Card appears on dashboard showing patterns, with relevant entries highlighted

