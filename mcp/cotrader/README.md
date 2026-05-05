# Co-Trader MCP — `cotrader`

Multi-tool MCP server that exposes Co-Trader's brain to terminal-Claude
sessions. When you ask terminal-Claude "what's the setup on NVDA right now?"
or "is the warden green?", the model can call this MCP to pull the same
payloads the operational specialists, tape-reader, and EOD bridge already
read internally.

**Six tools, all read-only:**

1. **`get_co_trader_context(ticker, include_regime?, organs?)`** (v1.1) —
   composed brain context for a single watchlist ticker. Regime + analogs,
   last 5 specialist reads, flow alerts + heatmap, James-flagged signals,
   news causality, event recency, observed-pattern detectors, pulse, tape.
2. **`get_observed_patterns(ticker?, status?, min_n?, limit?)`** (v2 Tier 1) —
   the forensic platform's catalog of statistically-confirmed patterns
   over Co-Trader flag history.
3. **`get_morning_brief(date?)`** (v2 Tier 1) — JAC's daily ~6 AM ET digest
   from `brain_reports`.
4. **`get_eod_summary(date?, verbose?)`** (v2 Tier 1) — Co-Trader's
   end-of-day session summary. Slim by default (~3k tokens); `verbose: true`
   for the full long-form markdown (~12k tokens).
5. **`get_warden_state(window_hours?)`** (v2 Tier 1) — System Warden
   invariant snapshot via the canonical `get_warden_health` RPC.
6. **`get_recent_james_flags(hours?, ticker?, limit?)`** (v2 Tier 1) — flags
   James personally starred from the /tape UI (`source='james_star'`).

Tier-1 candidate `get_brain_principles` was DROPPED per Phase A audit §9.1 —
the `brain_principles` table doesn't exist; the `distill-principles` cron
has been silently no-op'ing. Re-add as Tier 2 after the writer is fixed.

## v1.1 (2026-05-05) — three additive optimizations

- **`skipLegacyFlatFields` (internal):** the v1 tool passes this to
  `buildClaudeContext` so the legacy ~50-query serial block (which contributes
  ~10s of public-internet RTT) is bypassed. Other consumers (cron specialists,
  daily-brief, etc.) still get the full populated context.
- **5-min in-process TTL cache** on stable organs: `regime`, `event_recency`,
  `analogs`, `specialist_recall`, `james_flags`. Volatile organs are always
  fresh. Cache hits emit `ct_brain_telemetry` rows tagged `cache_hit:fresh_<sec>s`
  so the warden + `get_brain_health` stay populated.
- **`organs?: string[]` subset selection.** Pass an explicit list to scope the
  fetch (e.g., `organs=['regime','specialist_recall']` for a sub-second
  response). Unknown names: warn-and-fetch-recognized unless ALL provided are
  unknown (then hard-fail). Default = all 11.

**Measured perf for `get_co_trader_context` (smoke 2026-05-05):**

