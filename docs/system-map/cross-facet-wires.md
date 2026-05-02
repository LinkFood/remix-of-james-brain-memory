# Cross-Facet Wires — Co-Trader ↔ JAC ↔ Duck Countdown

Three facets share Supabase project `rvhyotvklfowklzjahdd` and the same Voyage 512-dim embedding space. This map covers every wire crossing facet boundaries.

---

## 1. Co-Trader → JAC

### Direct table writes from `ct-*` into JAC tables

| writer (ct-*) | target table (JAC) | cadence | purpose |
| --- | --- | --- | --- |
| `ct-reflect-to-jac` | `jac_reflections` | daily 22:30 UTC | promotes notable Co-Trader decisions (last 24h) into JAC's reflection pipeline so JAC's weekly `distill-principles` Sonnet pass extracts patterns from trading outcomes alongside research outcomes |
| `ct-debate-outcome-scorer` | `brain_insights` | hourly | writes debate-resolution insights into the JAC brain insight feed (visible in `useProactiveInsights` hook) |

Sources of these decisions (read from):
- `ct-reflect-to-jac` reads `ct_claude_decisions`, `ct_contract_tracks`, `profiles`
- `ct-debate-outcome-scorer` reads `ct_debates`, `ct_price_ticks`, `brain_insights`

### Cross-facet reflection format

Co-Trader writes one `jac_reflections` row per user (typically just James). The reasoning field carries: *Co-Trader → JAC bridge: promoted N notable decisions from last 24h into M jac_reflections row(s). Summary: ...*

Then JAC's `distill-principles` (Sunday 03:00 UTC) reads `jac_reflections` and writes `jac_principles` — Co-Trader outcomes become input to JAC's strategic-principle-distillation pipeline.

---

## 2. JAC → Co-Trader

### Direct table reads

**None.** No `jac-*` edge function reads from any `ct_*` table.

### Implication

JAC has zero awareness of Co-Trader data at the function/table level. The flow is unidirectional Co-Trader → JAC at the data layer. JAC may surface Co-Trader signals via `brain_insights` and `jac_reflections` rows the bridge wrote — but JAC never queries `ct_*` tables directly.

---

## 3. Co-Trader ↔ Duck Countdown (DCD)

### `_shared/crossFacetMemory.ts`

First explicit cross-facet wire — Co-Trader queries DCD's 7M-entry vector brain (`hunt_knowledge`) when a trading question reaches outside Co-Trader's young corpus.

**Imported by:**
- `ct-chat`
- `ct-session-analog`

**Mechanics:**
- Embeds query with Voyage `voyage-3-lite` (512-dim, same as DCD)
- Calls DCD's vector RPC against `hunt_knowledge`
- Filters to `DCD_BRIDGE_TYPES` only — narrative/synthesis types like `bio-environmental-correlation`, `correlation-discovery`, `brain-narrative`
- Excludes raw EXTERNAL types (weather/bird/water) — keeps duck migration counts out of trading prompts
- Excludes INTERNAL types (DCD bookkeeping)
- Defense-in-depth filter on `du_*` / `bird*` / `migration` / `duck` prefixes in case BRIDGE namespace leaks
- Top 5 hits, graceful no-DCD fallback returns `[]`

### DCD → Co-Trader

**None.** DCD's `hunt-*` crons (82 active) live in this Postgres but the codebase is in `/Users/jameschellis/marsh-timer`. Nothing in `/Users/jameschellis/jac-agent-os` writes back to `hunt_*` tables. DCD writes are out-of-tree for this audit.

---

## 4. Shared infrastructure

### Slack

Single `SLACK_BOT_TOKEN` + `SLACK_SIGNING_SECRET` Supabase secret pair, used by both facets:

**JAC users:** `jac-dispatcher`, `jac-heartbeat`, `jac-morning-brief`, `slack-incoming` (HMAC-verified)  
**Co-Trader users:** `ct-preset-apply`, `ct-slack-push-flag`, `ct-system-warden`, `ct-slack-digest`, `ct-slack-slash`

Two distinct Slack helpers in `_shared/`:
- `_shared/slack.ts` — JAC's general-purpose Slack module
- `_shared/ctSlack.ts` — Co-Trader's specialized Slack helper

### Embeddings (Voyage AI 512-dim)

Single `VOYAGE_API_KEY`. Same embedding space across DCD, JAC, Co-Trader. Function `generate-embedding` (JAC) is the canonical embedding endpoint; Co-Trader uses `_shared/ctEmbed.ts:voyageEmbed` directly.

