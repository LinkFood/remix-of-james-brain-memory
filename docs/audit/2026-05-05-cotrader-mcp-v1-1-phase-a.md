# Co-Trader MCP v1.1 — Phase A Audit (READ-ONLY)

**Date:** 2026-05-05  
**Scope:** Diagnose v1's ~13s warm latency, recommend a v1.1 patch (speedup + organ-subset selection).  
**Author:** Claude Opus 4.7 (1M ctx) under James direction.  
**Constraint:** Zero code changes. Investigation only.

---

## TL;DR

The 13s isn't ~50 PostgREST queries fanning out from the brain organs. It's
**~50 sequential queries in the LEGACY flat-fields path** (`claudeReadSurface.ts`
lines ~835–1907) that runs **unconditionally** before the parallel organ work,
regardless of `audience`, `tickerFocus`, or the `organs` whitelist. The
organs Promise.all is already cheap (~500ms aggregate inner work; the
slowest single organ in isolation is `regime` at ~550ms inner).

**Empirically (per /tmp/organ_timing.ts harness, 3 runs each):** every
single-organ call takes **11.5–14s wall-clock**, only ~100–550ms of that is
the helper itself. The full all-11-organs call is also **11.8–12.6s**. The
delta between "one organ" and "all eleven" is ~zero. That's the
fingerprint of a fixed-cost prefix swamping the variable-cost suffix.

**v1.1 lever:** gate the legacy block on a flag (or move it inside an opt-in
helper) so MCP callers can skip it. Once the legacy block is bypassed, the
organs-only ceiling for an `'all'` call is roughly the slowest single organ
plus orchestration overhead — empirically `regime` at ~550ms inner +
~1500ms public-internet PostgREST handshake/connection cost. **v1.1 latency
target: ~3000ms p95** (regime inner med 546ms + RTT × 3 derived below).

**Cache lever:** stdio MCP servers persist for the entire Claude Code
session ("automatic lifecycle… connect at session startup"). In-process
cache is viable. Recommended for the 4 stable organs.

---

## Q1 — Current call pattern: parallel or serial?

**Answer: BOTH, and the serial half is the bottleneck.**

`buildClaudeContext` (`supabase/functions/_shared/claudeReadSurface.ts`):

- **Lines 835–1907 — LEGACY FLAT-FIELDS PATH (sequential).** ~50 individual
  `await supabase.from(...).select(...)` and `.rpc(...)` calls, each waiting
  for the previous to resolve. Tables hit include `ct_heartbeats`,
  `ct_hypotheses`, `ct_hypothesis_events`, `ct_trades` (×2), `ct_trade_ideas`,
  `ct_grades`, `ct_book`, `ct_flow_alerts`, `ct_nope_minute`,
  `ct_net_premium_ticks`, `ct_greek_flow_minute`, `ct_top_movers` (×2),
  `ct_iv_rank_daily`, `ct_max_pain_daily` (×2), `ct_vix_history`,
  `ct_news_analyses`, `ct_breaking_news`, `ct_events`, `ct_earnings_moves`,
  `ct_fundamentals_cache`, `ct_principles`, `ct_biases`, `ct_playbooks`,
  `ct_daily_briefs`, `ct_weekly_reviews`, `ct_insider_trades`,
  `ct_political_trades`, `ct_analyst_actions`, `ct_short_interest`,
  `ct_sector_tide`, `ct_risk_reversal_skew`, `ct_technical_indicators`,
  `current_claude_generation()`, `ct_claude_generations`,
  `ct_prediction_markets`, `ct_yield_curve`, `ct_correlations`,
  `ct_seasonality`, `ct_institutional_holdings`, `ct_central_bank_rates`,
  `ct_indicator_events`, `ct_flow_heatmap_live` RPC.
  This path **does NOT inspect `opts.organs`** — runs in full no matter what.
  A few queries are audience-gated (the `paper_claude` hard-block list), but
  none are short-circuited by an empty/narrow organs list.

