
# LinkJac Roadmap: Revised Implementation Plan

After reviewing your latest code changes, I can see you've made significant progress! Here's what's already done vs. what still needs building.

---

## Already Built (No Action Needed)

| Feature | Status | Where |
|---------|--------|-------|
| Jac Dashboard Query engine | Complete | `jac-dashboard-query/index.ts`, `useJacDashboard.ts` |
| JacInsightCard with loading state | Complete | `JacInsightCard.tsx` (includes skeleton/loader) |
| Connection lines overlay | Complete | `ConnectionLines.tsx` |
| Jac surfaced entries ("Jac Found" section) | Complete | `Dashboard.tsx` lines 381-404 |
| Keyboard shortcuts modal | Complete | `KeyboardShortcutsModal.tsx` |
| Icon differentiation (Clock vs Calendar) | Complete | `Dashboard.tsx` - separate icons |
| Entry cluster labels | Complete | `EntryCard.tsx` - `clusterLabel` prop |
| Highlighted entry ring/glow | Complete | `EntryCard.tsx` line 112 |
| Schedule editing in EntryView | Complete | `EntryView.tsx` - date/time/reminder/recurrence |
| Edge function warmup on mount | Complete | `Dashboard.tsx` lines 77-107 |
| Bulk selection via Jac | Complete | `handleSelectEntries` callback |

---

## Still Needs Building

### Phase 1: Quick Wins (Stability & Polish)

#### 1.1 Undo Toast for Saves
**File:** `src/components/dump/hooks/useDumpSave.ts`

After successful save, show toast with "Undo" action button that deletes the just-created entry.

**Changes:**
- Import `supabase` client
- After `toast.success()`, use sonner's action callback
- On click, delete entry by ID and remove from optimistic list

```typescript
toast.success(successMessage, {
  description: ...,
  action: {
    label: "Undo",
    onClick: async () => {
      const entryId = data.entry?.id;
      if (entryId) {
        await supabase.from('entries').delete().eq('id', entryId);
        if (onOptimisticFail) onOptimisticFail(tempId || entryId);
        toast.info("Entry deleted");
      }
    },
  },
  duration: 5000,
});
```

#### 1.2 More Jac Suggested Queries  
**File:** `src/components/AssistantChat.tsx`

Current `dashboardQueries` array has 4 items. Add 3 more:

```typescript
const dashboardQueries = [
  "What patterns am I missing?",
  "Show me connections in my brain",
  "What have I been thinking about?",
  "Find orphan entries with no links",
  "What have I forgotten about?",      // NEW
  "Show me my most important items",   // NEW
  "What's overdue?",                    // NEW
];
```

#### 1.3 Jac Loading Skeleton in Chat
**File:** `src/components/AssistantChat.tsx`

When `loading === true`, show a skeleton message bubble before streaming starts.

**Add to imports:**
```typescript
import { Skeleton } from "@/components/ui/skeleton";
```

**Add in messages render area when loading:**
```tsx
{loading && messages[messages.length - 1]?.role !== 'assistant' && (
  <div className="flex gap-3 p-4">
    <Skeleton className="h-8 w-8 rounded-full shrink-0" />
    <div className="space-y-2 flex-1">
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  </div>
)}
```

---

### Phase 2: Calendar Enhancements

#### 2.1 Color-Coded Calendar Dots
**File:** `src/components/CalendarView.tsx`

Change the single primary-colored dot to reflect entry types on that date.

**Add helper function:**
```typescript
const getEntryDotColors = (entries: Entry[]): string[] => {
  const colors = new Set<string>();
  entries.forEach(e => {
    if (e.content_type === 'reminder' || e.content_type === 'event') {
      colors.add('bg-red-400');
    } else if (e.content_type === 'list') {
      colors.add('bg-blue-400');
    } else if (e.content_type === 'code') {
      colors.add('bg-purple-400');
    } else if (e.content_type === 'idea') {
      colors.add('bg-yellow-400');
    } else {
      colors.add('bg-primary');
    }
  });
  return Array.from(colors).slice(0, 3); // Max 3 dots
};
```

