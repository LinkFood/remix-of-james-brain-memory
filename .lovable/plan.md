
# Web Sources UI Component for AssistantChat

## Summary

Add a visual component to display web sources/citations when Jac uses web grounding (Tavily). This gives users transparency into where external information comes from and allows them to click through to original sources.

## Current State

- **Backend**: Already returns `webSources` array with `{ title, url, snippet, relevanceScore }` in streaming metadata
- **Frontend**: Currently ignores `webSources` - only displays brain sources (entries)
- **Message interface**: Only has `sources?: Source[]` for brain entries, missing web sources

## Implementation

### Step 1: Extend Message Interface

Update the Message interface to include web sources:

```typescript
interface WebSource {
  title: string;
  url: string;
  snippet: string;
  relevanceScore: number;
  publishedDate?: string;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  webSources?: WebSource[];
}
```

### Step 2: Parse webSources from Stream

Update the stream parsing logic to capture `webSources` alongside `sources`:

```typescript
// In the parsing block around line 765
if (parsed.sources || parsed.webSources) {
  sources = parsed.sources || sources;
  webSources = parsed.webSources || webSources;
  // Update message with both
  setMessages((prev) => {
    const newMessages = [...prev];
    const lastIdx = newMessages.length - 1;
    if (newMessages[lastIdx]?.role === "assistant") {
      newMessages[lastIdx] = { ...newMessages[lastIdx], sources, webSources };
    }
    return newMessages;
  });
  continue;
}
```

### Step 3: Create WebSourceCard Component

Create a new component `src/components/chat/WebSourceCard.tsx`:

```typescript
// Clean, clickable card showing:
// - Favicon (extracted from URL domain)
// - Title (clickable link)
// - Snippet preview (truncated)
// - External link icon
```

Design:
- Compact horizontal card with subtle border
- Globe/external link icon to differentiate from brain sources
- Opens URL in new tab on click
- Hover state shows full snippet in tooltip

### Step 4: Add Web Sources Section to Message Render

Below the existing brain sources section (around line 1003), add:

```typescript
{/* Web Sources - external citations */}
{msg.webSources && msg.webSources.length > 0 && (
  <div className="mt-2 pt-2 border-t border-border/50">
    <div className="flex items-center gap-1.5 mb-1">
      <Globe className="w-3.5 h-3.5 text-muted-foreground" />
      <p className="text-xs text-muted-foreground">
        Web sources:
      </p>
    </div>
    <div className="space-y-1.5">
      {msg.webSources.slice(0, 3).map((source, idx) => (
        <WebSourceCard key={idx} source={source} />
      ))}
      {msg.webSources.length > 3 && (
        <span className="text-xs text-muted-foreground">
          +{msg.webSources.length - 3} more sources
        </span>
      )}
    </div>
  </div>
)}
```

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/components/chat/WebSourceCard.tsx` | CREATE | Compact card component for web source display |
| `src/components/AssistantChat.tsx` | MODIFY | Add WebSource interface, parse webSources from stream, render web sources section |

## Visual Design

```
┌─────────────────────────────────────────────────────┐
│  Jac's response text...                             │
│                                                      │
│  ─────────────────────────────────────────────────  │
│  📚 Sources (click to view):                         │
│  [Entry Badge] [Entry Badge] [Entry Badge]          │
│                                                      │
│  ─────────────────────────────────────────────────  │
│  🌐 Web sources:                                     │
│  ┌─────────────────────────────────────────────┐    │
│  │ 🔗 Rust Programming Guide - rust-lang.org   ↗│    │
│  │    Official Rust documentation and...       │    │
│  └─────────────────────────────────────────────┘    │
│  ┌─────────────────────────────────────────────┐    │
│  │ 🔗 Learn Rust - rustup.rs                   ↗│    │
│  │    Getting started with Rust in 2026...     │    │
│  └─────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

## Testing

After implementation, test by asking Jac:
- "How do I learn Rust?" (should trigger web grounding)
- "What's new with React in 2026?" (should show web sources)
- "What's on my grocery list?" (should NOT trigger web grounding)
