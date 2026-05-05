# Co-Trader MCP v2 Tier 1 — Phase A audit

> Pre-build read-only audit of six new MCP tools. **Phase B is gated on James's approval of this doc + resolution of the surfaced decisions in §9.**

Date: 2026-05-05.
Auditor: terminal-Claude (Opus 4.7, 1M context).
Scope: schema verification + telemetry + token budget + descriptions for `get_brain_principles`, `get_observed_patterns`, `get_morning_brief`, `get_eod_summary`, `get_warden_state`, `get_recent_james_flags`. Companion to `2026-05-02-cotrader-mcp-phase-a.md` (v1, `get_co_trader_context`).

---

## 0. TL;DR — three load-bearing findings

1. **`brain_principles` does not exist.** PostgREST `PGRST205` ("Perhaps you meant the table 'public.jac_principles'"). The `distill-principles` cron has been silently no-op'ing every Sunday — it writes to `.from('brain_principles')` (lines 100, 188, 239, 252 of `supabase/functions/distill-principles/index.ts`) against a table that was never created. **`jac_principles` exists but is empty (0 rows).** Two real principle tables DO exist: `ct_principles` (0 rows) and `ct_specialist_principles` (0 rows). Tool #1 must either (a) be re-pointed at one of the existing tables and accept it returns empty, (b) be DROPPED from Tier 1, or (c) Phase B sequences a class-fix migration before the tool ships. Recommendation: (b) — drop from Tier 1 and surface as a separate punch-list silent-failure-class kill.
2. **`ct_observed_patterns` has 11 rows total (1 validated, 4 observed, 6 deprecated).** `pattern_signature` is JSONB — ticker filter requires JSON containment (`pattern_signature->>'instrument' = 'NVDA'`), not a flat column. Status enum present in production: `validated | observed | deprecated`. The brief's hint to "not assume 'validated'" is correct — the dominant value in production is `deprecated`, and any default `status` filter that excludes deprecated will drop 6/11 rows.
3. **`ct_eod_summaries` and `ct_eod_reports` are BOTH live and DIFFERENT shapes.** Summaries (n=12, latest 2026-05-04) carry the long-form `summary_text` (~28KB per row) plus structured stats. Reports (n=4, latest 2026-05-04) carry per-ticker close JSON, regime shift, scorecards, recap blocks, and join keys (`eod_summary_id`, `morning_brief_id`). Tool #4 must decide composition strategy (see §1.4 + §9.1).

---

## 1. Per-tool schema verification

All probes hit `https://rvhyotvklfowklzjahdd.supabase.co/rest/v1/` with service-role key. OpenAPI definitions inspected via root GET. No writes, no migrations.

### 1.1 `get_brain_principles(min_confidence?, limit?, ticker?)`

| Aspect | Reality |
|---|---|
| Brief-named table | `brain_principles` |
| **Exists in production?** | **NO** (`PGRST205`) |
| Hint from PostgREST | `jac_principles` |
| Closest existing tables | `jac_principles` (n=0), `ct_principles` (n=0), `ct_specialist_principles` (n=0) |
| Cron writing to brief-named table | `distill-principles` (weekly Sunday 3 AM UTC) — currently silent-failing |

**`jac_principles` schema** (per OpenAPI):
- `id: uuid`, `user_id: uuid`, `principle: text`, `source_reflection_ids: uuid[]`
- `confidence: double precision`, `times_applied: integer`, `embedding: vector(512)`
- `category: text`, `severity: integer`, `acknowledged: bool`, `retired_at: timestamptz`
- `created_at`, `last_validated`

**`ct_principles` schema** (per `20260422000006_ct_phase1_foundation.sql`):
- `id: uuid`, `trader: text NOT NULL CHECK (trader IN ('claude','james')) DEFAULT 'claude'`
- `principle: text`, `derivation: text`, `strength: numeric [0..1] DEFAULT 0.5`
- `status: text CHECK (status IN ('active','deprecated','under_review')) DEFAULT 'active'`
- `domain: text` (free text — examples in migration comment: `execution | psychology | vol | flow | macro | ...`)
- `support_count: int`, `refute_count: int`, `last_tested_at`, `created_at`, `updated_at`
- Index: `idx_ct_principles_active ON (trader, status, strength DESC) WHERE status='active'`

**`ct_specialist_principles` schema** (per OpenAPI):
- `id: uuid`, `specialist_ticker: text` (the structured ticker column!)
- `principle: text`, `evidence_flags: uuid[]`, `confidence: numeric`
- `created_at`, `updated_at`

**Critical asymmetry:** Of the three existing tables, only `ct_specialist_principles` has a structured `specialist_ticker` column. `jac_principles` and `ct_principles` would require freeform-text matching against `principle` — see §5.

**Verdict for Tier 1:** the brief's premise ("brain_principles" + "JAC's distilled wisdom from weekly distill-principles cron") describes a writer that fires but writes nowhere. **Decision needed in §9.1 — drop the tool, point at `ct_principles` (always-empty until cron is re-pointed), or block Tier 1 on a class-fix migration first.**