- **Lines 1959–1984 — ORGAN PROMISE.ALL (parallel).** All 11 brain organs
  fire concurrently via `Promise.all(helpers.map(async (h) => …))` with the
  organ-whitelist gate at line 1963 and audience gate at 1967. This is the
  only path that respects `opts.organs`.

So `organs: ['flow_heatmap']` saves you ~10 organ helpers (~ 200–500ms of
parallel work) but does **not** save the ~12s of serial legacy queries.

The MCP's `organs` selection at the orchestrator level is currently
**non-load-bearing for latency** — the legacy block dominates.

---

## Q2 — Per-organ latency breakdown (production data, NVDA)

Harness: `/tmp/organ_timing.ts` (not committed). Three runs per organ in
isolation (`organs: [organ]`), warmup all-organs run first to amortize
cold-start, then two reference all-organs runs after.

Wall-clock = end-to-end `buildClaudeContext()`. Inner = the helper's own
`meta.latencyMs`.

| Organ | Run1 ms | Run2 ms | Run3 ms | **Wall median** | Inner median | Bytes | Warning |
|---|---:|---:|---:|---:|---:|---:|---|
| flow_heatmap      | 12794 | 12659 | 12554 | **12659** | 138 | 413   | – |
| pulse             | 12166 | 12395 | 11504 | **12166** | 120 | 172   | – |
| specialist        | 11495 | 12469 | 12415 | **12415** | 113 | 1040  | – |
| detector          | 15726 | 13980 | 12241 | **13980** | 153 | 21308 | – |
| tape              | 13442 | 12872 | 13960 | **13442** | 122 | 9439  | – |
| james_flags       | 11870 | 11760 | 11527 | **11760** | 103 | 79    | no_rows |
| news_causality    | 12216 | 12663 | 11586 | **12216** | 206 | 17679 | – |
| event_recency     | 12406 | 12580 | 13961 | **12580** | 200 | 17728 | – |
| analogs           | 12627 | 12554 | 11664 | **12554** | 152 | 103   | no_current_embedding |
| specialist_recall | 12325 | 11863 | 12161 | **12161** | 246 | 2201  | – |
| regime            | 11816 | 11462 | 11813 | **11813** | **546** | 2143  | – |

**Full all-organs runs (post-warmup): 12622 ms, 11813 ms.**

Two facts pop:

1. **Inner helper time is irrelevant at the wall scale.** Sum of all 11
   inner medians = ~2099 ms; if perfectly serialized that's still under 3s.
   Parallelized via Promise.all the floor is ~550ms (the regime helper).
2. **Wall-clock is fixed at ~12s regardless of how many organs you ask for.**
   This is the legacy-prefix cost. One organ = 12.4s; eleven organs = 12.6s.

**Slowest organ (inner): `regime` at 546 ms.** That's the helper-level
floor for v1.1 once the legacy prefix is gated off. Voyage embed + HNSW
analog lookup dominates inside `regimeContext.ts`.

**Slowest organ (wall, in isolation): `detector` at 13980 ms.** Wall-clock
is dominated by the legacy prefix; this number is not actionable.

---

## Q3 — Stable vs volatile classification

Decision rule: **stable** = changes ≤ once per 5 min in RTH, cache TTL of
60–300s won't deceive a consumer; **volatile** = can change at any moment,
cache would emit stale signal.

Cross-checked against `ct_brain_telemetry` 24h activity (via
`get_brain_health(24)`: pulse helper alone has 322 invocations across 33
distinct consumers — high re-read rate suggests upstream cron cadence,
not push freshness, drives reads).

