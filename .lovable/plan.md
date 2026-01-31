
# Jac: The Grounded Personal Intelligence

## The Differentiator: Why This Is NOT Just Another ChatGPT

You're absolutely right to ask this question. Here's the answer:

### What ChatGPT/Claude Can Do
- Answer questions about the world (generic knowledge)
- Forget you between sessions (no memory)
- Give the same advice to everyone

### What Jac Can Do (That They Can't)

| Capability | ChatGPT | Jac |
|------------|---------|-----|
| Knows what you dumped 3 weeks ago | No | Yes |
| Remembers your grocery list style | No | Yes |
| Notices you mentioned "burnout" twice | No | Yes |
| Sees your calendar alongside your notes | No | Yes |
| Tracks importance of YOUR thoughts | No | Yes |
| Finds patterns across YOUR months of data | No | Yes |
| Grows smarter as YOU dump more | No | Yes |

### The Formula

```
Generic LLM = World Knowledge
Jac = World Knowledge + YOUR Brain + Time
```

When you ask ChatGPT: "What should I focus on?"
- ChatGPT: Generic productivity advice

When you ask Jac: "What should I focus on?"
- Jac: "You dumped 'learn Rust' 3 weeks ago but haven't touched it. You also have a dentist appointment tomorrow. Based on current Rust resources online, here's a quick start path that fits your schedule..."

**The moat is YOUR accumulated data over time. ChatGPT has no memory. Jac has YOUR memory.**

---

## The Evolution: Jac as Core Intelligence

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│                        USER                              │
│                    "What should I do?"                   │
└───────────────────────────┬─────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│                         JAC                              │
│              (The Intelligence Layer)                    │
│                                                          │
│  ┌───────────────┐    ┌───────────────┐                 │
│  │  YOUR BRAIN   │    │  THE WORLD    │                 │
│  │  ───────────  │    │  ───────────  │                 │
│  │  • Entries    │    │  • Perplexity │                 │
│  │  • Tags       │    │    (web search│                 │
│  │  • Patterns   │    │     + answers)│                 │
│  │  • Importance │    │  • Firecrawl  │                 │
│  │  • Calendar   │    │    (deep docs)│                 │
│  │  • Connections│    │               │                 │
│  └───────────────┘    └───────────────┘                 │
│                                                          │
│         SYNTHESIS: Personal + World = Grounded          │
└───────────────────────────────────────────────────────────┘
                            │
                            ▼
            Dashboard transforms to show answer
```

### Data Jac Already Has Access To

From the codebase, Jac can query:

1. **entries** - All user dumps with:
   - `content`, `title`, `content_type`, `content_subtype`
   - `tags[]`, `importance_score` (0-10)
   - `embedding` (768-dim vector for semantic search)
   - `event_date`, `event_time` (calendar integration)
   - `list_items[]` (groceries, todos)
   - `starred`, `archived`
   - `created_at`, `updated_at`

2. **entry_relationships** - Pre-computed connections:
   - `similarity_score` (how related two entries are)
   - `relationship_type` (semantic, tag-based)

3. **brain_reports** - Weekly summaries:
   - `key_themes`, `insights`, `decisions`

4. **subscriptions** - Usage context

5. **profiles** - User preferences

**This is context no generic LLM has.**

---

## Implementation Plan

### Phase 1: Jac Voice Throughout (UI/Copy)
Make Jac feel like a presence, not a feature.

**Files to modify:**
- `src/components/DumpInput.tsx` - "Saved ✓" becomes "Jac got it"
- `src/components/dashboard/EmptyState.tsx` - "Jac is ready. Dump something."
- `src/components/OnboardingModal.tsx` - Jac introduces itself
- `src/components/dashboard/SectionHeader.tsx` - "What Jac sees in Ideas"
- Toast messages throughout - First person Jac voice

### Phase 2: Web Grounding (Backend)
Give Jac access to the world via Perplexity + Firecrawl.

**New edge function: `jac-web-search/index.ts`**
```typescript
// Combines:
// 1. User brain context (from entries via semantic search)
// 2. Web context (from Perplexity for answers, Firecrawl for deep docs)

