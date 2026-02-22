# LinkJac — Product Ethos & Intelligence Blueprint

*Version 4.0 — February 2026*

---

## One Sentence

LinkJac is a personal AI agent swarm where you dump raw thoughts, dispatch agents, and get results — 24/7, from anywhere.

---

## The Problem

Every productivity app makes you organize your own thinking. Notion gives you databases. Obsidian gives you links. Apple Notes gives you folders. They all assume you know what your thoughts mean *at the moment you have them*. You don't. You're in the shower, on a walk, in the middle of something — you just need to get it out.

Most thoughts die in the notes app you wrote them in. LinkJac's job is to make sure no thought dies alone — and to act on your thoughts while you sleep.

---

## The Bet

Capture should be instant and thoughtless. Intelligence should come after, not before. You dump, Jac thinks. You command, agents execute.

---

## Who It's For

- Me. This is a personal tool built for one person, deployed to the web.
- An average Joe's OpenClaw — same power, cloud-native, no local setup.

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

### 6. Agents Work While You Sleep

Dispatch a task from the web or Slack. Come back to results, not waiting. 24/7 async operation.

---

## The Four Intelligence Layers

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

**This layer is built. Needs usage data to prove value.**

### Layer 3 — ENRICH (External Intelligence)

Jac brings in the outside world. You dump "I want to learn Rust" and Jac surfaces relevant resources, compares it to your existing skills from past dumps, and adds context you didn't have. This is intelligence *from beyond your data*.

**This layer is built but nascent. Future: real search, real sources.**

### Layer 4 — AGENTS (Cloud Intelligence)

JAC Agent OS — the 24/7 personal cloud agent swarm. You tell JAC what to do via the web Command Center or Slack, JAC dispatches specialized agents, they work asynchronously, save results to your brain, and notify you.

**Agent Roster:**
- **Scout** (jac-research-agent) — Web research via Tavily, synthesized with brain context
- **Scribe** (jac-save-agent) — Save anything to brain with full classification pipeline
- **Oracle** (jac-search-agent) — Deep brain search with keyword + semantic matching
- **JAC Dispatcher** (jac-dispatcher) — Boss agent. Parses intent via Claude, routes to workers

**How it works:**
1. User sends message (web UI or Slack DM)
2. `jac-dispatcher` searches brain for context, parses intent with Claude
3. Creates parent + child tasks in `agent_tasks`
4. Dispatches worker edge function (fire-and-forget)
5. Worker executes (research, save, search), updates task status
6. Results saved to brain + Slack notification sent
7. User comes back to grab results

**Interfaces:**
- **Web Command Center** (`/jac`) — Full task dashboard, agent roster, activity feed, chat
- **Slack** — 2-way: send commands via DM, get results in thread replies
- **Dashboard Assistant** — Quick brain queries, suggests Command Center for complex tasks

**This layer is built and working.**

---

## Dashboard-as-Canvas

The dashboard is not a feed. It's a canvas. When you ask Jac a question, the dashboard itself transforms.

**This is the long game. It's what makes LinkJac feel like nothing else.**

---

## What Jac Is

Jac is the AI assistant. Jac has four modes:

1. **Silent mode** (default) — Jac works in the background on every dump. Classify, tag, score, embed, connect. The user never sees this.
2. **Chat mode** — User opens the assistant panel and asks questions about their brain. Quick queries, fast answers.
3. **Canvas mode** — User asks an exploration question and Jac transforms the dashboard itself. Entries highlight, connections appear, clusters form.
4. **Agent mode** — User opens the Command Center or sends a Slack message. Jac dispatches agents for complex, async tasks. Results come back when ready.

Jac is not a chatbot. Jac is a brain that watches your brain — and an agent swarm that works for you.

---

## What This Is NOT

