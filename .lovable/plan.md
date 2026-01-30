
# Mega Implementation Plan: LinkJac Roadmap to Greatness

This plan implements all remaining phases from the roadmap in one comprehensive update.

---

## Phase 1: Stability & Polish (Quick Fixes)

### 1.1 Fix Jac Loading Skeleton
**File:** `src/components/AssistantChat.tsx`

Add skeleton loading state while Jac is thinking:
- Show pulsing skeleton message bubble when `loading === true`
- Display "Jac is thinking..." placeholder text

### 1.2 Connect "Manage Subscription" to Stripe Portal
**File:** `src/pages/Settings.tsx`

Currently the "Manage Subscription" button does nothing (line 291-293). We need to:
- Create edge function `create-customer-portal-session` to generate Stripe billing portal URL
- Wire button to open portal in new tab

**New Edge Function:** `supabase/functions/create-customer-portal-session/index.ts`

---

## Phase 2: Core Experience Enhancement

### 2.1 Undo Toast for Saves
**File:** `src/components/dump/hooks/useDumpSave.ts`

After successful save, show an "Undo" toast that:
- Appears for 5 seconds with "Saved! Undo?" action button
- If clicked, deletes the just-created entry
- Requires passing entry ID back from `smart-save` response

**Implementation:**
```typescript
toast.success("Saved!", {
  action: {
    label: "Undo",
    onClick: async () => {
      await supabase.from('entries').delete().eq('id', entryId);
      // Remove from optimistic list
    },
  },
  duration: 5000,
});
```

### 2.2 Jac Loading Skeleton in AssistantChat
**File:** `src/components/AssistantChat.tsx`

When `loading === true`, render a skeleton message:
```tsx
{loading && (
  <div className="flex gap-3 p-4">
    <Skeleton className="h-8 w-8 rounded-full" />
    <div className="space-y-2 flex-1">
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  </div>
)}
```

---

## Phase 3: Calendar & Reminders Improvements

### 3.1 Color-Coded Calendar Dots
**File:** `src/components/CalendarView.tsx`

Change the single dot to color-coded based on content type:
- Events (event/reminder): Red dot
- Lists/todos with unchecked items: Blue dot
- Code: Purple dot
- Ideas: Yellow dot
- Default: Primary color

**Update DayContent component:**
```tsx
const getEntryDotColor = (entries: Entry[]) => {
  const types = entries.map(e => e.content_type);
  if (types.includes('reminder') || types.includes('event')) return 'bg-red-400';
  if (types.includes('list')) return 'bg-blue-400';
  if (types.includes('code')) return 'bg-purple-400';
  if (types.includes('idea')) return 'bg-yellow-400';
  return 'bg-primary';
};
```

### 3.2 Multi-Day Event Indicators
Show multiple dots when a date has multiple entries of different types.

---

## Phase 4: Jac Intelligence Upgrades

### 4.1 More Jac Suggestion Queries
**File:** `src/components/AssistantChat.tsx`

Add more dashboard-focused suggestions:
```typescript
const dashboardQueries = [
  "What patterns am I missing?",
  "Show me connections in my brain",
  "What have I been thinking about?",
  "Find orphan entries with no links",
  "What have I forgotten about?",     // NEW
  "Show me my most important items",  // NEW
  "What's overdue?",                   // NEW
];
```

### 4.2 Jac Proactive Insight Banner (Dashboard)
**New File:** `src/components/JacProactiveInsight.tsx`

A small banner at the top of the dashboard that appears periodically with proactive insights:
- "You haven't touched X in 2 weeks"
- "Your grocery list has 12 unchecked items"
- "You have 3 overdue reminders"

**Implementation:**
- Create hook `useProactiveInsights.ts` that fetches forgotten entries
- Show as a dismissible banner above DumpInput
- Only show if user hasn't dismissed today

---

## Phase 5: Power User Features

### 5.1 Archived View Toggle
**Files:** `src/pages/Dashboard.tsx`, `src/components/Dashboard.tsx`

Add toggle to view archived entries:
- Add "Show archived" checkbox in header
- Filter entries query based on toggle state
- Show archived entries with visual indicator (opacity, strikethrough)

