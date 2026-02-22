

# Fix JAC Chat Not Showing Responses

## Root Cause
The realtime dedup logic in `useJacAgent.ts` has a bug on line 191. It checks if ANY existing message has the same timestamp as the incoming message, without checking the role. The backend (jac-dispatcher) inserts both the user message and assistant response with the exact same `created_at` timestamp. So:

1. User sends message -> optimistic user message added to state with a local timestamp
2. Realtime fires for the DB user message -> deduped correctly (same role + content within 30s window on line 195)
3. Realtime fires for the DB assistant message -> same `created_at` as the user message -> line 191 matches the user message's timestamp -> **assistant response silently dropped**

The user never sees JAC's reply in the web UI.

## Fix

### 1. Fix timestamp dedup to include role check (useJacAgent.ts, line 191)

Change:
```
if (prev.some(m => m.timestamp === newMsg.created_at)) return prev;
```
To:
```
if (prev.some(m => m.timestamp === newMsg.created_at && m.role === newMsg.role)) return prev;
```

This ensures the exact-timestamp dedup only blocks messages of the same role, allowing the assistant response through even when it shares a timestamp with the user message.

### 2. Fix duplicate key warning in JacChat (line ~120)

The console shows "Encountered two children with the same key" because messages use `msg.timestamp || i` as the React key, and two messages can share timestamps. Change to use `msg.timestamp + msg.role + i` or similar unique combination.

In `src/components/jac/JacChat.tsx`, change:
```
key={msg.timestamp || i}
```
To:
```
key={`${msg.timestamp}-${msg.role}-${i}`}
```

### 3. No backend changes needed
The dispatcher is working correctly -- messages are being saved and tasks are dispatching fine. This is purely a frontend dedup/rendering bug.

## Testing After Fix
1. Go to /jac Command Center
2. Send a message like "research latest AI news" in the chat
3. Verify: JAC's reply appears immediately in the chat bubble
4. Verify: Task shows up in the Operations tab as running
5. When task completes, verify the research result message appears
6. Test the kill switch: while a task is running, click the Stop button on the task card
7. Verify: task status changes to cancelled with orange badge

