# LinkJac — Product Ethos & Intelligence Blueprint

*Version 3.0 — January 2026*

---

## One Sentence

LinkJac is a brain dump tool where you throw in raw thoughts and an AI named Jac finds the patterns you can't see yourself.

---

## The Problem

Every productivity app makes you organize your own thinking. Notion gives you databases. Obsidian gives you links. Apple Notes gives you folders. They all assume you know what your thoughts mean *at the moment you have them*. You don't. You're in the shower, on a walk, in the middle of something — you just need to get it out.

Most thoughts die in the notes app you wrote them in. LinkJac's job is to make sure no thought dies alone.

---

## The Bet

Capture should be instant and thoughtless. Intelligence should come after, not before. You dump, Jac thinks.

---

## Who It's For

- People who tried Notion and bounced
- People who text themselves reminders
- People who have 47 browser tabs as "memory"
- People whose brains don't stop
- People who just want to remember shit

---

## Core Principles

### 1. Reactive, Not Active

The app responds to you. It never asks questions. It never demands organization.

- "Which folder?" → **No.** Jac classifies it.
- "Please add tags" → **No.** Jac tags it.
- "What priority?" → **No.** Jac scores it.

**When in doubt, ask:** "Does this require the user to make a decision?" If yes — find a way for Jac to decide instead.

### 2. Zero Friction

One input box. Always visible. Dump anything. No modes, no forms, no decisions. Paste and go. Under 1 second to dump.

### 3. AI Is Invisible

The user sees "Saved" — not "classifying..." not "generating embedding..." not a loading spinner over their thought. All intelligence runs silently after capture.

### 4. Your Brain Is Yours

Export anytime (JSON, CSV, Markdown). Delete everything with one click. No lock-in, no hostage data.

### 5. Every Dump Compounds

The value of a thought increases over time if something is watching. Every new dump makes every previous dump smarter through connections, context, and patterns.

---

## The Three Intelligence Layers

### Layer 1 — DUMP (Capture)

Zero-friction capture. Text, voice, whatever. Jac silently classifies, tags, and scores importance on every save. The user never organizes anything.

**What happens on every dump:**
1. User pastes/types/speaks anything
2. `smart-save` orchestrates: classify → embed → score → save
3. Content type detected: `code`, `list`, `idea`, `link`, `contact`, `event`, `reminder`, `note`
4. Tags extracted automatically
5. Importance scored 0-10
6. Vector embedding generated (fire-and-forget, non-blocking)
7. Semantic relationships computed against existing entries
8. User sees "Saved" — nothing else

**This layer is built and working.**

### Layer 2 — CONNECT (Internal Intelligence)

Jac maps your brain. Every dump gets a vector embedding. Over time, Jac finds semantic relationships between entries you never explicitly connected.

You dumped a frustration about a tool in January and a product idea in March — Jac connects them and tells you. This is intelligence *from within your own data*.

**How it works:**
- `generate-embedding` creates a 768-dim vector (text-embedding-3-small) for every entry
- `search_entries_by_embedding` RPC finds semantically similar entries via pgvector HNSW index
- `entry_relationships` table stores pre-computed connections with similarity scores
- `find-related-entries` edge function retrieves connections (3-strategy: stored → live vector → tag fallback)
- RelatedEntries component shows connections in EntryView
- Dashboard highlights and draws visual connections between related entries

**This layer is built. Needs usage data to prove value.**

### Layer 3 — ENRICH (External Intelligence)

Jac brings in the outside world. You dump "I want to learn Rust" and Jac surfaces relevant resources, compares it to your existing skills from past dumps, and adds context you didn't have. This is intelligence *from beyond your data*.

**How it works:**
- `enrich-entry` edge function generates content-type-aware external context
- Content-type prompts: code → docs/patterns, ideas → validation/market, links → summaries
- Results cached in `extracted_data.enrichment` to avoid repeated lookups
- EnrichmentCard component shows insights on-demand in EntryView

**This layer is built but nascent. Currently AI-generated, not grounded in real web data. Future: real search, real sources.**

---

## Dashboard-as-Canvas

