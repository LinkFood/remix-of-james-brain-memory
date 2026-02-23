

# Kill Button Visibility + Dispatcher Redeploy

## What's happening with the kill button

The kill button in AgentTerminal is working correctly — it only appears when `isRunning` is true AND `onCancel` is provided. These conditions require an active code session with a running task (`activeSession?.status === 'active'` and `activeSession?.task_id` is set). Since no task is currently running, the button is intentionally hidden.

However, there is a real bug: the **mobile terminal tab** never passes `isRunning` or `onCancel`, so even when a task IS running, mobile users won't see the kill button.

## Changes

### 1. Fix mobile terminal kill button (CodeWorkspace.tsx ~line 227)

The mobile `<AgentTerminal>` is missing the `isRunning` and `onCancel` props. Add them to match the desktop version:

```tsx
<AgentTerminal
  logs={terminalLogs}
  sessionStatus={activeSession?.status ?? null}
  isRunning={isRunning}
  onCancel={runningTaskId ? () => cancelTask(runningTaskId) : undefined}
/>
```

### 2. Redeploy jac-dispatcher

Re-run edge function deployment for `jac-dispatcher` to ensure the latest commit f64fdc0 changes (code project awareness in general intent) are live.

## Technical Details

- `AgentTerminal` component already supports the kill button UI (lines 73-81 of AgentTerminal.tsx)
- The `cancelTask` function in `useCodeWorkspace.ts` (line 361) updates `agent_tasks` status to `cancelled`
- The `jac-code-agent` edge function checks for cancellation before each major step (plan, write_code, create_branch)
- The kill button will appear as a red "kill" label with an OctagonX icon in the terminal header bar when a task is actively running