**Update DayContent component to show multiple colored dots:**
```tsx
DayContent: ({ date }) => {
  const dateEntries = entries.filter(e => 
    e.event_date && isSameDay(new Date(e.event_date), date)
  );
  const dotColors = getEntryDotColors(dateEntries);
  
  return (
    <div className="relative w-full h-full flex items-center justify-center">
      {date.getDate()}
      {dotColors.length > 0 && (
        <div className="absolute bottom-0 left-1/2 -translate-x-1/2 flex gap-0.5">
          {dotColors.map((color, i) => (
            <span key={i} className={`w-1 h-1 rounded-full ${color}`} />
          ))}
        </div>
      )}
    </div>
  );
}
```

---

### Phase 3: Archive Management

#### 3.1 Show Archived Toggle
**File:** `src/components/Dashboard.tsx`

Add state and UI to toggle viewing archived entries.

**Add state:**
```typescript
const [showArchived, setShowArchived] = useState(false);
```

**Add toggle below QuickStats:**
```tsx
<div className="flex items-center justify-between">
  <TagFilter ... />
  <div className="flex items-center gap-2">
    <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
      <Checkbox
        checked={showArchived}
        onCheckedChange={(c) => setShowArchived(c as boolean)}
      />
      Show archived
    </label>
  </div>
</div>
```

**Update useEntries hook call** (or filter locally):
Pass `showArchived` to the hook or filter entries in useMemo.

#### 3.2 Restore from Archive Button
**File:** `src/components/EntryView.tsx`

When entry is archived, show "Restore" instead of "Archive".

**Add restore handler:**
```typescript
const handleRestore = async () => {
  try {
    const { data, error } = await supabase
      .from("entries")
      .update({ archived: false })
      .eq("id", entry.id)
      .select()
      .single();
    if (error) throw error;
    toast.success("Restored");
    if (onUpdate && data) onUpdate(toEntry(data));
  } catch (error) {
    toast.error("Failed to restore");
  }
};
```

**Update button render:**
```tsx
{entry.archived ? (
  <Button variant="ghost" size="icon" onClick={handleRestore}>
    <ArchiveRestore className="w-4 h-4" />
  </Button>
) : (
  <Button variant="ghost" size="icon" onClick={handleArchive}>
    <Archive className="w-4 h-4" />
  </Button>
)}
```

**Import ArchiveRestore from lucide-react.**

---

### Phase 4: Proactive Jac Insights

#### 4.1 Create Proactive Insights Hook
**New File:** `src/hooks/useProactiveInsights.ts`

Queries for forgotten/overdue entries to show a banner.