The dashboard is not a feed. It's a canvas. When you ask Jac a question, the dashboard itself transforms.

**How it works:**
- User asks Jac an exploration query ("What patterns am I missing?", "Show me connections between my ideas")
- `jac-dashboard-query` edge function processes the query against all user entries + relationships
- Returns structured commands: `highlightEntryIds`, `connections`, `clusters`, `insightCard`, `surfaceEntryIds`
- Dashboard responds: entries highlight with sky-400 glow, bezier curves draw between connected entries, cluster badges appear, insight cards surface, relevant entries reorder to top
- Jac doesn't answer in a chat bubble. Jac rearranges your brain visually.

**This is the long game. It's what makes LinkJac feel like nothing else.**

---

## What Jac Is

Jac is the AI assistant. Jac has three modes:

1. **Silent mode** (default) — Jac works in the background on every dump. Classify, tag, score, embed, connect. The user never sees this.
2. **Chat mode** — User opens the assistant panel and asks questions about their brain. Jac searches semantically, returns answers with source attribution.
3. **Canvas mode** — User asks an exploration question and Jac transforms the dashboard itself. Entries highlight, connections appear, clusters form.

Jac is not a chatbot. Jac is a brain that watches your brain.

---

## What This Is NOT

- **Not a note-taking app.** No formatting, no pages, no hierarchy.
- **Not a task manager.** Jac tracks what you dump, not what you need to do.
- **Not a chatbot.** Jac speaks through the dashboard, not through conversation.
- **Not another Notion.** Notion makes you the architect. LinkJac makes you the thinker.
- **Not a multi-provider chat app.** Not ChatGPT with memory. Not an AI wrapper.
- **Not complicated.** Not full of options. Not asking questions. Not making users organize.

---

## Content Types

| Type | Examples |
|------|----------|
| `code` | Snippets, functions, configs |
| `list` | Grocery, todos, checklists |
| `idea` | Shower thoughts, startup concepts |
| `link` | URLs with context |
| `contact` | Names, emails, phone numbers |
| `event` | Meetings, appointments |
| `reminder` | Time-sensitive notes |
| `note` | Everything else |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, TypeScript, Vite 5 |
| Styling | Tailwind CSS, shadcn/ui |
| Backend | Supabase (PostgreSQL, Edge Functions, Auth, RLS) |
| Vectors | pgvector with HNSW index, 768-dim embeddings |
| AI Classification | Google Gemini 2.5 Flash (via Lovable AI gateway) |
| Embeddings | OpenAI text-embedding-3-small (via Lovable AI gateway) |
| Voice | ElevenLabs TTS/STT + Web Speech API |
| Hosting | Lovable.dev |

---

## Architecture

```
USER DUMPS SOMETHING
        │
        ▼
┌─────────────────┐
│    DumpInput     │  ← One input. Always visible. Text or voice.
└────────┬────────┘
         │
         ▼
┌─────────────────┐     ┌──────────────────┐
│   smart-save    │────▶│  classify-content │  → type, tags, extracted_data
│  (Edge Function)│────▶│ generate-embedding│  → 768-dim vector (async)
│                 │────▶│calculate-importance│  → score 0-10
└────────┬────────┘     └──────────────────┘
         │
         ▼
┌─────────────────┐
│     entries      │  ← Single table. All user content.
│   (PostgreSQL)   │     content, title, type, tags[], importance,
│                  │     embedding vector(768), extracted_data JSONB
└────────┬────────┘
         │
         ▼ (async, fire-and-forget)
┌─────────────────┐
│entry_relationships│ ← Pre-computed semantic connections
│  (PostgreSQL)    │    similarity_score, relationship_type
└─────────────────┘
```

### Edge Functions (17 total)

**Save Pipeline:**
- `smart-save` — Orchestrates classify → embed → score → save → connect
- `classify-content` — Detects type, extracts tags and structured data
- `generate-embedding` — Creates 768-dim vector
- `calculate-importance` — Scores 0-10

