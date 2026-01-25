# LinkJac - Vision & Ethos

## The Problem

Your thoughts are scattered. Ideas pop up in the shower, tasks appear during meetings, code snippets get lost in Slack, grocery lists live on napkins. The cognitive load of organizing all this is exhausting.

**Current tools fail you:**
- Note apps require you to pick a folder, add tags, format correctly
- AI assistants forget everything when you close the tab
- Todo apps want you to fit your thoughts into their structure
- You end up with 47 open tabs, 12 note apps, and still can't find that thing you wrote last week

---

## The Solution: LinkJac

**LinkJac is your reactive second brain.**

Dump anything. We handle everything else.

### How It Works

1. **You dump** — paste code, type "buy milk", jot an idea, drop a link
2. **AI classifies** — instantly detects type, tags, and importance
3. **We store** — with embeddings for semantic search
4. **Dashboard surfaces** — categorized view of what matters
5. **Assistant retrieves** — ask questions, get answers from your brain

---

## Core Principles

### 1. Reactive, Not Active

The app responds to you. It never asks questions. It never demands organization.

- ❌ "Which folder should this go in?"
- ❌ "Please add tags"
- ❌ "What priority is this?"
- ✅ Just save it and show me later

### 2. Zero Friction

One input box. Always visible. Dump anything.

- No modes to switch
- No forms to fill
- No decisions to make
- Paste and go

### 3. AI Handles Classification

Every entry is automatically:
- **Typed**: code, list, idea, link, contact, event, reminder, note
- **Tagged**: relevant topics extracted
- **Scored**: importance 0-10
- **Embedded**: for semantic search

### 4. User Data Ownership

Your brain is yours.
- Export anytime (JSON, CSV, Markdown)
- Delete everything with one click
- No lock-in, no hostage data
- We store your data, we don't own it

### 5. Server-Side AI

No API keys to manage. No configuration. Just works.
- Classification runs on our servers
- Embeddings generated automatically
- Assistant answers without setup

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

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  DumpInput  │────▶│  smart-save │────▶│   entries   │
│   (React)   │     │  (Edge Fn)  │     │  (Postgres) │
└─────────────┘     └─────────────┘     └─────────────┘
                           │
                    ┌──────┴──────┐
                    │  classify   │
                    │  embed      │
                    │  score      │
                    └─────────────┘
```

### Key Tables
- `entries`: All user content with embeddings, tags, importance scores
- `brain_reports`: AI-generated summaries and insights

### Edge Functions
- `smart-save`: Orchestrates the save flow
- `classify-content`: Detects type and extracts metadata
- `generate-embedding`: Creates vector for semantic search
- `calculate-importance`: Scores 0-10
- `assistant-chat`: Answers questions from your brain
- `search-memory`: Semantic + keyword search

---

## What LinkJac Is NOT

❌ **Not a multi-provider chat app** — We're not ChatGPT with memory

❌ **Not a note-taking app with folders** — No hierarchy, no organization burden

❌ **Not a to-do app** — We don't nag you about deadlines

❌ **Not another AI wrapper** — We're the memory layer, not the model

---

## What LinkJac IS

✅ **A capture tool** — Dump anything, instantly

✅ **A classification engine** — AI organizes for you

✅ **A retrieval system** — Semantic search finds what you need

✅ **A second brain** — Remembers so you don't have to

✅ **A privacy-first platform** — Your data, your control

---

## Guiding Questions

When building features, ask:

1. **Does this reduce friction?** If it adds a step, reconsider.
2. **Does the AI handle it?** Users shouldn't need to think.
3. **Is it reactive?** Don't prompt, don't ask, don't demand.
4. **Does the user own their data?** Always exportable, deletable.
5. **Does it compound value?** Every dump should make the brain smarter.

---

## Tagline

**"Stop organizing. Start dumping."**

---

*Last Updated: 2025-01-23*  
*Version: 2.0 (Brain Dump Architecture)*