Producers using `VOYAGE_API_KEY` or `generate-embedding`:
- JAC: `jac-dispatcher`, `jac-heartbeat`, `jac-reflect`, `generate-embedding`, `backfill-embeddings`, `extract-entities`, `smart-save`, `find-related-entries`, `search-memory`
- Co-Trader: `ct-chat`, `ct-session-analog`, `ct-reflect-to-jac` (via crossFacetMemory)

### Vault (pg_cron auth)

Both facets' crons authenticate via the Postgres vault — `vault.decrypted_secrets WHERE name='supabase_url'` (or `project_url`) and `'service_role_key'`. Single rotation point for all 221 crons.

---

## 5. Audience-mode firewalls

Defined in `_shared/contextHelper.ts` and enforced inside the orchestrator `buildClaudeContext` (`_shared/claudeReadSurface.ts`).

### Audience modes

- `cotrader` — operational amplifier for James
- `paper_claude` — research-layer firewall (preserves original isolation contract)
- `analyst` — terminal-Claude analysis sessions
- `voice` — ElevenLabs voice surface (brevity-optimized)
- `slack` — Slack response context
- `agent_internal` — Co-Trader subsystem-to-subsystem

### Per-organ audience filtering

Implemented at `claudeReadSurface.ts:1965` —

```
if (h.audienceFilter && !h.audienceFilter.includes(audience)) {
  return { name, skipped: 'audience_filter' };
}
```

| organ | audience filter | rationale |
| --- | --- | --- |
| `flow_heatmap` | none | universal |
| `pulse` | none | universal |
| `tape` | none | universal |
| `specialist` | none | universal |
| `specialist_recall` | `cotrader` only | paper_claude must judge specialist quality from outside, without seeing track records |
| `james_flags` | `cotrader`, `analyst` | paper_claude excluded — preserves the post-2026-04-25 isolation experiment |
| `news_causality` | none | universal |
| `event_recency` | none | universal — every audience needs to know what just happened |
| `analogs` | none | universal |
| `detector` | none | universal |

### Read-set firewall (BLOCKED_READS)

Per-audience query gates surfaced in `blockedReadsForAudience()` (`claudeReadSurface.ts:781`).

**`paper_claude` cannot read:**
- `ct_trades WHERE trader='james'`
- `ct_book WHERE trader='james'`
- `ct_custom_rules WHERE trader='james'`
- `ct_james_reviews` (entire table)
- `ct_notes` (entire table)
- `ct_flags WHERE source='james_star'` (James's hand-labeled signals)

**`cotrader` / `analyst` / `voice` / `slack` / `agent_internal`:** empty block-list — they see all James-owned data, since Co-Trader is now an intelligence amplifier for James (not an independent paper trader).

### Where the firewall is enforced

1. **Per-organ filter** at `_shared/claudeReadSurface.ts:1965` — gates which helpers run.
2. **Block-set surfaced** at `claudeReadSurface.ts:2111` (`blockedFromReading: blockedReadsForAudience(audience)`) — included in the prompt context so Claude is told what it cannot read.
3. **Audience defaults to `cotrader`** at `claudeReadSurface.ts:806` — every consumer must opt in to a different audience explicitly.

Enforcement is a **prompt-level constraint**, not a query gate — the orchestrator does not strip blocked rows. Helpers must respect the audience the orchestrator passes them. `specialistRecallContext` and `jamesFlagsContext` both honor this with `audienceFilter`.

---

## 6. Cross-facet wires summary

| direction | wire | layer | status |
| --- | --- | --- | --- |
| Co-Trader → JAC | `ct-reflect-to-jac` writes `jac_reflections` | data | LIVE (daily 22:30 UTC) |
| Co-Trader → JAC | `ct-debate-outcome-scorer` writes `brain_insights` | data | LIVE |
| Co-Trader ← DCD | `crossFacetMemory.searchCrossFacet` reads `hunt_knowledge` | semantic recall | LIVE (`ct-chat`, `ct-session-analog`) |
| Co-Trader → DCD | none | — | — |
| JAC → Co-Trader | none (no `ct_*` reads from `jac-*` fns) | — | — |
| JAC → DCD | none | — | — |
| Slack | shared `SLACK_BOT_TOKEN` | infra | LIVE both facets |
| Embeddings | shared Voyage 512-dim space | infra | LIVE all 3 facets |
| Vault | shared pg_cron auth secrets | infra | LIVE all 3 facets |