**Intelligence:**
- `assistant-chat` — Jac's conversational brain (semantic search → keyword fallback → AI response)
- `search-memory` — Semantic + keyword search for GlobalSearch
- `find-related-entries` — Connect layer (stored → vector → tag fallback)
- `enrich-entry` — Enrich layer (content-type-aware external context)
- `jac-dashboard-query` — Canvas layer (structured dashboard transformation commands)

**Data Management:**
- `export-all-data` — JSON/CSV/Markdown export
- `delete-all-user-data` — Full account deletion
- `insert-sample-data` — Onboarding demo data
- `backfill-embeddings` — Retroactive embedding generation
- `generate-brain-report` — AI summary of user's brain

**Voice:**
- `elevenlabs-tts` — Text-to-speech
- `elevenlabs-stt` — Speech-to-text

### Data Model

**Primary table: `entries`** — This is the only table that matters. Not messages. Not conversations. Entries.

```
entries
├── id (UUID)
├── user_id (UUID, FK → profiles)
├── content (TEXT)
├── title (TEXT, AI-generated)
├── content_type (TEXT: code|list|idea|link|contact|event|reminder|note)
├── tags (TEXT[])
├── importance_score (INT, 0-10)
├── embedding (VECTOR(768))
├── extracted_data (JSONB — structured metadata, enrichment cache)
├── list_items (JSONB — for grocery/todo lists)
├── source_url (TEXT)
├── is_favorite (BOOLEAN)
├── is_pinned (BOOLEAN)
├── created_at (TIMESTAMPTZ)
└── updated_at (TIMESTAMPTZ)
```

**Supporting table: `entry_relationships`** — Pre-computed semantic connections.

```
entry_relationships
├── entry_id (UUID, FK → entries)
├── related_entry_id (UUID, FK → entries)
├── user_id (UUID, FK → profiles)
├── similarity_score (FLOAT)
├── relationship_type (TEXT, default 'semantic')
└── UNIQUE(entry_id, related_entry_id)
```

---

## Component Hierarchy

```
pages/Dashboard.tsx          ← Page shell, hooks, state
├── DumpInput                ← Always visible. THE input.
├── Dashboard                ← Home view with entry sections
│   ├── QuickStats           ← Streak, hot topics, stale entries
│   ├── TagFilter            ← Filter by tag
│   ├── JacInsightCard       ← When Jac has something to say
│   ├── EntrySection[]       ← Grouped by type (pinned, ideas, code, etc.)
│   │   └── EntryCard[]      ← Preview cards with cluster badges
│   └── EntryView            ← Full detail modal
│       ├── RelatedEntries   ← Connect layer
│       └── EnrichmentCard   ← Enrich layer
├── AssistantChat            ← Jac's chat panel (floating, draggable)
├── ConnectionLines          ← SVG overlay for visual connections
├── GlobalSearch             ← Semantic + keyword search
├── CalendarView             ← Calendar visualization
├── TimelineView             ← Timeline visualization
└── KnowledgeGraph           ← Graph visualization
```

---

## UI Principles

1. **ONE input box** — always visible, dump anything
2. **Dashboard is home** — not a chat interface
3. **Zero friction** — no questions, no choices, no "which folder?"
4. **AI is invisible** — user sees "Saved" not "classifying..."
5. **Mobile-first capture** — quick dump on phone must work
6. **Sections collapse/expand** — don't overwhelm
7. **Dark mode default** — clean, focused, no visual noise
8. **Jac transforms the canvas** — exploration queries reshape the dashboard, not a chat response

---

## Priority Order (What to Build Next)

1. **Connect (nail it)** — The first time a user goes "oh shit, Jac found a pattern I didn't see" is the product moment. Make that happen faster and more reliably.
2. **Enrich (ground it)** — AI-generated context isn't enrichment, it's hallucination risk. Ground it in real web data, real sources, real links.
3. **Canvas (wow them)** — Dashboard transformation only matters once Connect delivers consistent value. Don't polish the visual before the intelligence works.

---

## Success Looks Like

A user dumps something, forgets about it, and three weeks later Jac says "this thing you said connects to these other things you said — here's what that means."

That moment — the moment your own brain surprises you — is the product.

---

## Tone

Simple. Fast. No bullshit. **"Stop organizing. Start dumping."**