### 1.2 `get_observed_patterns(ticker?, status?, min_n?, limit?)`

| Aspect | Reality |
|---|---|
| Table | `ct_observed_patterns` |
| Exists | YES (`20260502060200_ct_observed_patterns.sql`) |
| Total rows | 11 |
| Last write | 2026-05-02 23:50 UTC (single `validated` row, NVDA 3d-axis) |
| Indexes | `idx_observed_patterns_status` on `(status)`; `idx_observed_patterns_signature_gin` GIN on `pattern_signature` |

**Schema (OpenAPI + sample-row confirmed):**
- `id: bigint`, `pattern_signature: jsonb`, `description: text`
- `n_observed: int`, `hit_rate_blended: numeric`, `hit_rate_per_axis: jsonb`, `baseline_delta: numeric`
- `regime_conditional: bool`, `recommended_action: text`
- `status: text` — production values: **`validated` (1), `observed` (4), `deprecated` (6)**
- `captured_at`, `last_validated_at`, `captured_by: text`, `notes: text`

**`pattern_signature` shapes seen in production:**
- `{"axis":"underlying_3d","instrument":"NVDA"}` — ticker-keyed
- `{"axis":"underlying_3d","day_of_week":"fri"}` — calendar-keyed
- `{"time_of_day_bucket":"midday_1230_1400"}` — time-keyed
- `{"axis":"unified","side":"put"}` — option-side-keyed
- `{"axis":"unified","detector_id":"smart_money_repeat_v1"}` — detector-keyed

**Filter shape recommendation:** ticker filter must use JSONB containment, e.g.
`pattern_signature->>'instrument' = 'NVDA'` (PostgREST: `pattern_signature->>instrument=eq.NVDA`).
GIN index supports `pattern_signature @> '{"instrument":"NVDA"}'` (PostgREST: `pattern_signature=cs.{"instrument":"NVDA"}`) — prefer this for index hit.

**Status default:** brief implied `validated` is the default; production has 1 validated row. Recommend default `status IN ('validated','observed')` (excludes `deprecated`), settable via param.

### 1.3 `get_morning_brief(date?)`

| Aspect | Reality |
|---|---|
| Table | `brain_reports` filtered to `report_type='morning_brief'` |
| Exists | YES |
| Total morning_brief rows | 55 (out of 333 sampled) |
| Last write | 2026-05-05 10:00 UTC (~6 AM ET, daily) |
| `report_type` distribution | `research: 235, morning_brief: 55, market_snapshot: 42, daily: 1` |
| Cadence | Daily 8 AM ET cron (`jac-morning-brief`), confirmed by 5 consecutive daily rows May 1-5 |
| Indexes | `idx_brain_reports_user_date (user_id, created_at DESC)`, `idx_brain_reports_type (user_id, report_type, created_at DESC)`, `idx_brain_reports_source (user_id, source, created_at DESC)` |

**Schema:** `id, user_id, report_type, start_date, end_date, summary, key_themes (jsonb), decisions (jsonb), insights (jsonb), conversation_stats (jsonb), created_at, title, body_markdown, metadata (jsonb), source, entry_id, task_id`

**`report_type` enum is canonical:** `morning_brief` is correct. The brief's framing matches.

