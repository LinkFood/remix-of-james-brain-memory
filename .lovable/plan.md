

# Apply AgentTerminal Collapsing + Session Dividers (commit 6df52c4)

## Problem

The `AgentTerminal.tsx` file in the codebase does not contain the changes from commit 6df52c4. It still renders every raw log entry individually, showing duplicate started/completed lines and perpetual blue spinners on finished work.

## Fix

Replace the current `AgentTerminal.tsx` with the intended version that includes:

### 1. Add `collapseLogs` function

A new function that merges started/completed pairs into a single line per step. It maps `"taskId:step"` keys to track which steps have been started, then merges completed/failed entries into the same slot. Only genuinely in-progress steps (started with no matching end) show a spinner.

### 2. Add `useMemo` for collapsed logs

```tsx
const collapsed = useMemo(() => collapseLogs(logs), [logs]);
```

### 3. Add session dividers

Track `taskId` changes across the collapsed entries. When the task ID changes, insert a subtle horizontal line with a "session N" label.

### 4. Hide 0ms durations

Change the duration display condition from:
```tsx
{log.duration_ms !== null && (
```
to:
```tsx
{entry.duration_ms !== null && entry.duration_ms > 0 && (
```

### 5. Render collapsed entries instead of raw logs

Replace `logs.map(...)` with `collapsed.map(...)` using the `CollapsedLogEntry` type.

## File changes

| File | Change |
|------|--------|
| `src/components/code/AgentTerminal.tsx` | Full update: add `collapseLogs`, `CollapsedLogEntry` type, `useMemo` import, session dividers, 0ms filter, render collapsed entries |

## Result

- ~12 clean lines per 12-step session instead of ~24
- Green checkmark + duration for completed steps
- Blue spinner only for genuinely running steps
- Session dividers between different task runs
- No misleading 0ms durations
