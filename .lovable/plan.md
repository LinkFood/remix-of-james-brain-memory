
# Fix: Jac Surfaced Content Must Be Front and Center

## The Problem

When you ask Jac a question and it surfaces relevant entries, those entries appear in a "Jac Found" section - but that section is buried BELOW:
- DumpInput (sticky top)
- Reminder Banner
- Quick Stats
- Stats Grid
- Tag Filter

By the time Jac's results show up, the user has to scroll. This defeats the entire "Jac transforms the dashboard" concept.

## The Solution

### 1. Move Jac Content to the Very Top

When `jacState.active` is true, show Jac's content ABOVE everything else - even above DumpInput.

**File:** `src/components/Dashboard.tsx`

Current order:
```
1. Proactive Insight Banner
2. DumpInput (sticky)
3. Reminder Banner
4. Quick Stats
5. Stats Grid
6. Tag Filter & Archive Toggle
7. Jac Insight Card <-- TOO LOW
8. Sections (including "Jac Found") <-- TOO LOW
```

New order when Jac is active:
```
1. Jac Insight Card <-- MOVED UP
2. Jac Found Section <-- MOVED UP
3. DumpInput (collapsible when Jac active)
4. Everything else...
```

### 2. Auto-Scroll to Top When Jac Surfaces Entries

**File:** `src/pages/Dashboard.tsx`

Add effect in the page component to scroll to top when `jacState` becomes active with results:

```typescript
useEffect(() => {
  if (jacState?.active && jacState?.surfaceEntryIds?.length > 0) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}, [jacState?.active, jacState?.surfaceEntryIds?.length]);
```

### 3. Collapse Other Sections When Jac is Active

When Jac is actively showing results, minimize visual noise by:
- Collapsing all other sections by default
- Adding a subtle "Jac is showing you something" visual treatment
- Providing a clear "Clear Jac view" action to restore normal dashboard

### 4. Make Jac Insight Card More Prominent

**File:** `src/components/JacInsightCard.tsx`

Add subtle animation when appearing:
- Fade in + slide down
- Slight glow/pulse to draw attention
- Larger padding when it's the hero element

## Implementation Details

### Dashboard.tsx Changes

```tsx
return (
  <div className="space-y-6">
    {/* JAC TAKES OVER when active */}
    {jacState?.active && (
      <div className="space-y-4 animate-in fade-in slide-in-from-top-2 duration-300">
        {/* Jac Insight Card - THE HERO */}
        {jacState.insightCard && (
          <JacInsightCard
            insight={jacState.insightCard}
            message={jacState.message}
            loading={jacState.loading}
            onDismiss={() => onClearJac?.()}
            prominent // New prop for hero styling
          />
        )}
        
        {/* Jac Found Section - RIGHT HERE, NOT BURIED */}
        {jacSurfacedEntries.length > 0 && (
          <EntrySection
            title="Jac Found"
            icon={<Brain className="w-4 h-4 text-sky-400" />}
            entries={jacSurfacedEntries}
            // ... rest of props
          />
        )}
        
        {/* Clear button to return to normal view */}
        <Button 
          variant="ghost" 
          onClick={onClearJac}
          className="w-full text-muted-foreground"
        >
          Back to normal view
        </Button>
      </div>
    )}

    {/* Normal dashboard content - collapse DumpInput when Jac active */}
    <Collapsible open={!jacState?.active}>
      <DumpInput ... />
    </Collapsible>
    
    {/* Proactive insight only when Jac NOT active */}
    {!jacState?.active && insight && (
      <JacProactiveInsightBanner ... />
    )}

    {/* Rest of dashboard */}
    {/* ... */}
  </div>
);
```

### Pages/Dashboard.tsx Changes

Add scroll-to-top effect:

```typescript
// Auto-scroll to top when Jac surfaces content
useEffect(() => {
  if (jacState?.active && (jacState?.surfaceEntryIds?.length > 0 || jacState?.insightCard)) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}, [jacState?.active, jacState?.surfaceEntryIds?.length, jacState?.insightCard]);
```

### Optional: Dim Other Sections

When Jac is active, slightly dim the rest of the dashboard to focus attention:

```tsx
<div className={cn(
  "space-y-4",
  jacState?.active && "opacity-50 pointer-events-none"
)}>
  {/* Regular sections */}
</div>
```

This creates a modal-like focus on Jac's output without hiding the rest of the dashboard.

## Files to Modify

| File | Changes |
|------|---------|
| `src/components/Dashboard.tsx` | Reorder JSX to put Jac content first when active |
| `src/pages/Dashboard.tsx` | Add scroll-to-top effect |
| `src/components/JacInsightCard.tsx` | Add `prominent` prop for hero styling |

## Expected Behavior After Fix

1. User asks Jac "What patterns am I missing?"
2. Dashboard scrolls to top automatically
3. JacInsightCard appears at the very top with the answer
4. "Jac Found" section appears immediately below with relevant entries
5. Rest of dashboard is dimmed/collapsed to focus attention
6. "Back to normal view" button clears Jac and restores dashboard
7. User sees context FRONT AND CENTER - exactly as intended