**Filter caveat:** all 333 rows belong to a single `user_id` (James's: `eedd6320-3cd5-423a-b1da-db0c804d79c6`). The MCP runs service-role; unfiltered queries return only James's rows because nothing else exists. Single-user system — no `user_id` predicate needed for v2 Tier 1, but document the assumption.

**Date-arg shape:** `date` likely refers to ET session date. `created_at` is UTC. The 10:00 UTC fire = 6 AM ET = today's brief in ET. **Filter recommendation:** translate `date` → ET-day window `[date 00:00 ET, date 24:00 ET)` then filter `created_at` against the UTC equivalent. The morning brief itself fires at 06:00 ET so `date='2026-05-05'` should resolve to created_at between `2026-05-05T04:00:00Z` and `2026-05-06T04:00:00Z` (ET=UTC-4 in DST). Use `clock.ts:dateInTz` for the conversion (see §6).

**Body size:** `body_markdown` averages ~1.5KB. Default `limit=1` (latest match) keeps payload trivial.

### 1.4 `get_eod_summary(date?)` — combined

| Aspect | `ct_eod_summaries` | `ct_eod_reports` |
|---|---|---|
| Exists | YES | YES |
| Total rows | 12 | 4 |
| Latest `session_date` | 2026-05-04 | 2026-05-04 |
| PK | `id: bigint` | `id: uuid` |
| Join key | `id` ← `ct_eod_reports.eod_summary_id` | `eod_summary_id: bigint` (also `morning_brief_id: uuid`) |
| Relationship | 1:1 by `session_date` (every report has a summary; not every summary has a report yet) | |
| Per-row size | ~28KB (long-form `summary_text` markdown) | ~22KB (per-ticker JSON + recap blocks) |

**`ct_eod_summaries` columns:** `id, session_date, summary_text, specialist_stats (jsonb), ticker_stats (jsonb), market_stats (jsonb), generated_at, model, cost_usd, edge_attribution (jsonb), slow_burn_pays_today (jsonb), top_print_grades (jsonb), top_realized_tracks (jsonb), specialist_scorecard (jsonb), regime_tag, snapshot_hit_rate, tracks_realized_today`

**`ct_eod_reports` columns:** `id, session_date, generated_at, generated_by_model, session_summary, regime_close, regime_shift_today, per_ticker_close (jsonb), morning_brief_scorecard (jsonb), scorecard_summary (jsonb), carryover_themes (jsonb), overnight_catalysts (jsonb), breaking_events_today (jsonb), tomorrow_watchlist (jsonb), skip_tomorrow (jsonb), lessons_today (jsonb), script (text), morning_brief_id, eod_summary_id, cost_usd, tokens_in, tokens_out, triggered_by, ttl_hours, flow_recap (jsonb), stack_recap (jsonb), realized_recap (jsonb)`

**Composition options for the tool:**
- (A) Return both rows verbatim joined by `session_date` → ~50KB / ~12k tokens. Breaches budget.
- (B) Default-slim: `ct_eod_reports.session_summary` + `regime_close` + `regime_shift_today` + `per_ticker_close` + `tomorrow_watchlist` + `lessons_today` + `ct_eod_summaries.snapshot_hit_rate` + `tracks_realized_today` + `regime_tag`. Skip the long `summary_text` and `summary_text` markdown by default. Estimated ~3-4k tokens. Add `verbose: true` flag to opt into full payload.
- (C) Two output modes via separate args (`narrative_only` vs `structured_only`).

**Recommendation:** (B) default-slim with `verbose: true` opt-in. See §9.4.

**Date-arg shape:** `session_date` is `date` (not timestamptz). Defaults per brief: yesterday's session before market open, today's after close, most-recent during RTH. Use `marketClock.ts:isMarketOpen / lastMarketClose` (see §6).

### 1.5 `get_warden_state()`

| Aspect | `ct_warden_alarm_state` | `ct_invariants` |
|---|---|---|
| Exists | YES | YES |
| Total rows | 17 (one per invariant currently with state) | 29 (all enabled) |
| Currently failing (live) | 0 (all `pass`) | 0 (`last_status != 'pass'`: 2 rows have `last_status=null` — never run) |
| Severity field | NO — only `current_status` | YES (`info | warn | critical`) |
| Runbook field | NO | YES (`runbook_path: text`) |
| Last state change | YES (`state_changed_at`) | NO equivalent |
| Last value | NO | YES (`last_value: text`) |
| Last error | NO | YES (`last_error: text`) |

**Verdict: BOTH tables are needed.** Canonical warden output = `ct_invariants` LEFT JOIN `ct_warden_alarm_state ON (name = invariant_name)`. The brief's "or whichever is canonical" — neither alone is canonical; they are intentionally split (manifest + state).

**Joined output shape (recommended):**
```sql
SELECT i.name, i.category, i.severity, i.description, i.runbook_path,
       i.last_status, i.last_value, i.last_error, i.consecutive_fails,
       i.last_run_at, s.current_status, s.state_changed_at,
       s.consecutive_count
FROM ct_invariants i
LEFT JOIN ct_warden_alarm_state s ON s.invariant_name = i.name
WHERE i.enabled = true
ORDER BY (i.last_status != 'pass') DESC,
         CASE i.severity WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END,
         i.consecutive_fails DESC;
```

**Or use the existing RPC:** `SELECT public.get_warden_health(window_hours => 24);` (per CLAUDE.md `## System Warden`) returns `totals + by_category + sorted failures[] each with runbook_path`. **Recommend the tool call this RPC** — single round trip, server-side aggregation, already canonical for the dashboard. Verify the RPC signature in Phase B before finalizing (not exercised in this audit since it's behind `rpc/`, which is read-only and safe to invoke but not required for schema confirmation).

**Indexes:** `idx_ct_invariants_enabled_category`, `idx_ct_invariants_last_status` — both support the filter.

### 1.6 `get_recent_james_flags(hours?, ticker?)`

| Aspect | Reality |
|---|---|
| Table | `ct_flags` |
| James-source filter | `source = 'james_star'` (per `_shared/jamesFlagsContext.ts:174`, post `20260427000010_unify_flags.sql`) |
| Total `source='james_star'` rows | 4 (latest 2026-04-24) |
| Ticker column | `instrument` (NOT `ticker` — confirmed per CLAUDE.md feedback memory + production sample) |
| Indexes | `idx_ct_flags_source ON (source)`, `idx_ct_flags_specialist_ticker (specialist_ticker, created_at DESC)`, `idx_ct_flags_instrument_created`, `idx_ct_flags_created`, `idx_ct_flags_status (status, horizon_ts)` |

**Schema (relevant subset):** `id, instrument, option_symbol, strike, expiry, side, direction, score, score_breakdown (jsonb), tags (text[]), thesis, invalidation, horizon_hours, horizon_ts, entry_price, status, source, detector_id, specialist_ticker, created_at, updated_at, slacked_at, pulse_*_at_fire`

**`source` distribution in last 1000 rows:** `detector_alarm: 976, signature_alarm: 16, specialist: 8`. James-source flags are a tiny minority, all 4 rows from a single afternoon (2026-04-24). Pattern: James starred TSLA + QQQ bearish in a 90-min window, no notes (`thesis = null`), then nothing since. Tool will routinely return zero rows — that's accurate, not a bug.

**Filter shape:** `?source=eq.james_star&instrument=eq.<TICKER>&created_at=gte.<since>&order=created_at.desc&limit=N`. All filtered columns are individually indexed; query is cheap.

---

## 2. RLS / column secrets / PII surface

Service-role bypasses RLS for every table above. Per-table review:

| Table | Risk surfaces | Mitigation |
|---|---|---|
| `brain_principles` | N/A (table doesn't exist) | n/a |
| `jac_principles` | `principle` text — could quote James verbatim from reflections; `embedding` (512-dim float) is bulky and useless to terminal-Claude | **Exclude `embedding` from select**; `principle` content is OK to surface (it's James's own wisdom, the whole point of the tool) |
| `ct_principles` | `principle` + `derivation` text — derivation may reference reflection IDs (UUIDs only, no leak) | OK as-is |
| `ct_observed_patterns` | All structural; no James content | OK as-is |
| `brain_reports` | `body_markdown` may contain Slack channel IDs, calendar-extracted PII (gym appointments, meds, names of family/coworkers) | **PII risk: medium.** Sample brief mentions "BG&E bill", "marketing meeting", "FUBAR dues", "dentist", "buy birthday gifts". This IS James's own content reaching James's terminal — leakage risk only if MCP transcripts get shared externally. Document in README: terminal-Claude transcripts containing brain-brief output should be treated as private journal content. |
| `ct_eod_summaries` | Long-form Claude-written narratives with regime tags + ticker P&L | Low PII — operational/financial content only |
| `ct_eod_reports` | Same as summaries | Low PII |
| `ct_warden_alarm_state` + `ct_invariants` | `query_sql` text contains raw SQL (possibly Vault function names like `vault.decrypted_secrets`) | **Exclude `query_sql` from default tool output** — it's debugging detail, also could leak schema attack surface. Surface only the `name + description + status + value + runbook_path`. |
| `ct_flags` | `thesis` text from James (currently null in all 4 james_star rows). Score breakdowns include detector internals. | OK — same private-journal classification as morning brief |

**Service tokens:** No raw service-role / API keys live in any of these tables. Verified by inspection. The only "secret-like" payload surface is `ct_invariants.query_sql` references to `vault.decrypted_secrets` — defense-in-depth: omit that column from MCP output.

**Recommendation:** Tier 1 tools strip `embedding`, `query_sql`, and any `*_id` UUID arrays from default `select` lists. Add `verbose` flag for tools where that detail is occasionally useful.

---

## 3. Telemetry tagging

`ct_brain_telemetry` schema (verified):
- `id: bigint`, `helper_name: text`, `helper_version: text`, `audience: text`, `ticker_focus: text`, `consumer_name: text`, `latency_ms: int`, `output_size_bytes: int`, `cache_hit: bool`, `error: text`, `created_at: timestamptz`

Verified consumer_name distribution in last 200 rows includes `ct-tape-reader`, `ct-watcher`, `ct-trade-advisories`, `ct-self-grader`, `ct-curiosity`, `ct-alert-post-mortem`, `ct-news-sweep`, plus 11 `ct-specialist-*` rows. The `cotrader-mcp` consumer (v1) hasn't shown up yet in the last 200 — expected since v1 just shipped and the smoke-test mostly emits to a different bucket.

**Key constraint:** `helper_name` is intended for the 11 brain organs (`flow_heatmap, pulse, specialist, detector, tape, james_flags, news_causality, event_recency, analogs, specialist_recall, regime`). v2 Tier 1 tools are NOT brain organs — they hit raw tables. Stuffing `helper_name='get_brain_principles'` into this table would pollute organ-level dashboards.

**Three options:**

| Option | Pros | Cons |
|---|---|---|
| (A) Reuse `ct_brain_telemetry` with `helper_name='mcp_tool:get_X'`, `consumer_name='cotrader-mcp'` | Single dashboard, one telemetry shape, no migration | Pollutes `helper_name` enum; dashboard organ-coverage queries need `helper_name NOT LIKE 'mcp_tool:%'` updates |
| (B) New table `ct_mcp_tool_calls` (`id, tool_name, consumer_name, args_summary jsonb, latency_ms, output_size_bytes, error, created_at`) | Clean separation; no organ pollution; can carry tool-specific args summary | Migration required (not in audit scope, must defer to Phase B); adds invariant target (warden coverage) |
| (C) Stderr only, no DB telemetry for v2 Tier 1 | Zero new infra, zero migration, zero risk | Loses observability — can't measure tool usage, can't catch regressions, can't warden it |

**Recommendation: (B), but defer migration to a separate Phase B-prereq commit.** The v1 MCP already proved telemetry is load-bearing (12-organ p95 visibility came from `ct_brain_telemetry`). v2 tools are direct-reads, not organ chains, and deserve their own table. Companion warden invariant: `mcp_tool_call_freshness_24h` once a baseline call rate exists.

If James prefers minimal-infra: pick (A) with the explicit `helper_name='mcp_tool:<name>'` convention and a follow-up filter in the get_brain_health RPC.

**See §9.2 for decision.**

---

## 4. Token budget per tool

All sizes measured against production via service-role REST (chars / 4 ≈ tokens):

| Tool | Default args probed | Bytes returned | ~Tokens | Recommended `limit` default | Recommended cap |
|---|---|---|---|---|---|
| `get_brain_principles` | n/a (table missing) | — | — | 20 | 50 |
| `get_observed_patterns` | `select=*&order=last_validated_at.desc&limit=20` | 11,485 | ~2,870 | **all 11 rows** (entire table fits) | 50 |
| `get_morning_brief` | `report_type=eq.morning_brief&select=body_markdown,summary&limit=1` | 2,292 | ~570 | **1 (latest match)** | 5 |
| `get_eod_summary` (slim, mode B) | `ct_eod_reports` slim subset + `ct_eod_summaries` headline fields | est. ~12,000 | ~3,000 | **1 session** | 3 |
| `get_eod_summary` (verbose, mode A) | full both tables | ~50,942 | ~12,700 | **opt-in only** | 1 |
| `get_warden_state` | join 29 invariants × state | ~11,629 (invariants) + 5,569 (state) | ~4,300 | **all 29 rows** | n/a (full snapshot) |
| `get_recent_james_flags` | last 168h all rows | 148 | ~37 | **lookback_hours=24, limit=50** | 200 |

**Verdict:** Every tool except `get_eod_summary` (verbose mode) fits comfortably under 8k tokens at recommended defaults. `get_warden_state` is the one to watch as the invariant manifest grows — currently 29 enabled, no upper bound. **Recommend a hard cap (`max_invariants=100`) inside the tool with a `truncated: true` meta flag** to defend the budget if/when the warden manifest scales.

The decisive token-budget call is **§9.4 (EOD slim vs verbose)**.

---

## 5. `brain_principles` (and successor) ticker filter shape

Since `brain_principles` doesn't exist, the actual question is the ticker filter for whichever principles table Tier 1 ends up hitting (per §9.1).

**`jac_principles`** — no ticker column. `principle` is freeform text. Naive `principle.ilike.%TSLA%` matches `'TSLAonly'`, `'TSLAQ'`, `'TESLA stock'` (no), and crucially fails on `'$TSLA'` if user includes the dollar sign and ilike doesn't strip it. **Word-boundary recommendation:** PostgREST exposes `~*` (case-insensitive POSIX regex). Use:
```
principle=imatch.\\m TSLA \\M
```
where `\m`/`\M` are POSIX word boundaries. PostgREST syntax: `principle=imatch.%5C%5CmTSLA%5C%5CM` (URL-encoded). Test at Phase B before relying on it.

**`ct_principles`** — same situation. No ticker column, `principle` freeform, `domain` is freeform but doesn't carry tickers. Same regex recommendation.

**`ct_specialist_principles`** — `specialist_ticker` IS structured. Filter is `specialist_ticker=eq.NVDA`. Clean.

**Recommendation:** if Tier 1 ships `get_brain_principles` against `ct_specialist_principles`, ticker filter is trivial. If against `jac_principles`/`ct_principles`, use POSIX `\m\M` regex and document the limitation. Off-watchlist tickers in principles (e.g., a principle about `FUBO` or `XYZ`) should still match — see §7.

---

## 6. Date handling — ET-aware reuse

`_shared/clock.ts` exports:
- `now(tz='America/New_York')` → `ClockSnapshot`
- `dateInTz(date, tz)` → `'YYYY-MM-DD'`
- `todayInET(tz)` → `'YYYY-MM-DD'` (the canonical ET session date)
- `dayNameInTz(ymd, tz)` → e.g. `'Tuesday'`
- `daysBetween(a, b)` → int
- `relativeDayTag(eventYmd, todayYmd)` → e.g. `'today'|'yesterday'|'next_week'`

`_shared/marketClock.ts` exports:
- `isMarketOpen(ts=now)` → bool (ET-aware, 09:30–16:00 weekdays)
- `nextMarketOpen(ts)` → Date
- `lastMarketClose(ts)` → Date
- `addTradingHours(start, hours)` → Date
- `marketClockState(ts)` → `Record<string, unknown>` (full snapshot)

**Reuse pattern for `get_morning_brief(date?)`:**
```ts
const targetEt = args.date ?? todayInET();          // 'YYYY-MM-DD' in ET
// translate to UTC window — DST-aware via Intl
const startUtc = zonedDateToUtc(`${targetEt}T00:00`, 'America/New_York');
const endUtc   = zonedDateToUtc(`${targetEt}T24:00`, 'America/New_York');
.from('brain_reports')
  .select('id, title, summary, body_markdown, created_at')
  .eq('report_type', 'morning_brief')
  .gte('created_at', startUtc.toISOString())
  .lt('created_at',  endUtc.toISOString())
  .order('created_at', { ascending: false })
  .limit(1);
```
(`zonedDateToUtc` may need to be added — `clock.ts` exports `dateInTz` for the reverse direction. Check `clock.ts` for an existing converter; if absent, the simplest correct path is using the `Intl.DateTimeFormat` with `timeZone: 'America/New_York'` to derive the UTC offset for the target date, then constructing the `Date` from the offset-applied string.)

**Reuse pattern for `get_eod_summary(date?)`:**
```ts
const ts = new Date();
let target: string;
if (args.date) target = args.date;
else if (isMarketOpen(ts)) {
  // during RTH — return most-recent-available, which is yesterday's session
  // (today's EOD doesn't exist until ct-eod-summary fires post-close)
  target = lastMarketClose(ts).toISOString().slice(0, 10);
} else {
  // before market open — yesterday's; after close — today's session
  // marketClockState carries the right reference date
  target = lastMarketClose(ts).toISOString().slice(0, 10);
}
.from('ct_eod_reports').select(...).eq('session_date', target)...
```

**Recommendation:** import both `clock.ts` and `marketClock.ts` from the `_shared/` path the same way v1's `get_co_trader_context` imports `claudeReadSurface.ts`. No new code, no copies; mirror the v1 pattern exactly.

---

## 7. Universe-lock validation policy per tool

Per CLAUDE.md Tenet 4, the watchlist is locked to 10 tickers. v1 (`get_co_trader_context`) hard-validates via `assertUniverseTicker`. For v2:

| Tool | Validate ticker arg? | Rationale |
|---|---|---|
| `get_brain_principles` | **NO** — accept any string OR drop ticker arg entirely if backed by `jac_principles`/`ct_principles` (no ticker column) | A principle may legitimately reference an off-watchlist symbol (e.g., a JAC reflection about VIX or BTC). Universe-locking would silently strip valid matches. |
| `get_observed_patterns` | **YES, soft** — warn but allow. Pattern signatures occasionally capture detector_id or time-of-day rather than ticker. | If user passes `MSFT`, validate against universe (it passes). If they pass an off-universe `XYZ`, return empty + warning, don't throw. |
| `get_morning_brief` | **N/A** — no ticker arg | The brief is a daily JAC-wide artifact, not per-ticker. |
| `get_eod_summary` | **N/A** — no ticker arg | Same. |
| `get_warden_state` | **N/A** — no ticker arg | System health is global. |
| `get_recent_james_flags` | **YES, hard** — `assertUniverseTicker` on input | James's stars are operational signals on the locked universe. Off-universe star = bug. |

**Recommendation:** v1's `assertUniverseTicker` is the right primitive. Wrap a softer variant `validateUniverseTickerSoft(t): { ok: boolean; warning?: string }` for tools that benefit from off-watchlist passthrough. Add to `lib/universe.ts` (one-line addition; defer the actual code to Phase B).

---

## 8. Tool description quality — drafts + ambiguity test

Descriptions terminal-Claude pattern-matches against. Drafted with the brief's example queries as the routing test. Each draft is opinionated (one verb, one noun, one outcome) so the model picks decisively.

### Drafts

**`get_brain_principles`**
> Returns JAC's distilled wisdom — recurring patterns, decision heuristics, and lessons James's brain has learned about trading and operating. Use when the user asks "what does the brain think about my trading patterns" / "what principles has JAC distilled" / "what's in my long-term memory about how I work." Read-only. Returns at most `limit` principles ordered by confidence DESC.

**`get_observed_patterns`**
> Returns the forensic platform's catalog of statistically-confirmed patterns over Co-Trader flag history (e.g. "NVDA 3-day-axis settles +22pp above baseline at n=212"). Use when the user asks "what patterns has the system validated" / "what has the corpus shown us" / "show me the observed-pattern catalog." Status filter defaults to validated+observed (excludes deprecated). Read-only.

**`get_morning_brief`**
> Returns JAC's morning brief for a given ET date (default: today). The brief is the 6 AM ET digest: today's schedule, this-week deadlines, what JAC did overnight, brain activity summary, heads-up items. Use when the user asks "what was in this morning's brief" / "did I get my morning brief today" / "what does my schedule look like today per JAC." Read-only, single row.

**`get_eod_summary`**
> Returns Co-Trader's end-of-day session summary for a given trading session (default: most-recent completed session per market clock). Combines the slim narrative + per-ticker close + regime shift + tomorrow's watchlist. Use when the user asks "how did yesterday's session grade out" / "what did the EOD report say about today" / "show me today's specialist scorecard." Pass `verbose: true` for the full long-form markdown. Read-only.

**`get_warden_state`**
> Returns the System Warden's current invariant snapshot — every active integrity check ordered by severity then by failure count. Use when the user asks "is the system healthy right now" / "what's failing" / "is the warden green" / "any warden alarms." Returns failing checks first; each carries severity, runbook_path, last_value, last_run_at. Read-only.

**`get_recent_james_flags`**
> Returns flags James has personally starred from the /tape UI within the last `hours` hours (default 24, max 168). These are James's hand-labeled signals — distinct from the system's auto-generated detector flags. Use when the user asks "what did I flag yesterday" / "what was I tracking this week" / "show me my own marks." Off-watchlist tickers rejected. Read-only.

### Ambiguity test (per brief)

| Sample query | Expected tool | Why this draft routes correctly |
|---|---|---|
| "What does the brain think about my trading patterns?" | `get_brain_principles` | "trading patterns" + "brain thinks" maps to wisdom/heuristics, not statistical pattern catalog (the latter doesn't say "thinks") |
| "What patterns has the system validated?" | `get_observed_patterns` | "validated" is the keyword in this tool's description |
| "What was in this morning's brief?" | `get_morning_brief` | exact phrase match |
| "How did yesterday's session grade out?" | `get_eod_summary` | "session grade" maps to EOD scorecard |
| "Is the system healthy right now?" | `get_warden_state` | "healthy" is the keyword |
| "What did I flag yesterday?" | `get_recent_james_flags` | "I flag" disambiguates from system-generated |

**Adversarial cases:**
- "What patterns is JAC seeing?" → ambiguous: could be `get_observed_patterns` (statistical) or `get_brain_principles` (heuristic). Mitigation: principles description says "distilled wisdom," patterns description says "statistically-confirmed." Force one keyword each.
- "What's the latest from JAC?" → could be `get_morning_brief` OR `get_eod_summary`. Mitigation: morning brief description says "6 AM ET digest"; EOD says "trading session." Both are time-anchored, so the model should pick on time-of-day cue from the user's prior context.
- "What did the system flag?" → could be `get_recent_james_flags` (no — explicitly James's own) or `get_co_trader_context` (no — that's per-ticker context bundle). The "James flagged" tool description must keep the "I/me" framing tight.
- "Is Co-Trader running?" → could route to `get_warden_state` (correct) or `get_co_trader_context` (incorrect — that needs a ticker). Warden description mentions "current invariant snapshot" — tighter match.

**Overlap check vs v1 `get_co_trader_context`:** v1 description (per `tools/get_co_trader_context.ts`) covers per-ticker brain context — regime, specialist reads, flow, news, tape. None of the v2 tools take a single ticker AND return a multi-organ payload. The split is clean.

---

## 9. Surfaced trade-offs requiring James's call

### 9.1 — `brain_principles` is structurally absent. What ships?

The brief asks for `get_brain_principles` reading from `brain_principles`. That table doesn't exist. The cron that should populate it (`distill-principles`, weekly) has been silently no-op'ing. The follow-on punchline: **if no principles exist anywhere, the tool returns empty regardless of which existing table it points to** (verified — `jac_principles`, `ct_principles`, `ct_specialist_principles` all n=0).

**Three options:**

| Option | Pros | Cons |
|---|---|---|
| (a) **DROP `get_brain_principles` from Tier 1.** Surface as a separate punch-list silent-failure-class kill (fix `distill-principles` to write to `jac_principles`, populate, add a warden invariant on row-count growth). Re-add tool in Tier 2 once principles exist. | Doesn't ship a tool that returns empty 100% of the time; punchlist gets a structural fix that benefits everything; doesn't fake competency | Tier 1 ships 5 tools instead of 6 |
| (b) **Ship the tool against `jac_principles`** (most natural fit — that's what `distill-principles` was supposed to write to). Tool returns empty until the silent-failure is fixed in a separate change. | Six tools ship as planned; class fix can land any time without re-touching MCP code | Tool returns empty for an unknown duration; users get "no principles yet" as the answer to every call |
| (c) **Ship the tool against `ct_specialist_principles`** (the only table with a structured `specialist_ticker`). Same emptiness today, but uses the per-ticker shape. | Cleanest filter shape for the ticker arg | This is a Co-Trader-specific table, narrows the brief's "JAC's distilled wisdom" framing |

**Recommendation: (a) — drop, fix root cause, re-add in Tier 2.** The brief explicitly cited `distill-principles` as the writer; the writer is broken. Shipping a tool that wraps an empty table fakes competency. The class kill is a one-line change in `distill-principles/index.ts` (`'brain_principles'` → `'jac_principles'`), then a manual fire to populate. Audit recommends Tier 1 ships 5 tools.

### 9.2 — Telemetry shape

Three options summarized in §3. **Recommendation: (B) new `ct_mcp_tool_calls` table** (deferred to Phase B prereq commit). Falls back gracefully to (A) if James prefers no migration. **Decision needed.**

### 9.3 — Universe-lock per tool

Per §7: hard for `get_recent_james_flags`, soft for `get_observed_patterns`, off for the rest. **Recommend approval as drafted.**

### 9.4 — EOD default mode

§4 + §1.4: slim default (~3k tokens) vs verbose opt-in (~12.7k). **Recommend default-slim with `verbose: true` opt-in.** James's existing reading habit ("how did yesterday grade") is satisfied by the slim payload; the long markdown is rarely needed mid-conversation.

### 9.5 — Warden output: direct join vs `get_warden_health` RPC

§1.5: both options are correct. **Recommend the RPC** (single round trip, server-aggregated, dashboard-canonical). Verify the RPC signature in Phase B before committing.

### 9.6 — `body_markdown` PII surface (§2)

Morning brief and brain reports may contain personal scheduling content. **Recommend a one-line README warning** that MCP transcripts containing brief output should be treated as private. No code change needed.

---

## 10. Recommended Phase B work plan

Assumes §9 approvals land as recommended.

**Phase B Prereq (separate commit, before Phase B starts):**
1. Fix `distill-principles/index.ts` line 100, 188, 239, 252: `'brain_principles'` → `'jac_principles'`. Manual fire to populate. Add warden invariant `jac_principles_growing_weekly` (severity=warn, expected_min=1 row growth/week).
2. Migration: create `ct_mcp_tool_calls` table (`id bigint, tool_name text, consumer_name text, args_summary jsonb, latency_ms int, output_size_bytes int, error text, created_at timestamptz default now()`). RLS service-role-only.

**Phase B (the build itself):**
1. Add to `mcp/cotrader/lib/universe.ts`: `validateUniverseTickerSoft()`.
2. Add `mcp/cotrader/lib/dates.ts`: ET-day window helper + EOD-target resolver (importing `clock.ts` + `marketClock.ts` directly from `_shared/`).
3. Add `mcp/cotrader/lib/telemetry.ts`: fire-and-forget insert to `ct_mcp_tool_calls` (mirrors `ct_brain_telemetry` write pattern, never throws).
4. Add `mcp/cotrader/tools/get_observed_patterns.ts` — JSONB containment filter, status default = `validated|observed`.
5. Add `mcp/cotrader/tools/get_morning_brief.ts` — date-arg ET window, single row.
6. Add `mcp/cotrader/tools/get_eod_summary.ts` — slim default + verbose flag, joined select.
7. Add `mcp/cotrader/tools/get_warden_state.ts` — calls `get_warden_health` RPC.
8. Add `mcp/cotrader/tools/get_recent_james_flags.ts` — `source=james_star` + `assertUniverseTicker`.
9. Register all 5 in `server.ts` next to v1's `get_co_trader_context`.
10. Update `smoke-test.ts` to exercise each new tool (one assert per tool: payload returned, latency under cap, telemetry row written).
11. README — add v2 Tier 1 section with the same shape as v1 (one paragraph per tool, cost model rolled into a single line, ambiguity test cases).

**Tier 2 (deferred):** `get_brain_principles` against `jac_principles` once the fix-and-populate Prereq has at least 5 rows in production.

---

## 11. Tables / RPCs that DON'T exist or have shifted

| Brief reference | Reality | Action |
|---|---|---|
| `brain_principles` | Does not exist (PGRST205); cron writer silently no-op'ing | Drop tool from Tier 1 (§9.1) |
| `ct_warden_alarm_state` (canonical for warden) | Exists but is state-only (no severity, no runbook) — must join `ct_invariants` or use `get_warden_health` RPC | Use RPC (§1.5, §9.5) |
| `ct_eod_summaries` vs `ct_eod_reports` | Both exist, different shapes, joined by `eod_summary_id` (1:1 by `session_date`) | Compose slim by default (§9.4) |
| `ct_flags.ticker` | Doesn't exist — column is `instrument` | Use `instrument` (§1.6, confirmed by memory) |
| `ct_observed_patterns.status='validated'` only | Production has `validated|observed|deprecated` — `validated` is rarest (1/11) | Default filter = `validated|observed` (§1.2) |
| `jac_principles` | Exists, n=0 | Available as fallback if §9.1 chooses (b) |

---

## Approval

- [ ] §9.1 — DROP `get_brain_principles` from Tier 1, fix `distill-principles` writer in Phase B Prereq, re-add as Tier 2 ✓ / propose alternative
- [ ] §9.2 — Telemetry: new `ct_mcp_tool_calls` table (B) ✓ / fallback to `ct_brain_telemetry` reuse (A) / stderr-only (C)
- [ ] §9.3 — Universe-lock policy (hard for james_flags, soft for observed_patterns, off elsewhere) ✓ / propose alternative
- [ ] §9.4 — EOD default-slim + verbose flag ✓ / always-verbose / always-slim
- [ ] §9.5 — Warden via `get_warden_health` RPC ✓ / direct join
- [ ] §9.6 — README PII warning on brief content ✓
- [ ] Phase B greenlight (assuming Prereq fix ships first if §9.1 = a)
