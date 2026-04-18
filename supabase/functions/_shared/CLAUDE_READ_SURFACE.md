# Claude Read Surface — Isolation Contract

Claude runs its own paper account (starts at $100k) in parallel to James. For Claude to stay an **independent trader**, it must not see James's book, James's private rules, or James's thumbs-up/down reviews. This document is the contract; `claudeReadSurface.ts` enforces it.

## What Claude Reads

All context assembled in `buildClaudeContext()`:

- **Market data** — `ct_heartbeats` (objective snapshot; shared infrastructure)
- **Its own open hypotheses** — `ct_hypotheses` where `status='open'`
- **Its own hypothesis events** — `ct_hypothesis_events` for those open hypotheses
- **Its own trades** — `ct_trades` where `trader='claude'` (open + recent closed)
- **Its own armed trade ideas** — `ct_trade_ideas` where `trader='claude'` AND `status='armed'`
- **Grades linked to a hypothesis** — `ct_grades` where `hypothesis_id is not null`
- **Its own paper book** — `ct_book` where `trader='claude'` (for current balance only)
- **Config snapshot** — autonomy mode, size caps, min confidence, etc.

## What Claude Does NOT Read

Hard-blocked — never queried by `buildClaudeContext`, ever:

- `ct_trades` where `trader='james'` — James's trades are invisible
- `ct_book` where `trader='james'` — James's P&L is invisible
- `ct_custom_rules` where `trader='james'` — James's private rules are invisible (until a `share_with_claude` column is added)
- `ct_james_reviews` — the entire table. James's after-the-fact thumbs are write-only from Claude's perspective
- `ct_notes` — James's private notes table, if it exists

The `blockedFromReading` field on every `ClaudeContext` echoes this list verbatim so log readers can prove what was off-limits.

## How James's Chat Flows In

James's chat is advisory, not command. The `claude_chat_is_advisory` config flag controls this:

- `true` (default) — when a persistent chat table exists, the last ~10 messages get injected as an **"ADVISORY INPUT FROM JAMES"** block. The system prompt tells Claude to "consider if useful, ignore if not." Claude is never bound by what James says.
- `false` — chat context is empty. Claude operates purely from market data and its own reasoning. The preamble flips to reflect this.

**Current state:** chat lives in client-side `localStorage` (see `src/components/command/ChatPanel.tsx`). There is no server-side chat table. Until one exists, `advisoryChatContext=''` and `chatIsAdvisory=false` regardless of the config flag. The TODO in `claudeReadSurface.ts` marks where the query goes when a table lands.

## How James's Reviews Flow

**One direction only: in.** James drops thumbs on Claude's trades after the fact into `ct_james_reviews`. That table is never read by any Claude-facing function. It exists for James's own post-hoc analysis and UI display — Claude stays independent of it.

## How to Extend the Surface

When a new Claude-facing function needs more data:

1. Decide if the data is **Claude-owned** (its own reasoning, trades, grades) or **shared objective** (market state, news, heartbeats). If neither, stop — James-owned data doesn't cross the line without an explicit consent flag (e.g., a future `share_with_claude` column).
2. Add the field to the `ClaudeContext` interface in `claudeReadSurface.ts`.
3. Add the query inside `buildClaudeContext`. Use `.eq('trader', 'claude')` on any trader-bearing table.
4. If the new data changes how Claude should behave, update `claudeSystemPromptPreamble()` so the narration stays honest.
5. If the surface now touches a new table, update both:
   - The `BLOCKED_READS` comment header in `claudeReadSurface.ts`
   - The "What Claude Reads" / "What Claude Does NOT Read" lists in this doc.

## Enforcement

- Every Claude-facing edge function imports `buildClaudeContext` and `claudeSystemPromptPreamble` from `_shared/claudeReadSurface.ts`.
- Functions prepend `claudeSystemPromptPreamble(ctx)` to their system prompt.
- Direct reads of `ct_trades` / `ct_book` / `ct_custom_rules` / `ct_james_reviews` / `ct_notes` from Claude-facing functions are a contract violation. Reviewers: flag them.

## Non-Claude Functions (Not Governed By This Contract)

The following functions are James-facing or shared infrastructure and may read James-side data freely:

- `ct-chat` — James is talking to it; of course it reads his book.
- `ct-watcher` — shared observer; writes both Claude-authored and James-facing rows.
- `ct-grader` — grades both sides; writes `hypothesis_id` to link back.
- `ct-book-manager`, `ct-book-eod-close`, `ct-drawdown-watch` — James-side accounting.
- Any UI-facing RPC called from `/src` routes.

Contract applies to: `ct-hypothesis-proposer`, `ct-hypothesis-health-check`, `ct-hypothesis-confidence-update`, `ct-hypothesis-reaper`, `_shared/hypothesisSelect.ts`, and any future function that generates Claude's own trades, theses, or reasoning.
