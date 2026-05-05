# Co-Trader MCP — Phase A audit

> Pre-build audit per `scope/2026-05-02-cotrader-mcp-server.md`. **Phase B is gated on James's approval of this doc + resolution of the two surfaced conflicts (§9).**

Date: 2026-05-05 (audit ran today; doc dated to brief filename per scope spec).
Auditor: terminal-Claude (Opus 4.7, 1M context).

---

## 1. MCP SDK landscape — Deno vs Node

**Canonical SDK:** `@modelcontextprotocol/sdk` (npm, namespace `@modelcontextprotocol`). Latest stable v1.29.0 (early 2026). v2 anticipated Q1 2026; v1.x is the recommended production line and will receive bug/security fixes ≥6 months after v2 ships. Source: [npm](https://www.npmjs.com/package/@modelcontextprotocol/sdk), [official typescript-sdk repo](https://github.com/modelcontextprotocol/typescript-sdk).

**Runtime — recommend Deno.** Reasoning:
- This repo's backend (`supabase/functions/_shared/*`) is **Deno-native**: `import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0'` URL imports throughout the brain organs.
- A **Node** MCP server cannot import the Deno organs directly (URL imports don't resolve in Node) → would force either re-implementing the orchestrator (duplication) or building a REST proxy edge function (forbidden by brief constraint, see §3 below).
- Deno supports `npm:@modelcontextprotocol/sdk@1.29.0` import natively → SDK access is one-liner from a Deno entrypoint.
- Same Supabase client pin (`@2.84.0`), same auth helpers, same telemetry shape — zero dependency surface drift.
- `package.json` exists in repo (frontend Vite uses it) but the MCP server stays separate from frontend toolchain.

**Decision recorded:** Deno runtime + `npm:@modelcontextprotocol/sdk@1.29.0`. If Deno's MCP support reveals an undocumented gap during Phase B, fall back to Node + REST proxy and re-surface that as a constraint break.

---

## 2. `buildClaudeContext` — signature, audiences, organ costs

**Signature** (`supabase/functions/_shared/claudeReadSurface.ts:803-806`):
```ts
export async function buildClaudeContext(
  supabase: SupabaseClient,
  opts: BuildClaudeContextOpts = {},
): Promise<ClaudeContext>
```

**Relevant `BuildClaudeContextOpts` fields for MCP:**
- `audience?: AudienceMode` — defaults to `'cotrader'`. Enum: `cotrader | paper_claude | analyst | voice | slack | agent_internal`.
- `consumerName?: string` — for telemetry on `ct_brain_telemetry`. Default `'unknown'`.
- `organs?: readonly HelperName[] | 'all'` — whitelist; `'all'` runs every helper gated by audience.
- `tickerFocus?: string` — single-ticker scope passed to every helper that supports it.
- `perOrganOpts?: Partial<Record<HelperName, HelperOpts>>` — per-organ caps/lookback overrides.

**11 brain organs** (synthesis layer Phase 11 added `regime` 2026-05-02):

| Organ | `isExpensive` | `audienceFilter` | Voyage call? | Claude/Anthropic call? |
|---|---|---|---|---|
| `flow_heatmap` | false | undefined (all) | no | no |
| `pulse` | false | undefined (all) | no | no |
| `specialist` | false | undefined (all) | no | no |
| `detector` | false | undefined (all) | no | no |
| `tape` | false | undefined (all) | no | no |
| `james_flags` | false | `AUDIENCE_FILTER` (verify before use) | no | no |
| `news_causality` | false | undefined (all) | no | no |
| `event_recency` | false | undefined (all) | no | no |
| `analogs` | false | undefined (all) | no (HNSW only) | no |
| `specialist_recall` | false | **`['cotrader']` only** | no | no |
| `regime` | **true** | **`['cotrader','analyst']`** | **yes (voyageEmbed at runtime, 60s in-isolate cache)** | no |

**Key findings:**
- **Zero Anthropic API calls anywhere in `buildClaudeContext`.** Pure data composition; no inference cost.
- **Voyage cost is exclusive to `regime` organ.** ~80 input tokens per call, 60s cache shaves duplicates. See §8.
- **`specialist_recall` is gated to `['cotrader']` audience only** → if MCP uses `audience: 'analyst'`, the organ is silently skipped. **This is conflict #2 in §9.**
- All other 10 organs are pure SQL reads (Postgres only).

**Invocability from non-edge context:** Yes, IF the runtime is Deno (URL imports resolve). The Deno MCP process can `import { buildClaudeContext } from '../../supabase/functions/_shared/claudeReadSurface.ts'` and instantiate a `SupabaseClient` with service-role auth. **No edge-function-specific globals are referenced in the helper signatures** (no `Deno.env`, no `serve(...)` — those live in consumer wrappers).

---

## 3. Existing CT REST surface

**No existing endpoint exposes composed context as a JSON payload.** Every consumer of `buildClaudeContext` is a full Claude-invoking edge function (`ct-chat`, `ct-daily-brief`, `ct-hypothesis-proposer`, `ct-tape-reader`, `ct-eod-report`, etc., 18 total). They consume the context internally and return inference output, not raw context.

**`ct-chat` shape** (the closest analog): accepts `{message, history}`, calls `buildClaudeContext({audience: 'cotrader'})` internally, then forwards composed context + user message to Anthropic. Adding a `context_only=true` switch would modify `ct-chat` — violates brief's "byte-identical existing clients" constraint.

**Recommendation:** Direct import of `claudeReadSurface.ts` from a Deno MCP process. No new edge function, no modification to existing functions, no REST proxy. Consistent with brief constraint "no new edge function."

---

## 4. Supabase service-role auth pattern

**Canonical pattern** (used by `scripts/heatmap_backfill.sh`, `scripts/ct_price_backfill.py`, `scripts/linkjac_cotrader_watch.sh`):

```bash
SR_KEY=$(npx supabase projects api-keys --project-ref rvhyotvklfowklzjahdd \
  | grep service_role | awk '{print $NF}')
```

Project URL hardcoded across all scripts: `https://rvhyotvklfowklzjahdd.supabase.co`. No env var convention required for URL.

**MCP recommendation — dual-mode:**
- **Primary:** `SUPABASE_SERVICE_ROLE_KEY` env var (set in `claude mcp add --env` flag). Resolves at process boot, lives in process memory only.
- **Fallback:** if env var absent, shell out to the `npx supabase projects api-keys ...` CLI exactly as the scripts do. Matches existing operator muscle memory.
- Project URL: hardcode `https://rvhyotvklfowklzjahdd.supabase.co` (per Tenet 4 — universe is locked, project is locked).

**Never** hardcode the key. Never log the key. Never include it in any error message body. `mcp.json` registration uses `${SUPABASE_SERVICE_ROLE_KEY}` env-expansion (Claude Code MCP supports this — see §6).

---

## 5. Repo placement

**Existing top-level dirs:** `src/` (frontend), `supabase/` (backend), `scripts/` (one-off ops), `docs/`, `dist/`, `public/`, `node_modules/`. No `services/`, no `tools/`.

**Recommendation: new top-level `mcp/cotrader/`.**

- `mcp/` namespace makes intent visible (this is an MCP server, not a deployed service, not a one-off script).
- `cotrader` subdir reserves room for `mcp/jac/` (cross-facet MCP for JAC's brain) and others without renaming.
- Parallel to `scripts/` (the closest analog: local-execution tools that aren't deployed) but distinct because MCP servers are long-lived, registered, and have a stdio protocol contract.
- Easy `claude mcp add --transport stdio cotrader -- deno run --allow-all /Users/jameschellis/jac-agent-os/mcp/cotrader/server.ts` registration.

Layout:
```
mcp/cotrader/
├── server.ts                  # MCP entrypoint, stdio transport
├── tools/
│   └── get_co_trader_context.ts  # the one v1 tool
├── lib/
│   ├── auth.ts                # service-role resolver (env or npx fallback)
│   └── universe.ts            # 10-ticker validator (hardcoded per Tenet 4)
├── README.md
└── smoke-test.ts              # boots server, calls tool, asserts shape + token cap
```

---

## 6. Claude Code MCP config + multi-MCP loading

**Canonical registration command** (Claude Code official docs):

```bash
claude mcp add --transport stdio --scope project \
  --env SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY} \
  cotrader -- deno run --allow-all /Users/jameschellis/jac-agent-os/mcp/cotrader/server.ts
```

**Three scopes:**
- `local` (default) — per-machine, this directory only
- `project` — `.mcp.json` at repo root, checkable into git, env-expansion supported
- `user` — cross-project, lives in user-level config

**Recommend `project` scope.** Generates `.mcp.json` at repo root. Env vars expand from shell at runtime — actual key never written to disk. Repo-checkable so future-James (or sibling sessions) gets the registration for free.

**Resulting `.mcp.json` snippet:**
```json
{
  "mcpServers": {
    "cotrader": {
      "type": "stdio",
      "command": "deno",
      "args": ["run", "--allow-all", "${PWD}/mcp/cotrader/server.ts"],
      "env": {
        "SUPABASE_SERVICE_ROLE_KEY": "${SUPABASE_SERVICE_ROLE_KEY}"
      }
    }
  }
}
```

**Multi-MCP parallel loading: confirmed.** Claude Code loads all registered MCPs in one session. James's existing Public MCP keeps working alongside; tool calls from terminal-Claude can hit either freely. Per [Claude Code MCP docs](https://code.claude.com/docs/en/mcp): `claude mcp list` enumerates all active servers per session.

---

## 7. Sample analyst-mode output for `get_co_trader_context('NVDA')`

**Output shape** (assuming MCP uses `audience: 'cotrader'`, `tickerFocus: 'NVDA'`, organs: 'all' — see §9 conflict #2):

```json
{
  "version": "v1",
  "meta": {
    "audience": "cotrader",
    "consumerName": "cotrader-mcp",
    "sessionDate": "2026-05-05",
    "sessionDayName": "Tuesday",
    "nowEt": "2026-05-05T09:35:12-04:00",
    "nowUtc": "2026-05-05T13:35:12Z",
    "tickerFocus": "NVDA",
    "helpersInvoked": ["flow_heatmap","pulse","specialist","detector","tape","james_flags","news_causality","event_recency","analogs","specialist_recall","regime"],
    "helpersSkipped": [],
    "totalLatencyMs": 412
  },
  "preamble": {
    "temporalAnchor": "Today is Tuesday 2026-05-05. RTH 09:30–16:00 ET. ...",
    "whatJustHappened": "- 2026-05-04 close: SPY -0.4%, QQQ -0.7% on broad-tech weakness.\n- 2026-05-04 22:00 UTC: NVDA insider Form 4 — CFO sale ~$8M.\n- 2026-05-03 weekend: no material macro prints."
  },
  "organs": {
    "regime": {
      "data": {
        "marketWide": {"classification": "chop_high_dispersion", "confidence": 71, ...},
        "perTicker": {"NVDA": {"classification": "decaying", "confidence": 100, ...}},
        "analogs": [{"bucket_ts": "...", "next_classification": "trending_down_steady", "similarity": 0.91}, ...]
      },
      "meta": {"helperName": "regime", "latencyMs": 180, "cacheHit": false, ...}
    },
    "specialist_recall": {
      "data": {
        "ticker": "NVDA",
        "lastFlagged": [/* 5 reads with flag verdict (correct/wrong/pending) */],
        "lastUnflagged": [/* 5 high-conviction non-flags */]
      }
    },
    "specialist": {
      "data": {
        "NVDA": {"latestRead": "...", "conviction": 65, "directional_bias": "bearish", ...}
      }
    },
    "flow_heatmap": {
      "data": {"NVDA": {"stacks": [{"expiry_bucket_week": "2026-05-09", "value": 12450000, "source_alert_count": 18}, ...]}}
    },
    "tape": { "data": {"NVDA": "narration paragraph from ct-tape-reader"} },
    "james_flags": { "data": {"NVDA": [/* recent ★ marks */]} },
    "news_causality": { "data": {"NVDA": [/* annotated headlines */]} },
    "event_recency": { "data": {"justHappened": [...], "upcoming": [...]} },
    "analogs": { "data": [/* ct_session_embeddings nearest neighbors */] },
    "detector": { "data": {"NVDA": [/* live + recent flags by detector */]} },
    "pulse": { "data": {"NVDA": [/* recent NOPE / net-prem ticks */]} }
  }
}
```

**Token budget estimate at `tickerFocus='NVDA'`:**
- Preamble: ~400 tok
- regime (full classification + analogs): ~600 tok
- specialist + specialist_recall: ~1,200 tok
- flow_heatmap (NVDA stacks only): ~300 tok
- tape (NVDA narration): ~600 tok
- james_flags + news_causality + event_recency: ~1,500 tok combined
- detector + pulse: ~700 tok
- analogs: ~400 tok
- meta + structural overhead: ~300 tok

**Total: ~6,000 tokens.** Well within the ≤8k target. Without `tickerFocus` (full watchlist), expect ~9–11k → would breach budget. **Recommend tool requires `ticker` arg (already in brief spec).**

**Format:** Returned as structured JSON over MCP protocol. Terminal-Claude renders inline, can grep/inspect any organ. Markdown narration fields (`tape`, `whatJustHappened`) read naturally in chat.

---

## 8. Cost / call-volume model

| Cost source | Per call | At 50 calls/day | At 200 calls/day |
|---|---|---|---|
| UW MCP | 0 | $0.00 | $0.00 |
| Anthropic API (CT side) | 0 | $0.00 | $0.00 |
| Anthropic API (terminal-Claude reasoning over response) | covered by Max 20x | free | free |
| Voyage embeddings (regime organ only, ~80 tokens, 60s cache) | ~$0.0000016 | ~$0.00008 | ~$0.00032 |
| Postgres reads | included in Supabase Pro | — | — |
| **Total per month at 50/day** | | **~$0.0024/mo** | **~$0.0096/mo** |

**Verdict: structurally free.** No site Anthropic budget burn; Voyage cost is below noise floor; UW budget untouched (Tenet D4 — UW is write-path only on ingesters).

Latency: ~400ms p50, ~700ms p95 estimated based on per-organ latencies in `ct_brain_telemetry` over the last 24h. Well within the brief's 2s p95 acceptance criterion.

---

## 9. Surfaced conflicts requiring James's call

### Conflict #1 — `audience: 'analyst'` mode silently drops `specialist_recall`

**Finding:** The `specialist_recall` organ is gated to `audienceFilter: ['cotrader']` (`specialistRecallContext.ts:48`). If MCP uses `audience: 'analyst'`, the organ is skipped → analyst response loses "last 5 specialist reads on ticker" which the brief explicitly lists as required output.

**Brief constraint that blocks the obvious fix:** "Don't modify `_shared/specialistRecallContext.ts` or `_shared/specialistRunner.ts`. ... existing clients should be byte-identical to current main."

**Three options:**

| Option | Pros | Cons |
|---|---|---|
| (a) Use `audience: 'cotrader'` in MCP, distinguish via `consumerName: 'cotrader-mcp'` | All 11 organs run; specialist_recall intact; zero modification to brain organs; consistent with framing that terminal-Claude IS part of James's operational decision loop (Tenet 1, intelligence amplifier) | Telemetry's `audience` field reads `cotrader` even though invocation is from terminal — slightly muddies the audience-mode taxonomy; downstream warden invariants that bucket by audience won't separate MCP from operational James |
| (b) Use `audience: 'analyst'`, accept missing `specialist_recall` for v1 | Clean audience semantics; MCP traffic isolated in telemetry | Loses the highest-leverage organ for ticker-specific decision support; brief's required output spec not fully met |
| (c) Extend `specialistRecallContext.ts` audienceFilter from `['cotrader']` to `['cotrader','analyst']` | One-line config change, restores the organ to analyst use without changing what it returns | **Forbidden by brief.** Would require James to override the constraint. |

**Recommendation: (a) — `audience: 'cotrader'`, `consumerName: 'cotrader-mcp'`.**

Rationale: when James opens terminal-Claude at 09:35 ET on a Tuesday and asks "what's the setup on NVDA," that IS cotrader use — the system surfacing intelligence to the operational James, just through a chat surface instead of a UI page. The `analyst` audience was originally framed for human-analyst-grading-the-system sessions (a different context; not what this MCP serves). Telemetry separation is fully achievable via `consumerName` without touching the audience taxonomy.

### Conflict #2 — `regime` organ is `isExpensive: true` and embeds via Voyage on every call

**Finding:** `regime` calls `voyageEmbed(text, 'query')` on every fetch (60s in-isolate cache). Per brief: "If `buildClaudeContext` invokes Claude internally for any organ ... that organ should be flagged and either disabled in MCP context or accepted as a known cost."

**Voyage is not Claude, but the principle (any inference/embedding cost) applies.**

**Cost reality:** ~$0.0000016 per call → 50 calls/day = $0.00008/day = effectively free. See §8.

**Recommendation:** Accept as a known cost. Default behavior keeps `regime` enabled (it's the highest-signal organ for current-state classification — disabling it would gut the MCP's value). Document in README that the MCP makes ~1 Voyage embed per tool call.

If James wants a paranoia switch: add an `include_regime?: boolean` arg defaulting to `true`. Caller can set `false` to skip the Voyage hit.

### Decision needed before Phase B starts:
1. Approve recommendation on Conflict #1 (audience: 'cotrader' + consumerName: 'cotrader-mcp')?
2. Approve recommendation on Conflict #2 (keep regime on by default, optional opt-out flag)?

---

## 10. Phase B execution plan (preview, contingent on §9 approvals)

1. Create `mcp/cotrader/` directory.
2. `server.ts` — Deno entrypoint, stdio transport, `npm:@modelcontextprotocol/sdk@1.29.0`, registers one tool.
3. `tools/get_co_trader_context.ts` — validates ticker against universe (`lib/universe.ts`), instantiates SupabaseClient with service-role from env (or npx fallback via `lib/auth.ts`), calls `buildClaudeContext({audience: 'cotrader', consumerName: 'cotrader-mcp', tickerFocus: ticker, organs: 'all'})`, returns the typed `ClaudeContext` JSON.
4. Logging: stderr only, every call → `{ts, ticker, audience, consumerName, durationMs, organsInvoked, organsSkipped}`.
5. `README.md` — boot command, `claude mcp add ...` snippet, example terminal-Claude usage, cost model, read-only firewall reminder.
6. `smoke-test.ts` — boots server in subprocess, invokes tool with `ticker='NVDA'`, asserts: response has `meta`, `organs`, `preamble`; expected helper names in `helpersInvoked`; total response token count ≤8k.
7. Commit. Run smoke test. Report green.

**No** new edge function. **No** schema change. **No** migration. **No** new cron. **No** modification to `_shared/*` or any existing CT operational code path.

---

## Approval

- [ ] §9 conflict #1 — `audience: 'cotrader'` + `consumerName: 'cotrader-mcp'` ✓ / propose alternative
- [ ] §9 conflict #2 — `regime` on by default with optional opt-out flag ✓ / propose alternative
- [ ] Repo placement `mcp/cotrader/` ✓ / propose alternative
- [ ] Deno runtime + `npm:@modelcontextprotocol/sdk@1.29.0` ✓ / propose alternative
- [ ] Phase B greenlight to proceed