| Organ | Class | Why |
|---|---|---|
| `flow_heatmap`     | **volatile** | Sources `ct_flow_heatmap_live` RPC over `ct_flow_alerts`; live UW prints land continuously during RTH. |
| `pulse`            | **volatile** | Pulse v2 capture cron fires at :30 of every hour but `pulseContext.ts` reads the live tape feed; per Co-Trader memory the "captured" snapshot vs. live read distinction matters here. Treat as volatile. |
| `specialist`       | semi-stable | Per-ticker specialists fire on RTH cadence (4–10/day per ticker per `feedback_warden_threshold_calibration.md`). Cache 60s would be safe; stays consistent within a chat turn. Marking **stable** with caveat. |
| `detector`         | **volatile** | `ct_observed_patterns` + per-detector tables refresh per scoreboard cron; new flag rows can land at any RTH moment. |
| `tape`             | **volatile** | Tape-reader narrative continuously updated; the whole point is "what's happening NOW." |
| `james_flags`      | **stable** | Human curation cadence — James stars a flag occasionally, then doesn't touch it for hours/days. |
| `news_causality`   | **volatile** | Driven by `ct_news_analyses` + breaking-news watcher; new analyses land mid-RTH. |
| `event_recency`    | **stable** | "What just happened" 72h window — earnings/FOMC/macro events don't shift sub-minute. James's initial classification confirmed. |
| `analogs`          | **stable** | HNSW lookup over `ct_session_embeddings` keyed off the current session embedding; new session embedding lands once per `ct-session-analog` cron firing (21:30 UTC daily). Doesn't change intra-session. |
| `specialist_recall`| **stable** | Last 5 flagged + 5 unflagged-conv-≥50 specialist reads per ticker. Specialists fire 4–10/day, recall set rotates slowly. |
| `regime`           | **stable** | Pulse v2 regime classification + analogs. Embed input is the current Pulse window state — captured per :30 cron. James's initial classification confirmed. |

**Stable (4):** james_flags, event_recency, analogs, specialist_recall, regime → 5 organs cache-eligible (James's initial 4 + analogs and specialist_recall).  
**Volatile (5):** flow_heatmap, pulse, detector, tape, news_causality.  
**Edge case (1):** specialist — 60s cache is safe, but consider it volatile if you want defensive purity.

James's initial list of 4 stable was directionally right; this audit
expands it to 5 firmly stable + specialist as a cache-with-short-TTL judgment
call. **Recommendation: cache the 5 firmly stable; pass-through specialist
unless James wants the extra.**

(Note from brief: `observed_patterns` is a TABLE consumed by `detector`; not
itself an organ. Confirmed in `_shared/detectorContext.ts` import surface
during read of `claudeReadSurface.ts` Phase 3 helper list at lines 84–97.)

---

## Q4 — Cache architecture: server lifecycle

**Verified via Claude Code MCP docs (`https://code.claude.com/docs/en/mcp`).**

Quoted, verbatim:

> "**Automatic lifecycle**: At session startup, servers for enabled plugins
> connect automatically."

> "Stdio servers are local processes and are not reconnected automatically."

> "The helper runs fresh on each connection (at session start and on
> reconnect). There is no caching, so your script is responsible for any
> token reuse."

**Conclusion: stdio MCP servers persist for the entire Claude Code session.**
The `deno run --allow-all server.ts` process is spawned once at session
start, holds stdio open across N tool calls in that session, and is killed
when the session ends. **In-process module-level cache (e.g., a `Map<string,
{value, expiresAt}>` in `tools/get_co_trader_context.ts` or in a new
`lib/organCache.ts`) is viable for v1.1.**

Caveat: cache lives in-process per laptop session. James opens a new
terminal-Claude session, the cache is empty until the first call warms it.
That's fine for the use pattern (conversational, ~1 call/min, sessions
last hours).

---

## Q5 — Telemetry impact of caching

Today: `claudeReadSurface.ts:1998–2043` writes one `ct_brain_telemetry` row
per organ outcome (resolved or skipped) per `buildClaudeContext` invocation.
The insert is fire-and-forget (not awaited), so it doesn't add latency, but
it is the system's only durable record of what the brain served.

**With in-process MCP-layer cache:** a cache hit means we never call
`buildClaudeContext` for that organ → no telemetry row → the warden's
cadence-style invariants (`brain_telemetry_insert_rate_24h` is one of the
existing 27) lose visibility into organ usage from the MCP.