// Decision logic:
// - General questions → Perplexity (search + answer)
// - Code/docs questions → Firecrawl (scrape specific docs)
// - Personal questions → Brain only (no web needed)
```

**Connector requirements:**
- Perplexity: General web search with citations
- Firecrawl: Deep documentation scraping for technical queries

**Integration points:**
- `assistant-chat/index.ts` - Add web search when helpful
- `enrich-entry/index.ts` - Ground enrichment in real sources
- `jac-dashboard-query/index.ts` - Add web sources to responses

### Phase 3: Jac-First Interface
The dashboard IS Jac's canvas.

**Changes:**
1. **Jac input bar at top of dashboard** - Not hidden in corner
   - Simple input: "Ask Jac anything..."
   - Responses transform dashboard, not chat bubbles
   
2. **Jac visible by default** - `isMinimized: false`

3. **Inline Jac hints on entries** - "This connects to 3 others"

4. **Proactive patterns** - More aggressive detection:
   - "You've mentioned X 3 times this month"
   - "This idea from January connects to today's dump"

### Phase 4: Jac Personality
Consistent voice across all touchpoints.

**Jac's character:**
- First person: "I found...", "I noticed..."
- Brief and punchy, not verbose
- Personal: "your brain", "you dumped"
- Occasionally surprising: "Oh, this connects to something from January..."

**Example responses:**

| Before (Generic) | After (Jac) |
|------------------|-------------|
| "Based on semantic analysis..." | "I found a pattern you missed." |
| "The system has identified..." | "This connects to something from January." |
| "Entry saved successfully." | "Jac got it." |
| "No results found." | "Nothing in your brain matches that yet." |

---

## Technical Changes Summary

### New Files
| File | Purpose |
|------|---------|
| `supabase/functions/jac-web-search/index.ts` | Web grounding via Perplexity/Firecrawl |

### Modified Files (Backend)
| File | Changes |
|------|---------|
| `supabase/functions/assistant-chat/index.ts` | Add web search integration |
| `supabase/functions/enrich-entry/index.ts` | Ground enrichment in real sources |
| `supabase/functions/jac-dashboard-query/index.ts` | Add web context to responses |
| `supabase/config.toml` | Add `jac-web-search` function |

### Modified Files (Frontend)
| File | Changes |
|------|---------|
| `src/components/DumpInput.tsx` | Toast: "Jac got it" |
| `src/components/dashboard/EmptyState.tsx` | Jac-first copy |
| `src/components/OnboardingModal.tsx` | Jac introduction |
| `src/components/AssistantChat.tsx` | `isMinimized: false` default |
| `src/pages/Dashboard.tsx` | Add Jac input bar at top |
| `src/components/Dashboard.tsx` | Jac-first section ordering |

---

## Connectors Required

Before implementation, you'll need to connect:

1. **Perplexity** - For grounded web search with citations
2. **Firecrawl** - For deep documentation scraping

These are available in Settings → Connectors.

---

## The Moat (Why This Wins)

1. **Persistent Memory**: ChatGPT forgets. Jac remembers everything.

2. **Pattern Detection Over Time**: Only Jac sees you mentioned burnout twice this month.

3. **Your Data + World Data**: Grounded answers specific to YOU.

4. **Zero-Effort Intelligence**: You dump. Jac thinks. No organizing.

5. **Dashboard as Canvas**: Not chat bubbles - visual transformation.

6. **Full Data Ownership**: Export everything. Delete everything. Your brain, your data.

---

## Order of Execution

1. **Connect Perplexity + Firecrawl** (requires user action)
2. **Create `jac-web-search` edge function** (backend)
3. **Integrate web search into `assistant-chat`** (backend)
4. **Update all UI copy to Jac voice** (frontend)
5. **Make Jac visible by default** (frontend)
6. **Add Jac input bar to dashboard** (frontend)

This transforms LinkJac from "note app with AI" to "AI that knows your brain AND the world."