```typescript
import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";

interface ProactiveInsight {
  type: 'forgotten' | 'overdue' | 'unchecked';
  message: string;
  count: number;
  entryIds: string[];
}

export function useProactiveInsights(userId: string | undefined) {
  const [insight, setInsight] = useState<ProactiveInsight | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!userId || dismissed) return;
    
    // Check localStorage for today's dismissal
    const dismissKey = `jac-insight-dismissed-${new Date().toDateString()}`;
    if (localStorage.getItem(dismissKey)) {
      setDismissed(true);
      return;
    }

    const checkInsights = async () => {
      // Check for overdue reminders/events
      const today = new Date().toISOString().split('T')[0];
      const { data: overdue } = await supabase
        .from('entries')
        .select('id')
        .eq('user_id', userId)
        .eq('archived', false)
        .lt('event_date', today)
        .in('content_type', ['reminder', 'event'])
        .limit(10);

      if (overdue && overdue.length > 0) {
        setInsight({
          type: 'overdue',
          message: `You have ${overdue.length} overdue item${overdue.length > 1 ? 's' : ''}`,
          count: overdue.length,
          entryIds: overdue.map(e => e.id),
        });
        return;
      }

      // Check for forgotten entries (not touched in 14 days)
      const twoWeeksAgo = new Date();
      twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
      const { data: forgotten } = await supabase
        .from('entries')
        .select('id, title')
        .eq('user_id', userId)
        .eq('archived', false)
        .eq('starred', false)
        .lt('updated_at', twoWeeksAgo.toISOString())
        .order('importance_score', { ascending: false })
        .limit(3);

      if (forgotten && forgotten.length > 0) {
        setInsight({
          type: 'forgotten',
          message: `"${forgotten[0].title || 'Untitled'}" hasn't been touched in 2 weeks`,
          count: forgotten.length,
          entryIds: forgotten.map(e => e.id),
        });
      }
    };

    checkInsights();
  }, [userId, dismissed]);

  const dismiss = () => {
    const dismissKey = `jac-insight-dismissed-${new Date().toDateString()}`;
    localStorage.setItem(dismissKey, 'true');
    setDismissed(true);
    setInsight(null);
  };

  return { insight, dismiss };
}
```

#### 4.2 Create Proactive Insight Banner
**New File:** `src/components/JacProactiveInsight.tsx`

```typescript
import { Brain, X, AlertTriangle, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface JacProactiveInsightProps {
  message: string;
  type: 'forgotten' | 'overdue' | 'unchecked';
  onDismiss: () => void;
  onAction?: () => void;
}

const JacProactiveInsight = ({ message, type, onDismiss, onAction }: JacProactiveInsightProps) => {
  const config = {
    forgotten: { icon: Clock, color: 'text-amber-400', bg: 'bg-amber-500/5 border-amber-500/20' },
    overdue: { icon: AlertTriangle, color: 'text-red-400', bg: 'bg-red-500/5 border-red-500/20' },
    unchecked: { icon: Brain, color: 'text-blue-400', bg: 'bg-blue-500/5 border-blue-500/20' },
  }[type];
  
  const Icon = config.icon;

  return (
    <div className={cn("rounded-lg border p-3 flex items-center gap-3", config.bg)}>
      <Icon className={cn("w-5 h-5 shrink-0", config.color)} />
      <p className="text-sm flex-1">{message}</p>
      {onAction && (
        <Button variant="ghost" size="sm" onClick={onAction}>
          Show me
        </Button>
      )}
      <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onDismiss}>
        <X className="w-4 h-4" />
      </Button>
    </div>
  );
};

export default JacProactiveInsight;
```

#### 4.3 Integrate into Dashboard
**File:** `src/components/Dashboard.tsx`

Add the proactive insight banner above DumpInput.

```typescript
import { useProactiveInsights } from "@/hooks/useProactiveInsights";
import JacProactiveInsight from "@/components/JacProactiveInsight";

// Inside component:
const { insight, dismiss } = useProactiveInsights(userId);

// In JSX, above DumpInput:
{insight && (
  <JacProactiveInsight
    message={insight.message}
    type={insight.type}
    onDismiss={dismiss}
    onAction={() => {
      // Could scroll to first entry or open Jac
    }}
  />
)}
```

---

## Implementation Summary

| Task | Effort | Files |
|------|--------|-------|
| Undo toast for saves | Low | `useDumpSave.ts` |
| More Jac suggestions | Low | `AssistantChat.tsx` |
| Jac loading skeleton | Low | `AssistantChat.tsx` |
| Color-coded calendar dots | Medium | `CalendarView.tsx` |
| Show archived toggle | Medium | `Dashboard.tsx`, `useEntries.ts` |
| Restore from archive | Low | `EntryView.tsx` |
| Proactive insights hook | Medium | New file |
| Proactive insight banner | Low | New file |
| Integrate proactive banner | Low | `Dashboard.tsx` |

---

## Skipped (Per Your Request)

- **Stripe customer portal** - You're still building this, skip for now
- **Email reminders via Resend** - Requires external service setup
- **Browser extension** - Out of scope for current phase

---

## Execution Order

1. **Undo toast** (quick win, immediate UX improvement)
2. **Jac loading skeleton** (polish)
3. **More Jac suggestions** (adds value)
4. **Color-coded calendar dots** (visual enhancement)
5. **Show archived toggle + restore** (power user feature)
6. **Proactive insights** (Jac intelligence layer)

All of these can be implemented in parallel since they touch different files.
