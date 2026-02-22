

# Fix Kill Button Visibility + End-to-End Testing Plan

## Problem
Two issues found:

1. **Mobile ActivityFeed is missing stop props** -- The desktop ActivityFeed (line 132) correctly passes `onStopTask={stopTask} onStopAll={stopAllTasks}`, but the mobile version (line 165) does NOT pass these props. Kill buttons will never appear on mobile.

2. **Kill buttons only appear on active tasks** -- This is by design. The "Stop all" bar shows only when tasks are running, and individual stop buttons only render on running/queued task cards. If no tasks are currently active, there's nothing to stop and no buttons to show.

## Fix

### Step 1: Add missing props to mobile ActivityFeed
In `src/pages/Jac.tsx`, line 165, add the two missing props:

```
<ActivityFeed
  tasks={tasks}
  activityLogs={activityLogs}
  loading={loading}
  onExpandTask={loadTaskLogs}
  onStopTask={stopTask}
  onStopAll={stopAllTasks}
/>
```

### Step 2: Deploy the jac-kill-switch edge function
The function code is ready but needs deployment.

### Step 3: End-to-end testing
To verify the kill switch works:

1. **Trigger a task** -- Send a research query via the JAC chat (e.g., "research latest AI news") so a task enters `running` status
2. **Verify button appears** -- While the task is running, a red stop button should appear on the task card, and a "Stop all" button in the blue operations bar
3. **Click stop** -- Click the stop button and verify:
   - Task status changes to `cancelled` (orange badge)
   - Orange toast notification appears
   - Task stays cancelled (soft-kill guards prevent overwrite)
4. **Slack kill** -- Send "stop" or "kill" as a DM to JAC in Slack and verify all active tasks get cancelled

## What's NOT changing
- No changes to the kill switch edge function (already correct)
- No changes to useJacAgent hook (stopTask/stopAllTasks already work)
- No changes to TaskCard or ActivityFeed components (already have the UI)
- No changes to worker agents (soft-kill guards already in place)