**Implementation:**
```tsx
const [showArchived, setShowArchived] = useState(false);

// In fetch:
.eq('archived', showArchived ? true : false)
// OR for "include archived":
// remove the .eq('archived', false) filter when toggled
```

### 5.2 Restore from Archive
**File:** `src/components/EntryCard.tsx` and `EntryView.tsx`

When viewing an archived entry, show "Restore" button instead of "Archive":
```tsx
{entry.archived ? (
  <Button onClick={handleRestore}>
    <ArchiveRestore className="w-4 h-4" />
    Restore
  </Button>
) : (
  <Button onClick={handleArchive}>
    <Archive className="w-4 h-4" />
    Archive
  </Button>
)}
```

---

## Phase 6: Polish & Refinements

### 6.1 Entry Type Icons in More Places
Ensure consistent icons across:
- Dashboard sections
- Calendar entries
- Timeline view
- Search results

### 6.2 Improved Empty States
**File:** `src/components/dashboard/EmptyState.tsx`

Make empty state more engaging with:
- Different messages based on what's empty (no ideas vs no lists)
- Quick action buttons ("Dump your first idea", "Create a list")

---

## Implementation Files Summary

### Files to Create:
| File | Purpose |
|------|---------|
| `supabase/functions/create-customer-portal-session/index.ts` | Stripe billing portal |
| `src/components/JacProactiveInsight.tsx` | Proactive insight banner |
| `src/hooks/useProactiveInsights.ts` | Fetch forgotten/overdue entries |

### Files to Modify:
| File | Changes |
|------|---------|
| `src/components/dump/hooks/useDumpSave.ts` | Add Undo toast functionality |
| `src/components/AssistantChat.tsx` | Add loading skeleton, more suggestions |
| `src/components/CalendarView.tsx` | Color-coded dots by entry type |
| `src/pages/Dashboard.tsx` | Add show archived toggle, proactive insight banner |
| `src/components/Dashboard.tsx` | Pass through archived filter |
| `src/components/EntryView.tsx` | Add restore from archive option |
| `src/components/EntryCard.tsx` | Show archived visual indicator |
| `src/pages/Settings.tsx` | Connect manage subscription button |
| `supabase/config.toml` | Add new edge function |

---

## Technical Details

### Undo Toast Implementation
The sonner toast library already supports action buttons. We'll:
1. Store the newly created entry ID after save
2. Show toast with action callback
3. On "Undo" click, delete entry and trigger optimistic removal

### Stripe Customer Portal
Requires:
1. User's Stripe customer ID (store in subscriptions table or profiles)
2. Edge function to call `stripe.billingPortal.sessions.create()`
3. Return URL to redirect user

For now, since Stripe isn't fully wired, we'll:
- Show a placeholder message or
- Link to a Stripe customer portal setup flow

### Proactive Insights Logic
Query for:
```sql
-- Forgotten entries (older than 14 days, not starred, no recent activity)
SELECT * FROM entries
WHERE user_id = $1
  AND archived = false
  AND starred = false
  AND updated_at < NOW() - INTERVAL '14 days'
ORDER BY importance_score DESC
LIMIT 3;

-- Overdue items
SELECT * FROM entries
WHERE user_id = $1
  AND archived = false
  AND event_date < CURRENT_DATE
  AND content_type IN ('reminder', 'event')
LIMIT 5;

-- Unchecked list items (count)
SELECT COUNT(*) FROM entries
WHERE user_id = $1
  AND archived = false
  AND content_type = 'list'
  AND list_items::jsonb @> '[{"checked": false}]';
```

---

## Execution Order

1. **Undo toast** - Quick win, improves UX immediately
2. **Jac loading skeleton** - Simple visual polish
3. **More Jac suggestions** - Adds value to existing feature
4. **Color-coded calendar dots** - Visual enhancement
5. **Archived view toggle** - Power user feature
6. **Restore from archive** - Completes archive flow
7. **Proactive insights** - Advanced Jac feature
8. **Stripe portal** - Business feature (can be placeholder initially)

---

## Expected Outcomes

After this implementation:
- Save experience feels more forgiving with Undo option
- Jac looks smarter with loading states and more suggestions
- Calendar is more informative with color-coded dots
- Users can recover archived entries
- Jac proactively surfaces forgotten/overdue items
- Pro users can manage their subscription (or see placeholder)
