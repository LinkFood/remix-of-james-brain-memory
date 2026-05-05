# Co-Trader MCP — `cotrader`

Single-tool MCP server that exposes Co-Trader's composed brain context to
terminal-Claude sessions. When you ask terminal-Claude "what's the setup on
NVDA right now?", the model can call this MCP to pull the same payload the
operational specialists, tape-reader, and EOD bridge already read internally.

**One tool: `get_co_trader_context(ticker, include_regime?, organs?)`.**
Returns regime classification + analogs, last 5 specialist reads (flagged +
unflagged-conv-≥50), recent flow alerts, flow heatmap stacks, James-flagged
signals, news causality, event recency, observed-pattern detectors, pulse
state, and tape narration.

**v1.1 (2026-05-05) — three additive optimizations:**

- **`skipLegacyFlatFields` (internal):** the MCP passes this to
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

**Measured perf (smoke 2026-05-05):**

- Cold full call: ~1.5s (down from v1's ~13s — **8.4× faster**)
- Warm full call (5 stable cache hits): ~390ms
- Subset call after warm-up (`regime` + `specialist_recall`): ~1ms
- Token budget: ~30k tokens (unchanged from v1 — same composed organ payload)

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
(see "Cost model" below).

The Public MCP and any other registered servers keep working alongside —
Claude Code loads all of them in parallel per session.

## Example terminal-Claude usage

Once registered, in a terminal-Claude session:

> *"Pull NVDA's full Co-Trader read. What's specialist conviction, what's the
> regime, and what's the heatmap saying about next week's expiry?"*

The model will call `get_co_trader_context({ticker: "NVDA"})`, get back the
composed JSON, and synthesize the answer.

For a cheap quick lookup that skips the Voyage embed:

> *"Is QQQ flow ask-aggressive right now? Skip regime."*
> → calls with `{ticker: "QQQ", include_regime: false}`.

## Verifying the install

```bash
cd mcp/cotrader && deno task smoke
```

The smoke test boots the brain context for `NVDA` and asserts:

- Tool returns within ~2s p95
- `organs` map present, ≥5 helpers ran
- `specialist`, `flow_heatmap`, `specialist_recall` all returned
- Total payload ≤ 8k tokens
- `audience === 'cotrader'`
- `preamble` block present

Exit code 0 on full pass, 1 on any check failure.

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

The `regime` organ is the only one that touches Voyage at runtime. Pass
`include_regime: false` to skip it entirely.

### Payload size + latency (measured 2026-05-05 on production data)

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

## Read-only firewall

This server uses Supabase service-role for `SELECT` only. There is no
`.insert()`, `.update()`, `.delete()`, or `.upsert()` anywhere in this
codebase. The brain helpers it imports are also read-only by their
authoring contract (`_shared/contextHelper.ts` — "PURE READ. No DB writes.
No side effects beyond optional logging").

If you find a write call here, it's a bug — file it.

## Why these design choices

These come straight out of the Phase A audit
(`docs/audit/2026-05-02-cotrader-mcp-phase-a.md`). Worth knowing because the
default reading suggests something different.

### Why `audience: 'cotrader'` and not `'analyst'`

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

## Constraints (per scope/2026-05-02-cotrader-mcp-server.md)

- **Read-only.** Service-role for SELECT only.
- **One tool.** v1 ships `get_co_trader_context`. Other tools
  (`get_brain_principles`, `find_similar_setups`) are explicitly v2.
- **No site Anthropic budget.** This server never calls Claude.
- **Doesn't touch C1.** Doesn't modify `_shared/specialistRecallContext.ts`
  or `_shared/specialistRunner.ts`. The MCP is a NEW client; existing
  clients are byte-identical to current `main`.
- **Universe-locked.** Tool validates ticker against the 10-name list
  (`mcp/cotrader/lib/universe.ts`). Off-watchlist queries reject with a
  clear error.

## File layout

```
mcp/cotrader/
├── server.ts                     # MCP entrypoint, stdio transport
├── deno.json                     # tasks: start, smoke
├── smoke-test.ts                 # boots brain, asserts shape + cap
├── tools/
│   └── get_co_trader_context.ts  # the v1 single tool
├── lib/
│   ├── auth.ts                   # service-role resolver (env or npx fallback)
│   └── universe.ts               # 10-ticker hardcoded validator
└── README.md
```