- **Not a note-taking app.** No formatting, no pages, no hierarchy.
- **Not a task manager.** Jac tracks what you dump, not what you need to do.
- **Not a chatbot.** Jac speaks through actions, not conversation.
- **Not another Notion.** Notion makes you the architect. LinkJac makes you the thinker.
- **Not a multi-provider chat app.** Not ChatGPT with memory. Not an AI wrapper.
- **Not complicated.** Not full of options. Not asking questions. Not making users organize.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, TypeScript, Vite 5 |
| Styling | Tailwind CSS, shadcn/ui |
| Backend | Supabase (PostgreSQL, Edge Functions, Auth, RLS) |
| Vectors | pgvector with HNSW index, 768-dim embeddings |
| Agent Orchestration | Anthropic Claude (Sonnet) — single API for the full agent swarm |
| AI Classification | Google Gemini 2.5 Flash (via Lovable AI gateway) |
| Embeddings | OpenAI text-embedding-3-small (via Lovable AI gateway) |
| Web Research | Tavily API |
| Voice | ElevenLabs TTS/STT + Web Speech API |
| Notifications | Slack (2-way: inbound commands + outbound results) |
| Hosting | Lovable.dev |

---

## Architecture

```
USER (Web or Slack)
        │
        ▼
┌─────────────────┐
│  jac-dispatcher  │  ← Boss agent. Parses intent, dispatches workers.
│  (Edge Function) │     Claude Sonnet for intent parsing.
└────────┬────────┘
         │
    ┌────┼────────────────┐
    ▼    ▼                ▼
┌────────┐ ┌────────┐ ┌────────┐
│ Scout  │ │ Scribe │ │ Oracle │  ← Worker agents
│research│ │  save  │ │ search │
└────┬───┘ └────┬───┘ └────┬───┘
     │          │          │
     ▼          ▼          ▼
┌─────────────────────────────────┐
│           entries               │  ← The Brain
│         (PostgreSQL)            │
└─────────────────────────────────┘
         │
         ▼
┌─────────────────┐
│     Slack        │  ← Notifications + thread replies
└─────────────────┘
```

### Dump Pipeline
```
USER DUMPS SOMETHING
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
└─────────────────┘
```

---

## Component Hierarchy

```
pages/Dashboard.tsx          ← Page shell, hooks, state
├── DumpInput                ← Always visible. THE input.
├── Dashboard                ← Home view with entry sections
│   ├── QuickStats           ← Streak, hot topics, stale entries
│   ├── TagFilter            ← Filter by tag
│   ├── EntrySection[]       ← Grouped by type
│   │   └── EntryCard[]      ← Preview cards
│   └── EntryView            ← Full detail modal
│       ├── RelatedEntries   ← Connect layer
│       └── EnrichmentCard   ← Enrich layer
├── AssistantChat            ← Quick brain assistant (floating)
├── GlobalSearch             ← Semantic + keyword search
├── CalendarView             ← Calendar visualization
└── TimelineView             ← Timeline visualization

pages/Jac.tsx                ← JAC Command Center
├── JacChat                  ← Agent dispatch chat
├── AgentRoster              ← Worker agent cards
├── AgentResultsFeed         ← Live task results
└── ActivityFeed             ← Detailed activity log
```

---

## Priority Order (What to Build Next)

1. **Agents (extend)** — More agent types: cron scheduling, code execution, monitoring
2. **Connect (nail it)** — Make semantic connections reliable and surfaced proactively
3. **Enrich (ground it)** — Ground enrichment in real web data via Tavily
4. **Canvas (wow them)** — Dashboard transformation via Jac queries

---

## Success Looks Like

You send JAC a Slack message at 10pm: "Research the latest AI agent frameworks and save a summary." You wake up. The research is in your brain. The summary is in your Slack thread. You grab the code and keep building.

That moment — the moment your agents worked while you slept — is the product.

---

## Tone

Simple. Fast. No bullshit. **"Stop organizing. Start dumping. Let agents do the rest."**