- Cold full call: ~1.5s (down from v1's ~13s — **8.4× faster**)
- Warm full call (5 stable cache hits): ~390ms
- Subset call after warm-up (`regime` + `specialist_recall`): ~1ms
- Token budget: ~30k tokens (unchanged from v1 — same composed organ payload)

## v2 Tier 1 (2026-05-05) — five new direct-read tools

Tools 2-6 are **direct table/RPC reads**, not multi-organ chains. Each is
sub-200ms and well under the 8k-token-per-response budget by default.

**Measured perf (smoke 2026-05-05):**

| Tool | Latency | Tokens (default) |
|---|---|---|
| `get_observed_patterns` | ~130ms | ~1,500 |
| `get_morning_brief` | ~150ms | ~1,200 |
| `get_eod_summary` (slim) | ~140ms | ~2,600 |
| `get_warden_state` | ~110ms | ~300 |
| `get_recent_james_flags` | ~150ms | ~80 (zero rows on most days) |

`get_eod_summary({verbose: true})` opts into the full ~12k-token payload
(long-form `summary_text` + every recap JSONB block). Use only when the slim
view doesn't carry the answer.

## Run locally

From the repo root:

```bash
deno task --cwd mcp/cotrader start
# or:
cd mcp/cotrader && deno run --allow-all server.ts
```

The server speaks MCP over stdio. It logs to **stderr** only — stdout is the
protocol channel. You'll see one `[cotrader-mcp]` line per tool call.

## Register with Claude Code

```bash
claude mcp add --transport stdio --scope project \
  --env SUPABASE_URL=https://rvhyotvklfowklzjahdd.supabase.co \
  --env SUPABASE_SERVICE_ROLE_KEY="$(npx supabase projects api-keys --project-ref rvhyotvklfowklzjahdd | grep service_role | awk '{print $NF}')" \
  --env VOYAGE_API_KEY="${VOYAGE_API_KEY}" \
  cotrader -- deno run --allow-all "${PWD}/mcp/cotrader/server.ts"
```

That writes `.mcp.json` at the repo root. The resulting entry looks like:

```json
{
  "mcpServers": {
    "cotrader": {
      "type": "stdio",
      "command": "deno",
      "args": ["run", "--allow-all", "${PWD}/mcp/cotrader/server.ts"],
      "env": {
        "SUPABASE_URL": "https://rvhyotvklfowklzjahdd.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "${SUPABASE_SERVICE_ROLE_KEY}",
        "VOYAGE_API_KEY": "${VOYAGE_API_KEY}"
      }
    }
  }
}
```

`.mcp.json` is checkable into git — it uses `${VAR}` env-expansion so the
actual keys never land on disk.

`SUPABASE_SERVICE_ROLE_KEY` is the only required secret. Without
`VOYAGE_API_KEY` the server still runs but the regime organ silently degrades
(see "Cost model" below). The five v2 Tier 1 tools don't touch Voyage at all.

The Public MCP and any other registered servers keep working alongside —
Claude Code loads all of them in parallel per session.

## Example terminal-Claude usage

Once registered, in a terminal-Claude session:

> *"Pull NVDA's full Co-Trader read. What's specialist conviction, what's the
> regime, and what's the heatmap saying about next week's expiry?"*
> → `get_co_trader_context({ticker: "NVDA"})`

> *"What patterns has the system validated lately?"*
> → `get_observed_patterns({})` — returns top recently-validated patterns.

> *"What was in this morning's brief?"*
> → `get_morning_brief({})` — today's brief, defaulting to yesterday before 6 AM ET.

> *"How did yesterday's session grade out?"*
> → `get_eod_summary({})` — slim payload for the most-recent completed session.

> *"Show me the full EOD narrative for May 4."*
> → `get_eod_summary({date: "2026-05-04", verbose: true})`.

> *"Is the system healthy right now?"*
> → `get_warden_state({})` — totals + by-category + sorted failures with runbook paths.

> *"What did I flag yesterday?"*
> → `get_recent_james_flags({})` — last 24h of James's hand-starred signals.

> *"What forensic patterns has TSLA picked up?"*
> → `get_observed_patterns({ticker: "TSLA"})`.

> *"Did anything fail in the warden over the past week?"*
> → `get_warden_state({window_hours: 168})`.

### Routing notes (terminal-Claude pattern matching)

- "what JAC distilled" / "what principles" → currently no tool answers this
  (Tier 2 once `distill-principles` writer is fixed).
- "what's the setup on \<ticker\>" / per-ticker brain context → `get_co_trader_context`
- "validated patterns" / "observed-pattern catalog" → `get_observed_patterns`
- "morning brief" / "today's schedule per JAC" → `get_morning_brief`
- "EOD report" / "session grade" / "tomorrow's watchlist" → `get_eod_summary`
- "warden green" / "system healthy" / "any alarms" → `get_warden_state`
- "what I flagged" / "my hand-labeled signals" → `get_recent_james_flags`

## Privacy / firewall notes

**Morning brief content is private journal-grade.** `get_morning_brief` may
surface personal scheduling content (calendar items, errands, family/coworker
names, financial reminders). Any MCP transcript containing brief output
should be treated like private journal — never paste into shared logs, public
PRs, or external chat.

**Read-only firewall.** This server uses Supabase service-role for `SELECT`
only. The only `INSERT` calls are best-effort fire-and-forget telemetry rows
to `ct_brain_telemetry` (helper_name='tool:<name>', consumer_name='cotrader-mcp')
mirroring the v1 cache_hit telemetry pattern. No `.update()`, no `.delete()`
on any other table. Telemetry never blocks; failures are swallowed.

If you find a write call here on any other table, it's a bug — file it.

## Verifying the install

```bash
cd mcp/cotrader && deno task smoke
```

The smoke test boots all six tools and asserts:

- v1 (19 checks preserved): cold latency, cache hits, subset scoping,
  unknown-organ validation, `include_regime: false` skip.
- v2 (25 new checks): each new tool returns a typed payload, latency under
  5s, response under 8k tokens, default args resolve correctly. James-flag
  off-universe ticker rejection. EOD slim default excludes `summary_text`.

Total: 44 checks. Exit code 0 on full pass, 1 on any failure.

## Cost + latency model

### Cost

| Source | Per call |
|---|---|
| UW MCP (write-path only on ingesters) | $0 |
| Anthropic API (no inference inside the brain) | $0 |
| Anthropic API (terminal-Claude reasoning over the response) | covered by Max 20x — free per call |
| Voyage embeddings (regime organ only, ~80 tokens, 60s in-isolate cache) | ~$0.0000016 |
| Postgres reads | included in Supabase Pro |

At 50 calls/day this is ~$0.024/year for Voyage. Structurally free.

The `regime` organ inside `get_co_trader_context` is the only path that
touches Voyage at runtime. Pass `include_regime: false` to skip it. None of
the v2 Tier 1 tools touch Voyage.

### Payload size + latency for `get_co_trader_context` (measured 2026-05-05 on production data)

- **Per-call payload: ~32k tokens.** Composition: `news_causality` ~6k,
  `detector` ~5k, `event_recency` ~4k, `tape` ~2k, `specialist_recall` ~600,
  `specialist` ~300, others trivial. The Phase A audit estimated ~6k; reality
  is bigger because the operational specialists need 24h+ of news and event
  context to make decisions, and the same composer feeds both. Truncating to
  fit a smaller cap would deprive terminal-Claude of signal the cron
  specialists already get.
- **Warm latency: ~13s** for the full 10-organ chain.
- **Production helper p95 (per `ct_brain_telemetry`): 470-617ms** running
  inside Supabase Edge co-located with Postgres.
- **Why the gap:** the MCP runs as a local Deno process on your laptop and
  hits Supabase across the public internet. The brain composer makes ~50
  PostgREST queries; each round-trip is ~150-200ms from outside the Supabase
  region. ~50 × 200ms = the 13s wall-clock. This is the cost of the
  architectural decision in the Phase A audit (direct import → no new edge
  function) versus an in-region REST proxy (which the brief explicitly
  forbade).
- **In context:** terminal-Claude's per-tool-call budget is huge, and James
  invokes this conversationally (one call per minute, not 100/sec). 13s for
  full brain context vs no context at all is the right trade.

For cheap quick-lookups where you don't need the full brain, pass
`include_regime: false` (skips the Voyage embed and a few HNSW reads but
doesn't materially change the wall-clock).

### v2 Tier 1 tools — direct-read perf

The five v2 tools are single SELECT or RPC calls — sub-200ms each, not the
multi-organ ~1.5-13s cost of `get_co_trader_context`. See the perf table at
the top of the v2 section.

## Read-only firewall

This server uses Supabase service-role for `SELECT` only. There is no
`.update()`, `.delete()`, or `.upsert()` anywhere in this codebase.
The only `.insert()` calls are best-effort telemetry rows to
`ct_brain_telemetry` — same shape `buildClaudeContext` already writes for
every organ outcome. The brain helpers it imports are also read-only by their
authoring contract (`_shared/contextHelper.ts` — "PURE READ. No DB writes.
No side effects beyond optional logging").

If you find a write call here on any other table, it's a bug — file it.

## Why these design choices

These come straight out of the Phase A audits
(`docs/audit/2026-05-02-cotrader-mcp-phase-a.md` for v1 and
`docs/audit/2026-05-05-cotrader-mcp-v2-tier1-phase-a.md` for v2 Tier 1).
Worth knowing because the default reading suggests something different.

### Why `audience: 'cotrader'` and not `'analyst'` (v1 tool)

Two reasons. **Functional:** the `specialist_recall` organ is gated to
`audienceFilter: ['cotrader']` only. With `audience: 'analyst'` the helper
silently skips, and the MCP loses the highest-value piece of per-ticker
context (last 5 reads on the ticker by the ticker's own specialist).
**Conceptual:** when James opens terminal-Claude at 09:35 ET on a Tuesday and
asks "what's the setup on NVDA," that *is* cotrader use — it's the operational
amplifier reaching James through a chat surface instead of a UI page. Tenet 1
("autonomous detection, human execution") puts terminal-Claude on the
human-execution side of the line. The `analyst` audience was originally
framed for human-analyst-grading-the-system sessions, which is a different
context.

Telemetry separation is preserved via `consumerName: 'cotrader-mcp'` —
the audience field stays `cotrader` (so the right organs run), but every row
in `ct_brain_telemetry` written from this MCP is tagged distinctly and
auditable separately from the operational specialists.

### Why v2 tools share `ct_brain_telemetry` instead of a new table

Per Phase A audit §9.2, James opted for telemetry shape (A): reuse the
existing `ct_brain_telemetry` table with `helper_name='tool:<name>'`,
`consumer_name='cotrader-mcp'`. No new migration; the table already
accommodates the prefixed convention (verified 2026-05-05). Dashboard
organ-coverage queries that filter brain organs only need to add
`helper_name NOT LIKE 'tool:%'` once `get_brain_health` adds tool-call
visibility.

### Why `regime` is on by default with an opt-out

The regime organ is the only one that touches Voyage at runtime
(`isExpensive: true`, ~$0.0000016/call). It also returns the most
decision-relevant single payload — current Pulse v2 classification +
historical analogs with their next-bucket outcomes. Disabling by default
would gut the MCP's value for marginal cost savings. The `include_regime:
false` flag exists for cheap quick-lookups where the caller knows they don't
need regime context (e.g., "is QQQ flow ask-aggressive right now").

### Why Deno and not Node

The brain helpers live in `supabase/functions/_shared/*.ts` and use Deno URL
imports (`https://esm.sh/...`). A Node MCP server can't import them
directly — it would force either re-implementing the synthesis layer
(duplication) or building a REST proxy edge function (forbidden by the
"no new edge function" constraint in the build brief). Deno + `npm:@modelcontextprotocol/sdk@1.29.0`
imports the existing helpers as-is, no proxy layer, no duplication.

## Constraints

- **Read-only.** Service-role for SELECT only.
- **Six tools** in v2 Tier 1 (`get_brain_principles` deferred to Tier 2 —
  see Phase A audit §9.1).
- **No site Anthropic budget.** This server never calls Claude.
- **Doesn't touch C1.** Doesn't modify `_shared/specialistRecallContext.ts`
  or `_shared/specialistRunner.ts`. The MCP is a NEW client; existing
  clients are byte-identical to current `main`.
- **Universe-locked.** `get_co_trader_context` and `get_recent_james_flags`
  hard-validate ticker against the 10-name list. `get_observed_patterns`
  soft-validates (warns + queries — pattern signatures don't always carry an
  instrument key, off-universe returns empty cleanly).

## File layout

```
mcp/cotrader/
├── server.ts                        # MCP entrypoint, registers all 6 tools
├── deno.json                        # tasks: start, smoke
├── smoke-test.ts                    # v1 (19 checks) + v2 (25 checks)
├── tools/
│   ├── get_co_trader_context.ts     # v1.1 — composed brain context
│   ├── get_observed_patterns.ts     # v2 — forensic pattern catalog
│   ├── get_morning_brief.ts         # v2 — JAC daily 6 AM ET digest
│   ├── get_eod_summary.ts           # v2 — EOD session (slim/verbose)
│   ├── get_warden_state.ts          # v2 — warden invariant snapshot
│   └── get_recent_james_flags.ts    # v2 — James-starred /tape flags
├── lib/
│   ├── auth.ts                      # service-role resolver (env or npx fallback)
│   ├── universe.ts                  # 10-ticker hardcoded validator
│   └── organ_cache.ts               # 5-min TTL stable-organ cache (v1.1)
└── README.md
```
