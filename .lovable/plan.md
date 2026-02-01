
## What’s actually broken (root cause)

The runtime error you’re seeing (“module script isn’t loading… MIME type text/html”) is almost always Vite returning `index.html` for a module request. The two common reasons are:
1) the imported file doesn’t exist (404 → dev server falls back to HTML), or  
2) the import path/filename casing is wrong (`WebSourceCard.tsx` vs `webSourceCard.tsx`, etc.).

In this project, `src/components/chat/` currently contains only:
- `SourceImage.tsx`
- `SourceImageGallery.tsx`

So if the UI work attempted to import `@/components/chat/WebSourceCard`, that import will fail because the file truly does not exist yet.

Also, `AssistantChat.tsx` currently:
- defines `Message` with only `sources?: Source[]`
- parses only `parsed.sources` from the stream
- renders only brain “Sources” (entries), not `webSources`

## Goal

1) Fix the runtime/module-loading error by ensuring the imported module exists and is referenced with the correct path + casing.  
2) Implement the Web Sources UI so when the backend streams `webSources`, the chat shows clickable citations.

---

## Implementation steps (code changes)

### 1) Add the missing component file

Create: `src/components/chat/WebSourceCard.tsx`

**Responsibilities**
- Render a compact, clickable card for a single web citation:
  - title (link)
  - domain (derived from URL)
  - snippet (truncated)
  - “open external” icon
- Safe URL handling:
  - Use `try { new URL(source.url) } catch {}` to avoid crashing on malformed URLs.
- Tooltip for the full snippet (optional but recommended since TooltipProvider already exists in `App.tsx`).

**Export**
- Use a named export: `export function WebSourceCard(...) { ... }`
- (This avoids default-export/import mismatches and makes errors more obvious.)

---

### 2) Extend AssistantChat message types to include web sources

Modify: `src/components/AssistantChat.tsx`

Add a `WebSource` interface near the existing `Source` interface:

```ts
interface WebSource {
  title: string;
  url: string;
  snippet: string;
  relevanceScore: number;
  publishedDate?: string;
}
```

Update `Message`:

```ts
interface Message {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  webSources?: WebSource[];
}
```

---

### 3) Parse `webSources` from the streaming response

In the stream-reading section (currently around lines ~740–805):
- Add `let webSources: WebSource[] = [];`
- Update the “sources event” block to support both `sources` and `webSources`.

Target behavior:
- If `parsed.sources` arrives, store/update it on the last assistant message.
- If `parsed.webSources` arrives, store/update it on the last assistant message.
- If both arrive, update both.

Pseudo-structure:

```ts
let sources: Source[] = [];
let webSources: WebSource[] = [];

if (parsed.sources || parsed.webSources) {
  if (parsed.sources) sources = parsed.sources;
  if (parsed.webSources) webSources = parsed.webSources;

  setMessages(prev => {
    const next = [...prev];
    const lastIdx = next.length - 1;
    if (next[lastIdx]?.role === "assistant") {
      next[lastIdx] = { ...next[lastIdx], sources, webSources };
    }
    return next;
  });

  continue;
}
```

Also ensure the “content chunk” updates preserve both arrays:

```ts
next[lastIdx] = { ...next[lastIdx], content: assistantContent, sources, webSources };
```

This prevents `webSources` from disappearing as new text chunks stream in.

---

### 4) Render a “Web sources” section in the UI

Modify: `src/components/AssistantChat.tsx`

- Import the new component:
  - `import { WebSourceCard } from "@/components/chat/WebSourceCard";`
- Add `Globe` to lucide icon imports (or another globe-like icon if needed):
  - `import { Globe, ... } from "lucide-react";`

Then, in the message render block, directly below the existing brain Sources block, add:

- A divider and label (“Web sources”)
- Render up to 3 `WebSourceCard`s
- If more than 3, show `+N more sources`

Example placement:
- Right after the existing `{msg.sources && msg.sources.length > 0 && (...)}` block, add:

```tsx
{msg.webSources && msg.webSources.length > 0 && (
  <div className="mt-2 pt-2 border-t border-border/50">
    <div className="flex items-center gap-1.5 mb-1">
      <Globe className="w-3.5 h-3.5 text-muted-foreground" />
      <p className="text-xs text-muted-foreground">Web sources:</p>
    </div>

    <div className="space-y-1.5">
      {msg.webSources.slice(0, 3).map((source, idx) => (
        <WebSourceCard key={`${source.url}-${idx}`} source={source} />
      ))}
      {msg.webSources.length > 3 && (
        <p className="text-xs text-muted-foreground">
          +{msg.webSources.length - 3} more sources
        </p>
      )}
    </div>
  </div>
)}
```

---

## Why this fixes the MIME type / module script error

- The error is caused by Vite serving HTML for a module request (usually because the module path 404s).
- Creating `src/components/chat/WebSourceCard.tsx` and importing it with the exact matching casing ensures Vite serves a real TS/JS module instead of HTML.

---

## Verification checklist (end-to-end)

1) Reload the app after the changes.
2) Open Jac and ask: **“How do I learn Rust?”**
   - Expected: Jac answers normally, and underneath the answer you see:
     - “Web sources:” section
     - 1–3 clickable source cards (open in new tab)
3) Ask something purely internal: **“What’s on my grocery list?”**
   - Expected: No “Web sources” section; only brain sources if any.
4) Quick sanity:
   - No console errors about missing modules
   - Clicking a web source opens the URL in a new tab

---

## Guardrails / edge cases handled

- Malformed URLs: WebSourceCard won’t crash rendering.
- Streaming overwrites: `webSources` stays attached while content streams.
- Import casing: fixed by matching filename + import path exactly.

