

# Fix Code Workspace Chat — Show Messages + Agent Activity

## Problem

The Code Workspace chat tab has three issues:

1. **Empty chat area** — After sending a command like "Fix the login bug", the chat shows nothing. There is no message history, no agent status, and no results. The area above the input is just static placeholder text.

2. **Kill button invisible** — The task completed in ~46 seconds but the kill button only shows when `isRunning` is true. The button likely appeared briefly but the user was on the Chat tab, not the Terminal tab. There is no cross-tab indicator of a running task.

3. **No chat log persistence** — `sendCodeCommand` fires the dispatcher and forgets. Sent messages and agent responses are never stored or displayed.

## Solution

Transform the chat tab from a dead placeholder into a live conversation view that shows:
- User-sent commands
- Real-time agent activity steps (from the same `terminalLogs` data)
- Final results (PR link, files changed, completion status)

### Changes

#### 1. Add chat message state to `useCodeWorkspace.ts`

Add a `chatMessages` state array that tracks:
- **User messages**: Added when `sendCodeCommand` is called (before the fetch)
- **Agent responses**: Derived from `terminalLogs` — when a `task_completed` step arrives, create a summary message with the PR link, files changed, etc.

```typescript
type ChatMessage = {
  id: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
};
```

Store in state (not persisted to DB — reconstructed from activity logs on mount).

#### 2. Build chat messages from terminal logs on mount

During the existing log backfill (lines 74-89), also generate chat messages from historical logs by grouping by task and extracting key steps (task started, plan, write_code, open_pr, task_completed).

#### 3. Update `sendCodeCommand` to add user message

Before the fetch call, push a user message to `chatMessages`:
```typescript
setChatMessages(prev => [...prev, {
  id: crypto.randomUUID(),
  role: 'user',
  content: trimmed,
  timestamp: new Date().toISOString(),
}]);
```

#### 4. Update realtime log handler to add agent messages

When a `task_completed` log arrives via realtime, push an agent summary message:
```typescript
if (newLog.step === 'task_completed') {
  const detail = newLog.detail;
  setChatMessages(prev => [...prev, {
    id: newLog.id,
    role: 'agent',
    content: `Task completed. PR: ${detail.prUrl}\nFiles changed: ${detail.fileCount}`,
    timestamp: newLog.created_at,
    metadata: detail,
  }]);
}
```

Also push system messages for `started` and `failed` steps.

#### 5. Replace placeholder chat UI in `CodeWorkspace.tsx`

Replace the empty `div` (lines 158-163) with a scrollable message list:
- User messages: right-aligned, primary color bubble
- Agent messages: left-aligned, muted background, with clickable PR links
- System messages: centered, small text (e.g. "Task started...", "Planning...")
- Auto-scroll to bottom on new messages

#### 6. Add running indicator to Chat tab

Show a small pulsing dot on the Chat tab trigger when a task is running, so the user knows something is happening even if they're on another tab:
```tsx
<TabsTrigger value="chat" className="text-xs gap-1.5 h-7">
  <MessageSquare className="w-3.5 h-3.5" />
  Chat
  {isRunning && <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />}
</TabsTrigger>
```

## Files to modify

| File | Change |
|------|--------|
| `src/types/agent.ts` | Add `ChatMessage` type |
| `src/hooks/useCodeWorkspace.ts` | Add `chatMessages` state, populate from logs, update on send and realtime |
| `src/pages/CodeWorkspace.tsx` | Replace placeholder chat area with message list, add running dot to tab, pass chatMessages |
| `src/components/code/CodeChat.tsx` | Add `messages` prop, render message bubbles above input |

## What this does NOT change

- AgentTerminal — stays as-is (raw log feed)
- Kill button logic — stays as-is (only shows when running, which is correct)
- Edge functions — no changes needed
- Database — no new tables (chat messages derived from existing activity logs)