**Recommendation: emit a telemetry row on cache hits, tagged `cache_hit=true`.**
The schema already supports it — `meta.cacheHit` on `HelperResult` is a
declared field, and the orchestrator's row-builder at line 2017 reads
`!!m.cacheHit`. The MCP-layer cache would never reach that codepath, so
v1.1 needs to either:

- **Option A (preferred):** insert telemetry rows directly from the MCP
  cache layer using the same shape, with `cache_hit=true`,
  `consumer_name='cotrader-mcp'`, `latency_ms = <time spent reading from
  cache>` (<1ms typically), and `helper_version` from the cached entry.
  Preserves warden visibility, lets you measure cache hit rate from the
  same RPC.
- **Option B:** skip telemetry on cache hits. Faster, but you lose the
  ability to answer "how often is the MCP serving cached data" from
  `ct_brain_telemetry`. Anti-pattern given Tenet 13 ("Hallucination is
  inevitable; structural prevention is the answer") + the existing warden
  cadence invariant.

**Decision needed from James:** A or B. Lean A.

If A, the row should include a new column or a tag in an existing column.
Cheapest path: tag in `error` column as the existing skip-reason pattern
does (`skipped:audience_filter`, etc.) — write `cache_hit:fresh_60s` or
similar so warden queries can filter on `error LIKE 'cache_hit:%'`. No
schema change needed.

---

## Q6 — `organs` parameter validation

When the caller passes `organs: ['regimee', 'flow']`:

**Recommendation: warn-and-fetch-recognized-subset.**

Reasoning:

1. **Terminal-Claude is the caller, not a deterministic client.** Claude
   Opus 4.7 typing `regimee` is a latent risk — happens occasionally with
   any LLM, especially on long names like `specialist_recall` and
   `news_causality`. Failing the entire call forces James to retype the
   ask; warning + serving recognized organs gives him 90% of the value
   immediately and a visible note on what was wrong.
2. **Tenet 1 framing.** The MCP exists to amplify James's decision loop.
   Failing closed on a typo in a single organ name shipped from the LLM
   is friction; serving a partial answer with a clear `meta.warnings:
   ['unknown_organ:regimee', 'unknown_organ:flow']` lets James course-correct
   in conversation rather than re-issue the tool call.
3. **Existing telemetry surface.** The slim payload already has a
   `meta.organsSkipped` array with `{name, reason}` shape. Extend reasons
   to include `'unknown_organ'` — natural fit, no shape change.
4. **Empty result if EVERY organ name is invalid.** If `organs` resolves
   to zero recognized names after filtering, fail the call hard with a
   clear `Error: no recognized organs in request; valid: [11-name list]`.
   This is the "user typed ['xxx', 'yyy', 'zzz']" case where partial
   recovery makes no sense.

Implementation hint for v1.1 (no code change here per constraint, just
naming what to do): validate the list against `HelperName` union before
passing to `buildClaudeContext`, partition into `recognized` and `unknown`,
log unknowns to stderr, push `{name, reason: 'unknown_organ'}` entries
into `organsSkipped` in the slimmed return shape.

**Decision needed from James:** Confirm warn-and-serve vs hard-fail. Lean
warn-and-serve.

---

## Q7 — Existing tests + new tests v1.1 needs

`mcp/cotrader/smoke-test.ts` ships 11 checks today:

| Check | Description |
|---|---|
| warmup_call (warmup) | Cold-start succeeds (latency not asserted) |
| warm_latency_under_p95 | Warm wall ≤ 20000ms (current generous cap) |
| has_organs_map | `ctx.organs` is an object |
| organs_invoked_count | ≥5 organs ran |
| organ_present:specialist | specialist key in organs |
| organ_present:flow_heatmap | flow_heatmap key in organs |
| organ_present:specialist_recall | specialist_recall key in organs |
| token_budget | Estimated tokens ≤ 50000 |
| audience_is_cotrader | `audience === 'cotrader'` |
| preamble_present | `preamble` is an object |
| ticker_focus_set | `tickerFocus === 'NVDA'` |
| consumer_name_tagged | `meta.consumerName === 'cotrader-mcp'` |

**Which of these v1.1 might break:**

- `warm_latency_under_p95` (cap 20s): SAFE. v1.1 should improve, not
  regress. Update cap downward post-fix to lock the win.
- `organs_invoked_count` (≥5): SAFE. Default call still passes all 11;
  the organs-subset path is a NEW input shape only exercised when caller
  passes `organs: [...]`.
- `organ_present:*` (3 checks): SAFE for default call. Will FAIL if a
  v1.1 test passes `organs: ['regime']` and asserts presence of others.
  Tests need to be additive, not replace existing.
- `token_budget` / `preamble_present` / `ticker_focus_set` /
  `consumer_name_tagged`: SAFE. None depend on organ count or order.
- `has_organs_map`: SAFE.

**Risks v1.1 introduces that current tests don't cover:**

1. **Parallelization correctness — but parallelization already exists**
   (Q1). The opportunity is bypassing the legacy block, not parallelizing
   what's already parallel. Test for: `legacy_fields_skipped_when_flag_set`
   — call with `BrainOpts.skipLegacyFlatFields: true` (proposed v1.1 opt)
   and assert wall-clock < 3000ms.
2. **Cache hit/miss correctness.** New tests:
   - `cache_miss_first_call` — clear cache, call, assert
     `meta.organCacheHits` is empty (or 0).
   - `cache_hit_second_call` — call twice in succession with same args,
     assert second call's stable-organ payload is identical AND
     `meta.organCacheHits` includes the 5 stable organs.
   - `cache_skip_on_volatile` — assert volatile organs are never reported
     as cache hits even on rapid-fire calls.
   - `cache_ttl_expiry` — sleep cache_ttl + 1s, call again, assert no
     cache hit on previously-cached organ.
3. **Organs param validation.** New tests:
   - `organs_subset_returns_only_requested` — `organs: ['regime']` returns
     `{ regime: ... }` only, with `organsSkipped` listing the 10 others
     reasoned `organ_filter` (matching existing skip reason).
   - `organs_unknown_warned_not_failed` — `organs: ['regime', 'badname']`
     succeeds, returns `regime`, lists `{name: 'badname', reason: 'unknown_organ'}`
     in `organsSkipped`.
   - `organs_all_unknown_fails` — `organs: ['xxx', 'yyy']` rejects with
     a clear error message.
4. **Telemetry on cache hits** (if Option A from Q5 chosen):
   - `telemetry_row_emitted_on_cache_hit` — call twice, query
     `ct_brain_telemetry` for the consumer + ticker, assert two rows per
     stable organ with the second tagged `cache_hit:fresh_*`.

---

## v1.1 latency target (locked)

**Target: 3000 ms p95.**

Derivation:

- Floor: slowest stable organ inner median is `regime` at 546ms.
- Add public-internet PostgREST RTT cost. The legacy-block timing tells
  us each round-trip from a Bay Area laptop to a Supabase instance in
  whatever region rvhyotvklfowklzjahdd lives is ~150-250ms (50 queries ×
  this RTT = 12s). Conservatively: 200ms × 3 = 600ms for createClient
  setup + first organ-call handshake + telemetry insert.
- Voyage embed call inside `regime` organ: ~300-400ms (the helper internal
  measure includes it; 546ms internal already accounts for it).
- Buffer for slow days, retries, GC: ~1.5×.

**`546 ms × 1.5 + Voyage/RTT padding ≈ 1500 ms p50, 3000 ms p95.**

This is **4–5× faster than v1's 13s** and ~1.5× looser than the brief's
original "~2s" estimate. The 2s was based on regime not running; with regime
on by default, 3s is the honest p95 ceiling.

If James wants <2s, the lever is `include_regime: false` by default. Without
regime, the slowest stable organ becomes `specialist_recall` at 246ms, target
drops to ~1500ms p95.

---

## Trade-offs needing James's call

1. **Q5 — Telemetry on cache hits: A or B?**
   - **A** (preferred): emit cache-hit rows tagged `cache_hit:fresh_<ttl>s`
     in the existing `error` column. Preserves warden visibility, lets you
     measure hit rate from `get_brain_health()`. ~1 extra `INSERT` per
     stable-organ cache hit, fire-and-forget so latency-neutral.
   - **B**: skip telemetry on hits. Marginally faster, marginally simpler,
     but blinds the warden to MCP cache behavior.

2. **Q6 — Unknown organ name handling: warn-and-serve, or hard-fail?**
   - **Warn-and-serve** (preferred): partial recovery on LLM typos, pushes
     unknowns to `organsSkipped` with reason `unknown_organ`. Hard-fail
     only if EVERY name is unknown.
   - **Hard-fail**: stricter contract, easier to debug in tests, but
     friction for the conversational use case.

3. **Cache invalidation strategy.** Three options for the 5 stable organs:
   - **TTL only** (simplest): each cached entry has `expiresAt = now + ttl`.
     `event_recency` 300s, `regime` 300s (Pulse capture is :30/hr), `analogs`
     900s (session embedding writes daily), `specialist_recall` 120s,
     `james_flags` 600s.
   - **TTL + manual bust**: extra `clear_cache` MCP tool. Probably overkill
     v1.1; can ship later if needed.
   - **TTL + cron-aware**: cache entries pinned to producer cron next-fire-at
     time. Most accurate, most complex. Not v1.1.

   **Recommend TTL only.**

4. **Should we gate the legacy flat-fields block, or move it inside an opt-in
   helper?**
   - **Gate (`opts.skipLegacyFlatFields: boolean`, default false)**: minimal
     code change, backward-compatible with the 17 existing brain consumers
     that read flat fields. The MCP passes `true`; everyone else stays at
     `false`. **Preferred for v1.1 — surgical, reversible, testable.**
   - **Move into a new `legacyFlatFields` helper**: cleaner long-term, but
     touches every existing consumer. Phase B / v2 work.

5. **Should `audience: 'cotrader'` skip the `paper_claude`-only legacy work
   in v1.1, even without the new flag?** Many of those queries are pure
   waste for cotrader audience (e.g., `ct_book where trader='james'` is
   already audience-gated, but `ct_trades`, `ct_grades`, `ct_hypotheses`
   feeds aren't). **Decision needed:** is fixing audience-gating in the
   legacy block in scope for v1.1, or strictly the skip-flag? Lean
   skip-flag-only for surgical scope.

---

## Recommended Phase B work plan

Tied back to Q1–Q7. All tasks read-only-on-disk first, then a single
small-scope PR.

### Phase B.1 — Latency win (Q1, Q2, target)

1. Add `BuildClaudeContextOpts.skipLegacyFlatFields?: boolean` (default
   false). When true, skip lines ~836–1907; jump directly into the helper
   `Promise.all`.
2. Make MCP `getCoTraderContext()` pass `skipLegacyFlatFields: true`.
3. Verify wall-clock drops to ~2–3s on James's laptop.
4. Lower the smoke test cap from 20000ms to 4000ms once verified.

### Phase B.2 — Organ subset (Q6)

1. Extend MCP tool input schema with `organs?: string[]` (zod array).
2. Validate against `HelperName` union; partition recognized vs unknown.
3. Pass recognized list to `buildClaudeContext.organs`. Push unknowns to
   the slimmed return's `organsSkipped` array as `{name, reason: 'unknown_organ'}`.
4. Hard-fail if recognized list is empty.

### Phase B.3 — Cache layer (Q3, Q4, Q5)

1. New `mcp/cotrader/lib/organCache.ts` — module-scoped `Map<cacheKey,
   {value, expiresAt}>`. Key = `${ticker}:${organ}`.
2. Whitelist: `regime`, `event_recency`, `analogs`, `specialist_recall`,
   `james_flags`. (NOT `specialist` — too many edge cases mid-RTH.)
3. TTLs: see "TTL only" trade-off above.
4. In `tools/get_co_trader_context.ts`: before calling `buildClaudeContext`,
   look up each whitelisted organ in cache. If hit and fresh, exclude from
   the `organs` list passed to the brain; merge cached results into the
   final response.
5. After brain returns, write the freshly-fetched stable organs into the
   cache.
6. **Telemetry on cache hits (Option A):** for each cache-hit organ, fire
   an async `supabase.from('ct_brain_telemetry').insert([...])` with
   `cache_hit=true`, `consumer_name='cotrader-mcp'`, `latency_ms=0`,
   `error='cache_hit:fresh_' + ttl + 's'`. Same shape as the existing
   orchestrator-side row builder (`claudeReadSurface.ts:2002–2036`) so
   `get_brain_health` aggregates correctly.

### Phase B.4 — Tests (Q7)

1. Update `smoke-test.ts` with new latency cap.
2. Add `parallel-fetch-correctness` (sanity: 11-organ result is a superset
   of any single-organ result).
3. Add `cache_*` tests (4 cases above).
4. Add `organs_*` validation tests (3 cases above).
5. Add `telemetry_row_emitted_on_cache_hit` if Option A chosen.

### Phase B.5 — Wins to lock in (warden + docs)

1. New warden invariant: `cotrader_mcp_p95_latency_24h` — query
   `ct_brain_telemetry WHERE consumer_name='cotrader-mcp' AND created_at >
   now() - interval '24h'` for p95(latency_ms). Threshold: ≤4000ms (3000
   target × 1.33 buffer). Severity: warn.
2. Update `mcp/cotrader/README.md` cost-and-latency model to reflect new
   ~3s target; remove the "13s ~50 queries × 200ms RTT" rationale paragraph
   since the new arch makes that backstory false.

### Phase B.6 — Out of scope for v1.1 (note for future)

- Audience-gating cleanup in the legacy block (Q5 trade-off #5). Larger
  refactor; defer to a separate scope.
- Moving the legacy block into a `legacyFlatFields` helper. Phase 4 of
  the synthesis layer migration; not v1.1.
- Cron-aware cache invalidation (TTL+next-fire-at). Premature; ship TTL
  first, measure hit-rate, decide if we need precision.
- A `bust_cache` MCP tool. YAGNI until James asks.

---

## Appendix: harness raw output

Source: `/tmp/organ_timing.ts` (not committed; ephemeral). Run command:

```
SUPABASE_URL=https://rvhyotvklfowklzjahdd.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=$(npx supabase projects api-keys --project-ref rvhyotvklfowklzjahdd | grep service_role | awk '{print $NF}') \
VOYAGE_API_KEY=$VOYAGE_API_KEY \
deno run --allow-all --no-check /tmp/organ_timing.ts
```

Single recurring stderr noise observed across every call, unrelated to
this audit's scope but worth noting:

```
[claudeReadSurface] armed ideas query failed: column ct_trade_ideas.side does not exist
```

This is a one-line bug in the legacy block (`ct_trade_ideas` schema drift)
— harmless because the surrounding try/catch swallows it, but it's the
kind of stale legacy-block code that further argues for the
`skipLegacyFlatFields` flag.

Telemetry context (via `get_brain_health(24)`, 2026-05-05):
- 3246 invocations, 33 distinct consumers, 11 distinct helpers
- Production p95 (helper inner): 252ms (specialist_recall) → 2345ms
  (flow_heatmap; outlier, see below)
- `flow_heatmap` p95 of 2345ms is anomalous vs its inner median of 138ms in
  this audit's harness — could be production-time peak load on the RPC
  during sector-tide cron windows. Out of scope for this audit but worth a
  follow-up sniff.
- `regime` only ran 97 times in 24h (vs 322 for most others) because
  audienceFilter or budget mode is gating it from many consumers. Not a
  v1.1 issue.
