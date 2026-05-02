# LinkJac Co-Trader Playbook

The single canonical operations doc. Contains:
1. **Today's / Tomorrow's Watching Plan** (live, rolling — top of file)
2. **Active items** (open punch list — Saturday work, latent bugs, deferred items)
3. **Pre-open verification + bug pattern catalog** (appendix from Morning Ops)
4. **Closed today** (achievement log)

Companion script: `scripts/linkjac_cotrader_watch.sh` — run during RTH to monitor.

**Last major update: 2026-04-30 evening** — class kills shipped (heatmap, temporal, pg_net timeout, UW budget cuts, Haiku judge, tide formula). 40+ commits today.

---

## 📍 TOMORROW'S WATCHING PLAN — Friday 2026-05-01

**What's new since this morning that affects how we watch tomorrow:**

### UW budget — tier-aware throttle is live, never been exercised at scale
The `ct-contract-poller` now self-throttles at three tiers:
- `< 70%` budget used → polls every `*/4` (current full cadence)
- `70-85%` → polls every `*/5` (drops 21 fires/day)
- `85-95%` → polls every `*/7` (drops further)
- `≥ 95%` → skips entirely with `skipped_reason` recorded

**Watch criterion**: at 14:00 ET (~4 hours into session), check `/health` UW chip:
- If 60-70% at 14:00 → on track for ~80-85% close ✓
- If > 75% at 14:00 → throttle SHOULD activate around 14:30; verify ct-contract-poller's `last_run_duration` shortens or `skipped_reason` field appears
- If > 90% by 15:00 → ping me; we ship a manual cron pause like today's 18:55 fix

### 5-min UW dedup cache — first day live
`_shared/uwClient.ts` cache layer is live across 28 functions. Expected ~750 calls/day saved via dedup of duplicate option-chain / OI / news / sector-tide calls within 5-min windows.

**Watch criterion**: query `getUwCacheStats()` if exposed, or count `[uwClient][cache-hit]` log breadcrumbs in any function's recent logs. Hit rate should be 5-15% of total calls; if 0% the cache isn't working, if > 30% something's stale-serving.

### Temporal validator warnings — will produce signal
Every Claude consumer (15 of them now) calls `validateTemporalCoherence()` post-generation. Critical contradictions persist to JSONB columns.

**Watch criterion**: query midday for any `temporal_validator_warnings` with `critical_count > 0`:
```sql
SELECT 'eod-summary' AS source, count(*) FROM ct_eod_summaries 
  WHERE market_stats->'temporal_validator_warnings'->>'critical_count' != '0'
  AND session_date >= CURRENT_DATE
UNION SELECT 'tape-reader', count(*) FROM ct_tape_commentary  
  WHERE created_at >= CURRENT_DATE AND temporal_validator_warnings->>'critical_count' != '0'
-- ... etc per consumer
```
If consistent contradictions on a specific consumer, that consumer needs a sharper anchor.

### OI snapshot — re-enabled, watch for full ticker coverage at close
ct-oi-snapshot-close fires Friday 20:05 UTC. With the rate-limit retry shipped today, expect all 10 watchlist tickers to land rows.

**Watch criterion**: at 20:10 UTC, query:
```sql
SELECT ticker, count(*) FROM ct_oi_snapshots 
  WHERE snap_date = CURRENT_DATE AND snap_slot = 'close' GROUP BY ticker;
```
All 10 tickers should appear with non-zero count. If MSFT/GOOGL/AMZN/META still missing → rate-limit fix isn't working post-deploy.

### Tide formula — reads bullish/bearish correctly now
The tape reader's tide label was inverted on a portion of flows (`+` instead of `-` in the math). Fixed today (commit `2f9fa69`). Tomorrow's tide should track the heatmap's `aggressive_directional_decay` per-ticker sign.

**Watch criterion**: glance at `/tape` banner — if it labels "bearish" while market is up >0.5%, cross-reference against `/heatmap` Combined view. They should agree on sign per ticker now.

### Hypothesis lifecycle — resumed after 12 days dark
ct-hypothesis-health-check Haiku judge fixed via forced tool-use (commit `e8b30c3`). First fire at 23:33 UTC produced 9 ambiguous_hold outcomes (today's data was UW-poisoned; ambiguous is honest).

**Watch criterion**: by midday tomorrow, expect first `intact` and `invalidated` outcomes to appear in `ct_claude_decisions`. If still 100% ambiguous after 4-5 fires of the cron, the judge prompt needs tightening.

### LB6 OI historical gap — stale data acknowledged
MSFT/GOOGL/META snap_date stuck at 2026-04-28; AMZN at 2026-04-24. OvernightPositioning panel shows only 6/10 tickers on those tickers' rows. **Saturday backfill** is the fix. Tomorrow: this gap persists; don't read missing tickers as "no overnight movement."

### What you can ignore tomorrow

- "9 overdue" badge — JAC-side reminders, your personal calendar
- Bundle size warning on build — cosmetic
- Per-strike delta in heatmap Per-Ticker view (B6) — deferred to Saturday

### Run the watch script

```bash
bash /Users/jameschellis/jac-agent-os/scripts/linkjac_cotrader_watch.sh
```

5-min refresh loop; Ctrl-C to stop. Override interval: `INTERVAL_SEC=60 bash ...`.

---

## ✅ RESOLVED — ct-oi-snapshot-close re-enabled

Was unscheduled 2026-04-30 18:55 UTC (commit `d0d6b9a`) for UW budget reasons. Re-enabled same evening (commit `3804183` migration `20260430232000_reenable_oi_close_tonight.sql`). Friday's 20:05 UTC close fire runs normally. Belt-and-suspenders: remote-scheduled agent `trig_01WTvsphoauozF1XoXJ2ZqXe` will idempotently re-add Friday morning if needed.

---

## Temporal contamination class kill — 2026-04-30 (PARTIAL today, finish Saturday)

The morning brief bug at 7am ET and the tape reader bug at 1pm ET were the same class: Claude consumers without a hard date anchor pattern-completing yesterday's narrative as today's. Class kill shipped today via shared helpers + 5 consumer wires + Haiku validator. Saturday extends to remaining consumers.

### Shipped today (commit `1314a57` + `87d9783`)

- `_shared/temporalContext.ts` — `getTemporalContext()` returns `session_date` (NY-tz), day name, ET clock, `temporalAnchorPreamble` for narrative consumers, `temporalAnchorShort` for JSON/tool-use consumers
- `_shared/temporalValidator.ts` — Haiku-powered post-generation safety net. Returns `{ok, contradictions[]}`. Defensive (returns ok=true on Haiku errors)
- Wired into: `ct-tape-reader`, `ct-eod-summary`, `ct-eod-report`, `ct-hypothesis-proposer`, `ct-hypothesis-health-check`
- Validator caught a real critical contradiction on EOD summary regenerate at 18:01 UTC ("Friday gap-down unwind executing in real-time" on a Thursday session) and persisted it to `market_stats.temporal_validator_warnings`. Defense-in-depth confirmed working.

### Bonus capability shipped

- `ct-hypothesis-health-check` now scans every open hypothesis claim for past-dated text (regex: YYYY-MM-DD, "Apr 29", etc). Returns `stale_temporal_count` + `stale_temporal_hypothesis_ids[]` in response. Optional `auto_refute_stale_dated` body param (default false) one-shots retire on next fire. Would have caught today's AMZN-Apr-29 hyp before it polluted the morning brief.

### NOT wired yet — Saturday work

These consumers still build their own context and prompt without the temporal anchor or validator:

| Consumer | Cadence | Output style | Use which anchor |
|---|---|---|---|
| `ct-daily-brief` | 7am ET cron + breaking-news rebriefs | Sonnet narrative + tool-use | preamble (Saturday rebuild handles it) |
| 10 specialists via `_shared/specialistRunner.ts` | per-ticker rotation | Claude prose | preamble |
| `ct-trade-idea-generator` | every 5 min RTH | tool-use | short |
| `ct-watcher` | every 15 min | mixed | preamble |
| `ct-self-grader` | every 2h RTH | Sonnet prose | preamble |

Wiring is identical to today's pattern (~10-15 lines each). Saturday agent fans out, all get same treatment.

### Pattern lesson learned today

Initial deploy of Agent O's `ct-hypothesis-health-check` wire ALSO returned 6/6 Haiku JSON parses failed. **Investigation correction:** the Haiku judgment in `judgeHypothesis` has been failing since **2026-04-18 (12 days ago) — 1,588 total `haiku_failed` rows in `ct_claude_decisions`**. NOT a regression from today's temporal preamble. Pre-existing bug Agent O misattributed.

The `temporalAnchorShort` variant shipped today is still good preventive medicine for any FUTURE Haiku JSON consumer. Documented in helper: **JSON output → use `temporalAnchorShort`. Prose output → use `temporalAnchorPreamble`.**

### LB5) `judgeHypothesis` Haiku call broken since 2026-04-18 — Saturday investigation

The Haiku call in `ct-hypothesis-health-check.judgeHypothesis()` has been returning unparseable output for ~2 weeks. Symptom: zero rows with `outcome IN ('intact', 'invalidated', 'ambiguous')` in `ct_claude_decisions` despite 1,588+ `haiku_failed` rows. Result: **the hypothesis lifecycle has had no Haiku-graded refutation for 12 days** — open hypotheses pile up without auto-judgment.

Possible root causes (Saturday triage):
- Haiku model behavior shift (Claude 3.5 Haiku vs Haiku 4.5 — check `CLAUDE_MODELS.haiku` value)
- Prompt asks for strict JSON but Haiku now wraps with backticks or commentary; the regex strip in `judgeHypothesis` (lines 200) may need updating
- `max_tokens: 250` may now be too tight; bump to 500
- Move to forced tool-use pattern (matches what `ct-eod-report` and `ct-daily-brief` already do successfully)

Workaround in place: the new `detectPastDatesInText()` scan in `ct-hypothesis-health-check` works regardless of Haiku — stale-dated hypotheses can still be auto-flagged via the regex pass without depending on the broken judge.

### Validator-warnings telemetry — Saturday addition

Each consumer currently persists `temporal_validator_warnings` to whatever JSONB field is convenient (`market_stats`, `context_snapshot`). Saturday: standardize on a queryable `ct_temporal_validator_log` table or a consistent column name across all consumers, so we can dashboard "how often is each consumer producing temporally-incoherent output?" and grade accordingly.

### Tenet check

**Tenet 13** (hallucination is inevitable; structural prevention is the answer) — proven by today's validator catching real contradictions in production. **Tenet 15** (kill the class) — partial today (5 consumers), full by Saturday close (10+ consumers).

---

## Heatmap consumer propagation — 2026-04-30 (PARTIAL today, finish Saturday)

Heatmap data is now LIVE in `ct_flow_heatmap_snapshots` and queryable via 4 RPCs (live, history, diff, strikes). The `_shared/flowHeatmapContext.ts` helper exposes the standard "top 3 stacks per ticker" shape for any Claude consumer.

### Wired today (in production)

- `ct-daily-brief` — already wired via `buildClaudeContext()` in `_shared/claudeReadSurface.ts` (commit `87bebd6`). Picks up on next deploy (Saturday's brief rebuild redeploys it anyway).
- `ct-hypothesis-proposer` + `ct-hypothesis-health-check` — same path.
- `ct-eod-summary` — wired via `getFlowHeatmapContext()` 2026-04-30 afternoon (commit pending). First scheduled fire today 4:30 PM ET will consume.
- `ct-eod-report` — wired via `getFlowHeatmapContext()` 2026-04-30 afternoon (commit pending). First scheduled fire today 5 PM ET will consume.
- `flow_stack_v1` detector — reads snapshots directly. Already firing flags.
- `/heatmap` page — Combined view + Per-Ticker view + drill panel + delta toggle.

### NOT wired yet — Saturday/Sunday work

These consumers build their own context inline and don't import either `buildClaudeContext()` or `getFlowHeatmapContext()` yet. Each fire is currently blind to where positioning is stacking on its target tickers.

| Consumer | Cadence | Notes |
|---|---|---|
| `ct-tape-reader` | every 10 min RTH | Top priority — narrative reader of the live tape, should know stacking context. ALSO needs temporal anchoring fix (truncates, no relative-day baseline). |
| 10 specialists via `_shared/specialistRunner.ts` | per-ticker rotation, ~every 6 min on each | Each specialist should see ITS ticker's heatmap state. Single shared runner means one wire reaches all 10. |
| `ct-trade-idea-generator` | every 5 min RTH | Already burns ~$1/day in Claude calls; adding heatmap context is high-leverage for trade quality. |
| `ct-watcher` | every 15 min | Lower priority — already heavy on its own context. |
| `ct-self-grader` | every 2h RTH | Could grade against "did the heatmap predict the move?" — but current grader doesn't read heatmap. Saturday work. |

### Scope of Saturday's heatmap propagation

- One pass per consumer: import `getFlowHeatmapContext`, call it during context build, inject result into the user-message payload. Pattern is identical across all consumers — copy/paste from ct-eod-summary/ct-eod-report wires.
- Estimated: ~4-6h via parallel agents (one per consumer, or two bigger agents handling 3 each).
- Lands together with morning brief rebuild (Saturday's bigger structural fix). Specialists redeploy is part of that bundle.

### Why this is partial-not-complete today

Today shipped: storage + RPCs + UI + detector + EOD wires (the most critical ones for today's first scheduled fires). Saturday's plan already scoped tape-reader/specialists/idea-gen/watcher/self-grader as Sunday propagation work — that's still the right shape, just made explicit here.

### Tenet check

**Tenet 24** — "all systems talk to each other, no silos." Today's partial wire is the START of compliance, not the end. Until Saturday's pass, tape-reader and specialists are still siloed from the heatmap. Class kill = every Claude consumer reads heatmap. Saturday closes it.

---

## Latent UI / health bugs surfaced 2026-04-30 (during heatmap build site audit)

Captured during `/health` audit at ~12:00 ET while heatmap polish was shipping. Not blockers, not fixing today — investigate and triage tonight or this weekend.

### LB1) `/health` preflight reads "NOT READY (5 green, 2 yellow, 3 red)" — partially diagnosed

Preflight has **10 checks** (not 8 as topbar implies): `crons`, `cron_failures_6h`, `morning_brief`, `book`, `uw_usage`, `heartbeat`, `biases`, `weekend_news`, `config`, `kill_switch`. Quick drill 2026-04-30 ~12:30 ET found:

- ✅ `morning_brief` — today's brief v3 exists. Green.
- ✅ `heartbeat` — last beat 16:16 UTC (~10 min). Green.
- ✅ `weekend_news` — 225 entries, weekend captured. Green.
- ✅ `cron_failures_6h` — zero unresolved cron failures since 10:00 UTC. Green.
- ❌ **`book`** — NO `ct_book` row for `2026-04-30`. **This is one of the 3 reds.** But: paper-trading Claude is demoted to research layer (per `feedback_co_trader_thesis.md` strategic reset 2026-04-25). Daily ct_book seeding may have been intentionally stopped. **Decision pending from James:** seed it for paper continuity, or remove the `book` preflight check now that paper trader is research-layer-only. Not fixing without his call.
- 🟡 `biases`, `config` — schema mismatch on direct queries (`bias` and `value_text` columns don't exist). The preflight hook may use different column names; need to read its impl. Could be the source of the other reds OR yellows.

Remaining 2 reds: not yet identified. Saturday investigation: read `usePreflightChecks.ts` impl line-by-line, run each check's exact query, identify the failing checks by name.

**Why not now:** decision on `book` requires James (paper-trader policy). Other reds need source code review, not just data inspection.

### LB2) UI crashes — RESOLVED 2026-04-30

All 3 unresolved `ct_ui_errors` rows marked `resolved=true` after audit:

- ✅ `/heatmap` toFixed crash (4/30 15:08 UTC) — verified fixed by commit `a80b2fd` (27-site null hardening across heatmap components)
- ✅ `/` length crash (4/28 23:16 UTC) — bundle `index-KavOSFGs.js` no longer running; multiple intervening deploys make recurrence impossible on the same code path. Stale row.
- ✅ `/` React #310 (4/18 13:23 UTC) — bundle `index-Bk-4z12a.js` from 12 days ago, completely superseded. Stale row.

Topbar "1 unresolved UI crash in 24h" badge should clear on next page refresh. No action remaining for these specific crashes. **Pattern lesson:** error-log rows accumulate `resolved=false` even when the underlying bug is silently fixed by subsequent deploys. Saturday item: add a sweeper that auto-resolves rows from bundle hashes no longer in production.

### LB3) "9 overdue" notification — attributed to JAC, not Co-Trader

Source identified: `useUpcomingReminders` hook reading JAC-side reminders (entries with `reminder_sent=false` and event_date past). Not Co-Trader. These are James's calendar/reminders piling up.

**Why not touching:** cross-facet data, James's personal items. He can clear them when he wants. The badge being persistent is informational, not a bug. **Saturday consideration:** add a "snooze older than N days" auto-action to the reminder pipeline so the badge naturally degrades instead of accumulating forever.

### ~~LB8) UW budget reduction plan — Saturday (target -5,000 calls/day)~~ — CLOSED 2026-05-02 [audit baseline refuted; needs re-derivation]

> The audit baseline driving LB8 (16.3% mid-week share for `ct-historical-quote-backfill`, 50% for `ct-contract-poller`, 13% unknown callers, etc.) was systematically biased by two compounding methodology errors:
>
> 1. **PostgREST 1,000-row response cap** (`feedback_postgrest_1000_row_cap`) — sample skewed toward late-evening rows.
> 2. **`session_date` ET-bucketing** (`(now() AT TIME ZONE 'America/New_York')::date`) silently mixes UTC clock-day and ET session-day. Caller-cadence questions answered with ET-bucket data systematically misattribute spillover.
>
> Track 2 investigation re-derived the `ct-historical-quote-backfill` number under correct bucketing: **0 mid-week calls, 4.31% Friday share (not 16.3%), 100% UTC↔ET boundary spillover**. Function is correctly weekend-gated (`*/30 * * * 0,6` UTC) and capped at ≤200 calls/fire — no leak.
>
> Same class as the 2026-04-30 budget-views ET-vs-UTC bug (`67c4a19`). Convention going forward: caller-cadence questions → UTC clock-day; budget-vs-cap questions → ET session_date; never silently mix.
>
> The other LB8 sub-cuts (contract poller throttle, weekend moves, dedup, expired-0DTE filter, tag unknown callers) may still warrant work, but their per-caller % shares need re-derivation under correct bucketing before deciding which to ship. Re-prioritize on fresh analysis if/when budget pressure recurs.
>
> See `docs/decisions/2026-05-02-historical-quote-backfill-investigation.md` for the full Track 2 audit.

### LB7) Tape reader "tide" formula audit — Saturday

Surfaced 2026-04-30 ~14:45 ET. James saw "bearish tide" in tape reader on a price-up day. Investigation showed total today = **-220M** across watchlist via the existing formula:

```
netPrem += (t.net_call_premium ?? 0) + (t.net_put_premium ?? 0);
```

**The `+` is suspicious.** Standard convention has `net_put_premium` positive = aggressive put buying = bearish. If that holds, the correct directional metric is `net_call - net_put`, not `+`. Adding them mixes a bullish signal with a bearish one. AMZN today: net_call=-84M (call selling), net_put=+3.5M (put buying). Both bearish-leaning — sum = -80.5M. But the formula structure doesn't differentiate "calls being sold" from "puts being bought" — both register as the same signed bucket.

Saturday actions:
1. **Verify column semantics** — check `_shared/uwClient.ts` (where `net_premium_ticks` is ingested) or UW docs to confirm what positive/negative `net_put_premium` actually means.
2. **Cross-reference against heatmap math** — `aggressive_directional_decay` uses `inferDirection()` (canonical truth post-2026-04-28 symmetry fix) and computes `aggressive_ask_call_premium - aggressive_ask_put_premium`. The heatmap is the ground truth; the tape-reader tide should agree (after sign convention is settled).
3. **If formula is wrong**, change to `net_call - net_put`. Re-run today's row through both formulas and compare.
4. **If formula is right**, the tide IS legitimately bearish today (real institutional unwinding into strength) — surface that nuance in the tape commentary instead of just labeling "bearish".

Heatmap data layer (shipped today) gives us a trustworthy reference. Without it, this audit would have been guesswork. With it, Saturday can definitively decide.

### ~~LB6) OvernightPositioning historical gap — Saturday backfill + delta-RPC fix~~ — ARCHIVED 2026-05-02 [RESOLVED]

> Archived as 5th staleness instance. Original symptom (6/10 tickers in panel) was resolved by the 2026-04-30 per-ticker quota migration `20260430183000_top_oi_shifts_per_ticker_quota.sql`, not by the proposed historical backfill. Phase A audit caught the false premise before any UW spend. All 10 watchlist tickers now have substantive OI data with valid `oi_delta_1d`.
>
> Bonus methodology finding: the proposed backfill body shape would have silently failed regardless — `ct-oi-backfill-historical` is hardcoded to today/yesterday. Captured separately.
>
> See `docs/decisions/2026-05-02-punchlist-staleness-archive.md#item-5` and `docs/decisions/2026-05-02-oi-backfill-historical-parameterization.md`.

### LB4) Bundle size warning (cosmetic)

`npm run build` warns: "Some chunks are larger than 500 kB after minification" — bundle is 2,280 KB minified / 611 KB gzipped. Vite recommends code-splitting via dynamic `import()` or `manualChunks`. Not a bug, just a startup-perf opportunity. Saturday afternoon when nothing else is queued.

---

## Already resolved by 2026-04-30 commits (don't re-investigate)

- ✅ `/heatmap` TypeError "Cannot read properties of null (reading 'toFixed')" — was a heatmap rendering bug from the earlier afternoon's first deploy; fixed in `a80b2fd` via 27-site null hardening across Grid, PerTicker, Drill components.

---

## P0 — pg_net timeout_milliseconds class kill — 2026-04-30 (TONIGHT POST-CLOSE OR SATURDAY)

### What the bug is

Every cron that calls an edge function via `net.http_post(...)` and does NOT explicitly pass `timeout_milliseconds` inherits pg_net's default timeout (1-5 seconds depending on Postgres version). When the edge function takes longer than that timeout to return, pg_net silently **cancels the in-flight HTTP request**. The function gets killed mid-execution and writes nothing.

The cron itself sees `last_run_status = succeeded` because `net.http_post` is fire-and-forget at the cron level — it returns a `request_id` as soon as the HTTP call is queued, BEFORE the actual response comes back. So cron-monitoring shows "all green" while the function pipeline is dead.

The poisoned trail looks like this:
1. Cron fires every N min during RTH
2. `cron.job_run_details.last_run_status` = `succeeded`, duration ~50-200ms (just queue time)
3. The async HTTP call gets killed by pg_net at 1-5s
4. Function never finishes; no INSERTs land
5. ct_flow_alerts (or whatever target table) shows zero rows from cron fires
6. Detector portfolio runs on stale data; scoreboard goes dark; specialist `current_reads` go silent
7. Site looks broken pre-bell, "comes back" only when something forces a manual fire

### Why it needs to be fixed (downstream impact)

This is not cosmetic. This was the root cause of:
- **2026-04-30 morning** — ct_flow_alerts had ZERO rows from cron fires from open through 9:50 ET. Detector portfolio was dark. Tape was empty. Caught live, fixed in flight (commit `b22a3ff`) — but only for the 3 flow-ingester crons known broken at that moment.
- **Likely class-wide silent failures** going back days/weeks. The "first voodoo money" finding (memory `project_co_trader_first_voodoo_money_2026_04_24.md`) and the detector-portfolio `signature_magnitude_stats` corpus may both have been built against a partially-poisoned dataset where cron-fired ingestion silently dropped chunks. Worth re-checking Saturday.
- **EOD report scorecard accuracy** — if `ct-eod-report` (Sonnet, ~10-30s expected) hits the same bug, today's first scheduled 5pm ET fire writes nothing to `ct_eod_reports` and the morning-brief grading loop dies on the floor.
- **Daily brief** — if `ct-daily-brief` (Sonnet 30-60s with tool use) inherits the default, every morning brief fire is a coinflip on whether the function completes before pg_net kills it. Could explain why we sometimes get duplicate brief versions on race conditions.

**Trust-per-alarm gold (Tenet 3):** False healthy-status from cron monitoring is worse than a missed alert — it makes us *believe* the system is working when it isn't. Every cron in the codebase that doesn't pass an explicit timeout is a latent ticking failure.

### Why fix tonight post-close OR Saturday (not now)

- **Touches every cron migration** — could be 30-50+ schedules across 60+ migration files
- **Each schedule needs unschedule + reschedule with new timeout** — cron drops out of the schedule briefly during the migration
- **No safety net during the fix window** — if a migration fails halfway, some crons might end up unscheduled
- **Live-trading session** — flow-ingester is now working, EOD/specialist/detector pipelines all firing on today's known-broken-but-now-fixed schedule pattern. Don't disturb during RTH.
- **Best window:** post-close tonight (after 4pm ET / 20:00 UTC) when no production crons need to fire OR Saturday when nothing is running.

### Scope — every cron using `net.http_post` to invoke an edge function

Likely candidates to audit (from cron schedule list earlier today):
- `ct-eod-summary` (Sonnet narrative, 10-30s)
- `ct-eod-report` (Sonnet tool-use, 10-30s) ← **first scheduled fire today 21:00 UTC**
- `ct-daily-brief` (Sonnet tool-use, 30-60s, sometimes longer with re-briefs)
- `ct-tavily-news-watcher` (Tavily call + classification, can be slow)
- `ct-news-ingester` (UW news headlines, 1-3s typically but variable)
- `ct-news-sweep` (Tavily + Claude, multi-second)
- `ct-tape-reader` (Sonnet, 5-15s with truncation)
- All 10 specialist crons (`ct-specialist-{TICKER}`, Claude calls, multi-second)
- All detector RTH crons (variable)
- `ct-snapshot-refresh` (UW per-ticker, ~1-2s)
- `ct-contract-poller` (UW heavy, 2-5s)
- `ct-print-grader` (UW + DB, 2-10s)
- `ct-contract-grader` (UW + DB, multi-second)
- `ct-cron-health-check` (DB scan, 1-2s)
- Any other `*-ingester`, `*-watcher`, `*-grader`, `*-curator`

**Already fixed (commit `b22a3ff`):**
- `ct-flow-ingester-perticker-rth`
- `ct-flow-ingester-perticker-offrth`
- `ct-flow-ingester-marketwide`

### The fix — class kill via shared helper

**Wrong way (instance patching):** find every cron migration and add `timeout_milliseconds := 60000` to each. Brittle — next time someone schedules a new cron they'll forget.

**Right way (structural):** introduce `_ct_schedule_post(name, schedule, fn, body, timeout_ms)` SECURITY DEFINER helper that wraps `cron.schedule` + `net.http_post` with mandatory timeout. Migrate every existing schedule to use it. New crons go through it by convention.

Helper signature:
```sql
CREATE OR REPLACE FUNCTION public._ct_schedule_post(
  job_name text,
  schedule text,
  fn_name text,
  body jsonb DEFAULT '{}'::jsonb,
  timeout_ms integer DEFAULT 60000
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = job_name) THEN
    PERFORM cron.unschedule(job_name);
  END IF;
  PERFORM cron.schedule(
    job_name,
    schedule,
    format($body$
      SELECT net.http_post(
        url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/%s',
        headers := jsonb_build_object(
          'Content-Type',  'application/json',
          'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
        ),
        body    := %L::jsonb,
        timeout_milliseconds := %s
      )
    $body$, fn_name, body::text, timeout_ms)
  );
END
$$;
```

Then a single sweep migration `20260430210000_cron_timeout_class_kill.sql` that calls `_ct_schedule_post(...)` for every existing cron, with sensible per-function timeout defaults (most: 60s; long Sonnet calls: 120s).

### Verification — how to confirm a cron is broken before fixing

Per cron, fire it once and capture both the cron's `last_run_duration` and the actual `net._http_response.status_code` via `_get_http_body(_request_id)`:
- If cron duration <500ms AND `_http_response.status_code` is null/error → BROKEN (timeout-killed)
- If cron duration <500ms AND status_code = 200 with empty/zero body → BROKEN (function didn't actually do work)
- If cron duration matches function duration AND status_code = 200 with real data → HEALTHY

Diagnostic snippet:
```bash
SR_KEY=$(npx supabase projects api-keys --project-ref rvhyotvklfowklzjahdd | grep service_role | awk '{print $NF}')
curl -s -X POST "$SUPA/rest/v1/rpc/get_cron_status" -H "Authorization: Bearer $SR_KEY" -H "apikey: $SR_KEY" -H "Content-Type: application/json" -d '{}' | python3 -c "
import sys,json,re
d=json.load(sys.stdin)
for r in d:
    cmd=r.get('command') or ''
    if 'net.http_post' in cmd and 'timeout_milliseconds' not in cmd:
        print(f\"AT-RISK: {r['jobname']}  schedule={r['schedule']}\")
"
```

That single query lists every at-risk cron in the system.

### Acceptance criteria

- [ ] One-shot diagnostic script that lists every `net.http_post` cron without explicit timeout (run before + after to verify)
- [ ] `_ct_schedule_post` helper migration deployed
- [ ] Sweep migration that re-creates every existing schedule via the helper, with appropriate timeouts
- [ ] Re-run diagnostic — zero at-risk crons returned
- [ ] Verify ct_flow_alerts, ct_breaking_news, ct_eod_reports, ct_daily_briefs all continued to ingest during the migration window
- [ ] Add a `ct-cron-health-check` rule that flags any future cron lacking `timeout_milliseconds` (so this can never silently regress)

### Estimated effort

- ~30 min to write the helper + diagnostic
- ~1-2h to write the sweep migration (audit + per-cron timeout decisions)
- ~15 min to push + verify
- **Total: ~2-3h, post-close tonight or Saturday morning**

### Tenet check

**Tenet 15** — does this class of failure become impossible going forward?

- Patching three flow-ingester crons today (commit `b22a3ff`): patches THIS instance.
- Sweep migration via `_ct_schedule_post` helper + cron-health-check rule: kills the CLASS. Every future cron must pass timeout, or the schedule helper rejects, or the health checker flags. Bug becomes structurally impossible.

This is the discipline test. Patch today, kill the class tonight or Saturday.

---

## Morning Brief Temporal Contamination — 2026-04-30 (CRITICAL, partial fix today)

### The bug

Today's morning brief (v1 at 11:01 UTC) was **internally self-contradicting**:
- Macro narrative claimed "MSFT/GOOGL/AMZN/META reporting **TODAY** post-close" AND "**YESTERDAY 20:20 ET** Microsoft beats Q3 estimates" — same earnings event, two dates.
- Claimed "Powell's final FOMC presser at 18:30 ET" today — but FOMC was 2026-04-29.
- `skip_today: [SPY, MSFT, AMZN, META]` based on a pre-FOMC framing that doesn't exist anymore.

Downstream effects (untriaged but real): detector pulse-context, EOD scorecard, specialist `current_reads` all read brief output. Garbage temporal frame poisons the day.

### Root cause

NOT the events table (clean — all 4/29 dates correct). NOT the news pre-tagging (correctly tagged YESTERDAY). The contamination came from one stale **open hypothesis** still status=open:

```
created=2026-04-29 11:01 UTC, updated=2026-04-30 06:00 UTC
claim: "AMZN reports earnings today (Apr 29) with insider sells..."
horizon: week, status: open
```

`buildClaudeContext` strips `created_at` from the hypothesis payload (line 473 of ct-daily-brief), so Sonnet has no way to know "today (Apr 29)" was written yesterday. Plus the system prompt says "Today is 2026-04-30." Sonnet pattern-completes the contradiction by generalizing "earnings cluster TODAY" across all 4 mega-caps.

The pre-tagging fix that exists for events + news was incomplete — it never extended to hypotheses, trade theses, or grade rationales.

### Done today (5-min neutralize, throwaway-safe)

- ✅ Stale AMZN hypothesis `0aff3d1e-f28c-4f68-a78b-9145fe62dd40` marked `status=refuted`, `invalidated_at=2026-04-30T11:30Z`, `invalidated_reason` documents the contamination.
- ✅ Re-fired ct-daily-brief via `trigger_ct_daily_brief('regime_shift', ...)` → produced **v2** at 2026-04-30T11:33 UTC.
- ✅ v2 macro_narrative correctly tags MSFT/GOOGL/AMZN/META as **YESTERDAY**. AAPL TODAY post-close is real (in ct_events). Core PCE 12:30 UTC TODAY is real.
- ⚠️ **One residual hallucination in v2**: "Powell's final Fed speech TODAY 18:30 ET" — there is NO Powell speech in `ct_events` for 2026-04-30. Sonnet invented it from yesterday's FOMC echo. Proof point that even with cleaner inputs, model coherence is the bottleneck — exactly the bug a validator pass would catch.

### NOT done today (deliberately deferred to Saturday)

- ❌ **Option D temporal-annotation patch** to ct-daily-brief — `[written YYYY-MM-DD]` prefix on hypothesis claims, trade theses, grade rationales. Skipped because the Saturday rebuild replaces it entirely. Patching now = wasted hour + wasted code review.
- ❌ **Auto-expire session-horizon hypotheses overnight** — partial fix; the rebuild handles this structurally.
- ❌ **Same temporal-contamination audit on EOD report, tape-reader, specialist `current_reads`** — same class of bug almost certainly exists in those generators. Saturday work, treated together.

### Saturday rebuild — full architectural fix

The decision-ritual answer per Tenet 13 + 15 ("does this class of failure become impossible?"):

**A) Deterministic fact pack** — new shared module `_shared/todayFacts.ts`:
```
{
  today_scheduled_events: [...],     // ct_events where event_date = sessionDate
  yesterday_completed_events: [...], // ct_events where event_date = sessionDate - 1
  yesterday_earnings_results: [...], // pre-extracted from ct_breaking_news headlines
  overnight_gaps: { ticker: gap_pct }, // pre-market by ticker
  key_level_breaks: [...],           // structural levels crossed overnight
}
```
Pre-computed, all dates absolute, model receives clean facts. Synthesis only — no temporal reasoning required.

**B) Validator pass** — new function `ct-brief-validator` (Haiku, ~$0.005/call):
- Scans brief output for TODAY/TOMORROW/YESTERDAY claims in macro_narrative + breaking_events + per_ticker.catalysts
- Verifies each against the fact pack
- Contradictions → return diff to caller; caller regenerates with explicit "your previous output had these contradictions: [...]" feedback
- Hard cap at 2 retries; on third failure, persist with `validator_warnings` field set + Slack alarm
- Exactly the bug v2 still has ("Powell speech TODAY") would be caught

**C) Model upgrade** — Opus 4.7 for `ct-daily-brief` + `ct-eod-report`:
- ~5x cost increase: $80/yr → $400/yr
- Strategic anchors of the day deserve the strongest reasoning
- Lower (not zero) coherence-failure rate; defense-in-depth with B

**D) Pattern propagation (Sunday)** — same fact-pack + validator pattern to:
- ~~`ct-eod-report`~~ (heatmap context wired 2026-04-30 afternoon — Saturday adds fact-pack + validator on top)
- `ct-tape-reader` (currently truncates, no temporal anchoring; ALSO needs heatmap context wire)
- 10 specialist `current_reads` via `_shared/specialistRunner.ts` (heatmap context wire ALSO pending)
- `ct-trade-idea-generator` (every 5 min RTH, big Claude consumer; heatmap context wire pending)
- `ct-watcher` (every 15 min; heatmap context wire pending)
- `ct-self-grader` (every 2h RTH; heatmap context wire pending)
- Any future "model writes narrative" surface

**F) ct-cron-health-check RTH-window awareness** — surfaced 2026-04-30 ~07:35 ET via Slack alert "7 crons degraded (stale 16h)". All 7 (`ct-curiosity`, `ct-detector-small-cap-inverted-put-rth`, `ct-detector-weekly-atm-voi-rth`, `ct-detector-zerodte-opening-call-rth`, `ct-detector-zerodte-put-voi-rth`, `ct-flow-pulse-capture`, `ct-trade-advisories`) are scheduled `* 13-20 * * 1-5` (weekday RTH only, 9 AM-4 PM ET). Last fire was Wed 4/29 ~20:00 UTC; alert fired pre-bell Thursday — by definition stale, by design correctly idle. Health checker measures time-since-last-fire without parsing the cron's hour-of-day window. Different bug class from the Tuesday step-interval false-alarm fix (`ba3938b`). Fix: parse cron schedule, compute next-expected-fire-time given hour-of-day + day-of-week restrictions, alarm only if now() > next_expected + grace. ~1h work. Tenet 3 violation — false alarms erode trust faster than missed signals.

**G) timeout_milliseconds class kill** — see top P0 section. Original G inline summary superseded by full writeup at top of document.

**E) Rebrief hygiene** — surfaced 2026-04-30 morning audit. Two bugs:
- **Version-numbering race**: today's 11:01:19 scheduled fire and 11:01:46 Tavily-triggered rebrief BOTH inserted as `brief_version=1` (the rebrief's `findPriorBriefToday()` ran before the scheduled brief had inserted). Wed 4/29 fired 4x; today fired 3x; site picks one row arbitrarily when versions collide. Fix: add `UNIQUE(session_date, brief_version)` constraint + retry-on-conflict in the insert path. OR move version assignment + insert into a single SECURITY DEFINER RPC that serializes via row lock. Migration + ~20 lines.
- **Rebrief threshold too aggressive on news-heavy days**: current logic fires a rebrief on every sev≥4 breaking news. Wed 4/29 = 4 briefs (FOMC + 4 mega-cap earnings firehose; 19:14 and 19:25 fires were 11 min apart). Each = Slack push + Sonnet call + DB row. Fix: add `ct_config.claude_brief_rebrief_min_gap_min` (default 60), suppress rebrief if last brief < gap unless `new_severity > prior_brief.urgency_level`. Optionally raise sev floor from 4 → 5 for the gap window.

Both belong inside the brief-generator rebuild — the code path is being touched anyway. Adds ~30 min to Saturday's budget.

### Build budget

| Day | Work | Est |
|---|---|---|
| Sat AM | `_shared/todayFacts.ts` module + tests against ct_events/ct_breaking_news | 2-3h |
| Sat AM | Migrate ct-daily-brief to consume fact pack; remove model-side temporal reasoning | 1-2h |
| Sat PM | `ct-brief-validator` function + RPC + integration into ct-daily-brief regen loop | 2-3h |
| Sat PM | Switch ct-daily-brief + ct-eod-report to Opus 4.7; cost tracking adjusted | 30min |
| Sat eve | Test fire on today's data (replay 2026-04-30 corpus) | 1h |
| Sun | Propagate to ct-eod-report, ct-tape-reader, specialists | 4-5h |
| Mon open | New architecture in production; locked anchor for the week | — |

### The real principle being tested

**Tenet 13 — hallucination is inevitable; structural prevention is the answer.** Today proved Sonnet can self-contradict in adjacent sentences. Better prompts won't fix that; taking the temporal frame out of the model's hands will. The fact pack + validator pattern applies to every "model writes narrative" surface — morning brief is just the first instance.

**Tenet 15 — does this class of failure become impossible going forward, or am I patching this instance?** Today's 5-min neutralize patches the instance (one stale AMZN hyp). Saturday's rebuild kills the class.

---

## UW Budget Audit — 2026-04-29 21:00 UTC (91.7% close)

Crossed `critical` tier (≥90%) at 16:56 ET. Slack alarm fired (one-shot per day per tier). Audit traced the budget across categorized callers:

| Category | Calls | % | Notes |
|---|---|---|---|
| contract-poller | 9,979 | 54% | Only tier-aware caller. Already throttled */3→*/4 mid-day. |
| flow-alerts (mcp) + net-prem-ticks + nope + greek-flow | ~3,600 | 19% | Live UI signal — **don't touch**. |
| sector-tide | 1,051 | 5.7% | **Cut to */15 tonight (commit `<TBD>`)** — saves ~688/day. |
| gex-radar (spot + greek exposures) | 789 | 4.3% | Frontend-driven. |
| mcp-handshake | 332 | 1.8% | Per-isolate handshake; already optimal within Supabase Edge constraints. |
| options-volume + historic-chains + options-chain + others | ~895 | 4.9% | |
| news-headlines | 223 | 1.2% | |

**Key findings:**
- Flow alerts essentially flat Tuesday → Wednesday (1,694 → 1,756, +3.7%). Earnings/FOMC heaviness showed up in **poller workload** (more new contracts → more polls), not flow ingest.
- Non-poller floor is ~7,200 calls/day = 36% of budget regardless of market activity. With sector-tide cut: floor drops to ~32.5%.
- Only **3 of 41** UW callers checked the budget guard pre-tonight. **Hygiene pass tonight tagged the other 38** so future audits attribute by `caller=` instead of guessing from endpoint paths.

### Shipped tonight (UW)
- ✅ **Sector-tide */5 → */15** — migration `20260429220000_sector_tide_cadence_cut.sql`. Saves 688 calls/day = 3.4% budget.
- ✅ **`setUwCaller()` / `setMcpCaller()` hygiene pass** — 38 functions tagged. Non-functional; makes future audits 1-query instead of detective work.

---

## Tavily Audit + Rebuild — 2026-04-29 ~22:00 UTC (96/4000 used)

Caught at 96 credits / 4000 monthly cap (~2.4% used in <1 day on the new key). Forecast at status quo: ~10,140 credits/month = 254% over budget. Tavily exposes no remaining-credits API, so the redesign tracks usage locally + tier-gates every caller.

### Architecture rebuilt tonight

**Foundation (migration `20260429230000_tavily_budget_tracking.sql`)**
- `ct_tavily_usage` table — per-call log, every Tavily fetch records caller + query + depth + status + ms + credits_charged
- `ct_tavily_usage_monthly` view — month-to-date counter (resets on calendar month rollover)
- `ct_tavily_budget_tier()` RPC — returns tier (`unrestricted`/`tightened`/`critical`/`exhausted`) + monthly_count + pct_used
- `ct_tavily_alarm_state` table — one-fire-per-month-per-tier Slack alarm tracking
- `ct_config` keys: `tavily_monthly_limit` (4000), tier thresholds (70/90/95), per-caller kill switches, `news_sweep_hot_ticker_lookback_min` (30)

**Shared client (`_shared/tavilyClient.ts`)**
- `searchTavily(opts)` and `searchTavilyRaw(opts)` — single source of truth for every Tavily call
- Auto-logs every call to `ct_tavily_usage` (basic=1 credit, advanced=2)
- Auto-checks budget tier — throws `TavilyBudgetError` at `exhausted` or kill-switched callers
- 60s-cached kill-switch lookup per isolate
- Replaces 3 separate hand-rolled fetch blocks (news-sweep, news-watcher, jac-web-search)

**News-sweep redesign (`*/10` → `*/30`, hot-ticker filter)**
- Cron migration `20260429230100_news_sweep_cadence_cut.sql`
- Pre-fetch query: `SELECT instrument FROM ct_flags WHERE created_at >= now() - 30min`
- Zero hot tickers → return early, zero Tavily calls
- Tier-aware caps: unrestricted=10, tightened=5, critical=2, exhausted=0
- Sweeps the RIGHT tickers (where flow is pointing) instead of all 10 every cycle

**Watcher redesign (5-slot macro rotation, weekend cut)**
- Cron migration `20260429230200_tavily_watcher_weekend_cut.sql` (weekend `0 */2` → `0 14,22`)
- Slots: `macro_us_markets`, `geopolitical`, `policy_fed_cpi`, `earnings_today` (NEW), `commodities_currencies` (NEW)
- Per-ticker rotation slots removed (news-sweep covers per-ticker on signal)
- Same per-fire cost (1 credit), more macro coverage

**jac-web-search**
- Migrated to shared client (gets budget tracking + tier gating for free)
- At `critical` tier returns 429 with user-friendly message instead of silent over-spend

**Frontend**
- New `TavilyUsageBadge` component, sibling to `UwUsageBadge` in TopNav
- Shows month-to-date credits + tier color (TVLY label, same green/yellow/orange/red shading)
- Reads `ct_tavily_usage_monthly` view, refetches every 60s

### Forecast under new architecture

| Caller | Credits/mo | Old |
|---|---|---|
| Macro watcher (5 slots) | ~478 | ~580 |
| News-sweep (hot-ticker, */30) | ~1,176 | 9,600 |
| jac-web-search | ~50 | ~50 |
| **Total** | **~1,704** | **~10,140** |

**Headroom**: 4000 - 1704 = 2,296 credits/month (57% of budget unused). Plenty of margin for spikes.

### Initial-state caveat

Tonight's already-spent 96 credits aren't in `ct_tavily_usage` (we started counting from this build forward). The badge will read 0 until the first new fire post-deploy. By next month rollover, our local count is fully self-consistent.

### Deferred (next week or later)

---

## EOD Report — 2026-04-29 ~23:30 UTC

Forward-looking close-to-open handoff shipped tonight. Structural twin of the morning brief; loop-closes by grading this morning's brief calls against actual outcomes. Journal (`ct-eod-summary`) untouched — report is purely additive.

### Architecture

- **`ct_eod_reports`** table — UNIQUE(session_date), 13 jsonb/text fields mirroring morning brief shape + new `morning_brief_scorecard`
- **`ct-eod-report`** edge function — fires `0 21 * * 1-5` (5 PM ET, 30 min after journal). Reads journal + this morning's brief + price/flow/specialist data. Computes verdicts DETERMINISTICALLY in code (not Sonnet), passes structured input to Sonnet via forced tool-use (`emit_eod_report`). UPSERTs row.
- **Verdict math** in code: long_lean/short_lean win at ±0.4%, neutral wins if |session| <0.4%, avoid wins on chop (range ≥1.5% AND |session| <0.8%). Thresholds tunable via `ct_config`.
- **Sonnet's role**: write commentary strings only. Function overwrites verdict / alpha_pct / scorecard_summary fields with pre-computed values to prevent hallucinated grades.
- **Slack push**: Block Kit, structurally distinct from journal Slack (forward-looking vs attribution). Both pushes coexist for now; evaluate after a week.
- **`/eod-report`** page — mirrors `/morning-brief` styling. Tilt cards, scorecard chips with verdict colors, carryover pills, overnight catalyst rows, tomorrow watchlist + skip lists, lessons + script.

### Test fire on today's data

Fired manually for session_date=2026-04-29 with skip_slack=true. Output:
- 10/10 per_ticker_close cards populated
- 10/10 scorecard verdicts (all `neutral` — correct since today's brief had every ticker as `avoid` and the day was calm <0.5% moves)
- 4 substantive carryover themes (Fed binary, Big Tech earnings paradox, specialist divergence, negative gamma regime)
- 6 overnight catalysts pulled from ct_events
- 3 tomorrow_watchlist entries with specific reasoning (AAPL high, AMZN high, QQQ medium)
- 2 skip_tomorrow entries
- 3 lessons_today (avoid strategy validated, specialist conviction divergence, oil-shock prediction confirmed)
- 30 breaking events (sev≥3) captured
- Script: 971 chars, narratable
- Cost: $0.127 per fire (~$2.65/month at 21 weekdays)

### Tomorrow's 5 PM ET cron fires clean

- Cron schedule live: `0 21 * * 1-5`
- Function deployed; tool-use mode tested working
- Slack push will fire (skip_slack defaults to false on scheduled invocations)

### Deferred — Phase 5: Morning brief consumes EOD report

`ct-daily-brief` should read yesterday's `ct_eod_reports` and feed `carryover_themes`, `tomorrow_watchlist`, `skip_tomorrow`, `lessons_today` into its prompt context. Closes the close-to-open loop. ~8 lines in ct-daily-brief; defer to Sunday weekend session.

### Other deferred

- Verdict-threshold calibration after a week of fires (current: lean ±0.4%, neutral_loss 0.8%, avoid_chop_range 1.5%)
- Decide whether to silence journal Slack push once report Slack proves itself (~1 week)
- /budget consolidation page (UW + Tavily + Claude all in one place; nav links already point at /budget)

---

## Tavily — Deferred

#### T-1. Day-of-month-adjusted pace alarm
Current alarm fires at 90% absolute pct. Smarter: fire if linear-projection close > 100% (e.g. 50% used by day 5 should alarm even though 50 < 90). Defer to v2 of budget guard.

#### T-2. Drift calibration vs Tavily dashboard
After 1 week of clean operation, check Tavily dashboard `credits_used` vs `ct_tavily_usage_monthly.monthly_count`. Adjust `credits_charged` semantics if drift > 5%.

#### T-3. /budget consolidation page
Both UW and Tavily badges link to `/budget`. Page doesn't exist yet — add later. Should show both metrics + per-caller breakdown + alarm history. ~1 hour build.

#### T-4. Trigger expansion for news-sweep
Today's hot-ticker selector keys off `ct_flags`. Could also include: IV rank spikes, gap detections, unusual flow rank. Each addition = better coverage of "hot" without burning budget on truly quiet tickers. Add only if hot-ticker selector misses signals in the next 2 weeks of operation.

#### T-5. MCP transport for Tavily
Tavily exposes search + extract via MCP. Same credit cost (verified). Only useful if/when we want native Anthropic MCP tooling. Defer.

#### T-6. Macro-rollup query mode
Replace 10 per-ticker queries with 1 multi-ticker query. 10x cost reduction but loses per-ticker scoping. The hot-ticker filter already gets us to ~5 tickers/sweep, so this is incremental gain. Revisit only if monthly forecast trends back over 80%.

---

### Deferred (this weekend or later)

#### B-1. Tier-aware non-poller ingesters (medium juice)
Pattern-match `ct-contract-poller`'s `uwBudgetTier()` design into:
- `ct-news-ingester`: at `tightened` cut to */30; at `critical` cut to */60. Saves ~70 calls.
- `ct-options-screener-ingester`: similar throttle.
- `ct-flow-ingester` per-ticker: skip lowest-priority tickers at `critical`. Risky — needs careful priority design, this IS the live signal.
- `ct-net-prem-cumulative` and pulse-tick: SAME risk class as flow-ingester.

Each needs a `TierFilter` design like contract-poller's `tierFilterFor()`. Don't copy-paste — every consumer has different "what can I drop" semantics.

#### B-2. `ct-price-backfill-nightly` budget guard (low juice, defensive)
Function spends ~10-20 calls per fire at 22:30 UTC. No guard today → at 99% it would burn through 100% with no awareness. Add `uwBudgetOk()` check before the per-ticker loop.

#### B-3. Frontend gex-radar tier-awareness (medium juice, UI-coupled)
`useGexRadar` refetches every 30s during market hours regardless of UW pressure. At `critical`, frontend should slow to 60s or 120s. Requires a tier exposure mechanism (e.g. publish current tier to a frontend-readable view) — not a 1-line fix.

#### B-4. MCP-to-REST migration audit (low juice, high churn)
332 daily handshake calls (1.8%) come from cold-starting MCP per cron-fire. Supabase Edge Functions can't cache cross-isolate, so the handshake is unavoidable as long as MCP is used. Migrating MCP-using callers back to REST endpoints (where there's no `initialize` overhead) would eliminate the 332/day. Likely not worth the churn. Audit only.

#### B-5. Acceptance threshold tuning
Current alarm at 90% (`uw_budget_critical_pct`) is correct. Treat 80% weekday-close as healthy target, 88-93% as expected on heavy days, ≥95% as escalation. After sector-tide cut, expected daily-close shifts from 91% → ~87.5% on a comparable heavy day.

---

## P0 — Calibration / signal quality

> **Punchlist staleness audits.** Items aging >3 days without explicit gating get a relevance audit. See `docs/runbooks/punchlist_staleness.md` for the pattern. Most-recent archive: `docs/decisions/2026-05-02-punchlist-staleness-archive.md` — removed P0 #0 (canonical re-poll, superseded by detector lifecycle), P0 #1 (DTE-bucketed grader, superseded by Specialist Scoreboard v2), P0 #2 (per-symbol track dedup, resolved by 2026-04-28 UNIQUE INDEX), P2 #10 (alarm-log gap, stale — needs archeology before any fix).

### 0. ~~Re-poll canonical week + diff signature corpus~~ — **ARCHIVED 2026-05-02 (SUPERSEDED)**

Superseded by detector lifecycle K=4 + `ct_detector_lifecycle_state` + continuous scoreboard (commit `9504dcb`). Detectors now earn status empirically over rolling windows; one-shot canonical-week tuning is redundant. Saved ~5–15K UW calls. See `docs/decisions/2026-05-02-punchlist-staleness-archive.md` Item 1 for full context and re-trigger conditions.

---

### 1. ~~DTE-bucketed win threshold (grader)~~ — **ARCHIVED 2026-05-02 (SUPERSEDED)**

Superseded by Specialist Scoreboard v2 (commits `4bc606a`, `65d8996`, `f36da46`, 2026-05-02 ~05:30 UTC). DTE-relative timing is now structural via `ct_specialist_grade_axes` + 4h/1d/3d underlying-axis windows + `blended_verdict`. Adding DTE buckets to v1's premium-only grader would be redundant. See `docs/decisions/2026-05-02-punchlist-staleness-archive.md` Item 2.

---

### 2. ~~Per-option-symbol track dedup (print-grader)~~ — **ARCHIVED 2026-05-02 (RESOLVED)**

Resolved by 2026-04-28 partial UNIQUE INDEX `ct_contract_tracks_option_symbol_working_uniq` — class is structurally impossible (Tenet 15). Saturday-night audit 2026-05-02 ~01:30 UTC sampled 3,000 of 3,465 WORKING tracks: zero duplicates. See `docs/decisions/2026-05-02-punchlist-staleness-archive.md` Item 3.

---

### ~~3. Per-alert score-race fix coverage audit~~ — CLOSED 2026-05-02 [class killed]

> Final audit: zero race-risk sites remaining across the codebase. The "10 score-writers" framing was a miscount — actual writer surface is **4 SQL paths in 1 migration** (`20260424000038_scorer_context_columns.sql`), all score-first guaranteed (atomic INSERT/UPSERT in single statement). The only race-vulnerable consumer (`ct-signature-watcher`) has triple-layer protection: cron preflight + edge-function preflight + per-alert inline recovery. Specialists fail-safe (race → missed-fire on next 6-min cron, never wrong flag). Detector portfolio doesn't read `ct_scored_flow.score` at all.
>
> Class kill commits: `f5f2c4e` (2026-04-27) + `e88cc79` (2026-04-28).
>
> See `docs/decisions/2026-05-02-p0-3-score-race-coverage-final-audit.md` for full per-site classification with file:line citations.

---

## P1 — Polish / UX

### 4. Yesterday's stale tracks at peak=0
**Symptom:** ~133 WORKING tracks have `last_tracked_at` from before today. Those still report peak_contract_pct=0 because the poller never came back. The grader's MAX-peak RPC handles this when there's a fresher track for the same symbol, but pure orphans (no fresher track) stay broken.

**Fix path:** One-shot RPC `ct_repoll_stale_tracks(p_min_age_hours)` that bypasses the cadence filter for any WORKING track older than N hours. Run it at session start each day.

---

### 5. Flow Butterfly mode 'bb' historical view ✅ SHIPPED 2026-04-28 evening (commit `7755a30`)
**Status:** Today's date-range fix only extended mode 'cp' (calls vs puts). The agent skipped 'bb' (cumulative bullish/bearish) because that mode is hardcoded off in the UI right now. If we ever turn it back on, historical view won't work for it.

**Fix path:** Apply same `p_until` parameter to `ct_flow_pulse_chart` RPC + thread through `useFlowPulseChart` hook. Already half-done.

**Resolution:** Hook signature now accepts `dateRange` symmetrically for both cp and bb modes. RPC `ct_flow_pulse_chart` does NOT accept `p_until` — that's an out-of-scope migration. The bb call site has the param threaded but commented with a TODO. Re-enable path: ALTER `ct_flow_pulse_chart` to accept 4th TIMESTAMPTZ param, uncomment one line in `useFlowPulse.ts`. Code-level symmetry achieved; bb stays hidden in UI.

---

### 6. Cluster detector firing duplicates ✅ SHIPPED 2026-04-28 evening (commit `e5c5f11`)
**Today's evidence:** MSFT 425C bullish 85 fired on three detectors simultaneously (signature_v1 + cluster_default + cluster_slow_stacker), all at the same minute, all pushed to Slack. James got 3 Slack messages for 1 actual signal.

**Fix path:** Slack pusher dedups by `(option_symbol, direction, minute)` and only pushes the highest-scoring of the cluster within a window.

**Resolution:** ct-slack-push-flag groups pending flags by `(option_symbol, direction, minute_bucket)`, sorts by score DESC + created_at ASC, pushes leader only. Non-leaders get `ct_slack_log` rows with `pushed=false, skip_reason='cluster_dedup_lower_score'` and `slacked_at` stamped to keep them out of next sweep. Composite key falls back to `(instrument, side, strike, expiry, direction, minute)` when option_symbol is null. Audit query: `SELECT * FROM ct_slack_log WHERE skip_reason = 'cluster_dedup_lower_score'` — accumulates as live clusters fire.

---

### 7. /flags page — sticky filter for "Today" should auto-include 7d for outcome tabs ✅ SHIPPED 2026-04-28 evening (commit `3e592ff`)
**Symptom:** Today's flags don't have grades yet (horizons haven't expired). Won/Lost/Neutral tabs return zero on Today filter. Confusing UX.

**Fix path:** When user clicks Won/Lost/Neutral while on "Today", auto-bump date filter to 7d AND show a small "(showing past 7 days for graded outcomes)" hint.

**Resolution:** Auto-bump fires on Won/Lost/Neutral click when date is Today. Hint renders next to date pills, clears on any manual date change. Active and All outcomes do NOT trigger auto-bump (control case). Verified live in browser end-to-end.

---

## P2 — Backlog / not blocking

### 8. Specialist bullish-bias rewrite verification
v2 prompts shipped this morning have hard-gated bias audit + 3:3:1 few-shot. Direction balance went 89/11 → 67/32 — measurable improvement but specialists haven't fired today (no specialist alarm in 12 hours). Need to wait for them to fire to verify v2 is producing balanced flags.

### 9. Bear-side signature class corpus growth
After the directionInference fix, corpus has 37 `aggressive_ask_put` (bearish) classes, all with hit_rate 0-4% historically because the recent regime has been bullish. As bearish moves materialize, those classes will accumulate winners and signature_v1 will start firing bearish.

### 10. ~~Ct_signature_alarm_log → ct_flags 1:1 audit~~ — **ARCHIVED 2026-05-02 (STALE — needs archeology)**

2026-04-28 diagnostic claimed 733 flags vs 610 alarm-log entries (gap = "missing alarm logs"). 2026-05-02 audit re-ran the count: **1,151 alarms vs 1,399 flags — gap is in the *opposite* direction**. At least three possible gap shapes (1 alarm → many flags / alarms missing flag-write / non-alarm-path writers tagging signature_alarm); current diagnostic doesn't distinguish between them. Fixing without knowing the shape would be guessing. See `docs/decisions/2026-05-02-punchlist-staleness-archive.md` Item 4. Re-trigger: re-run counts, identify gap shape via alarm-to-flag join, *then* fix specific path. Tag `[needs-archeology]` if it returns.

### 11b. ct_compute_gamma_flip last-resort fallback picks bad strikes ✅ SHIPPED 2026-04-28 evening (commit `d0973cc`)
**Symptom:** Sometimes returns far-OTM strike (NVDA showed 1.5 with spot 213, QQQ 451 with spot 658). Happens when sign-change scan finds no crossing in the meaningful-strikes window, or when spot is null (QQQ). The function falls back to "smallest |net_gex| across all strikes" which on sparse gex chains picks a thin OTM tail.

**Cause:** Two separate issues:
1. Sign-change scan filters strikes via `meaningful` CTE (drops strikes with no call_gex + put_gex activity). On thin chains, the meaningful set may be all-positive or all-negative — no crossing exists.
2. Final fallback `LIMIT 1` on `ORDER BY abs(net_gex) ASC` picks the global minimum, which is often a near-zero far-OTM strike.

**Fix path:** Tighten the fallback to "min |net_gex| WITHIN 10% of spot" (already exists as middle fallback). Drop the global-min last-resort entirely — return NULL if no flip detected near spot. Better to show "—" in the UI than 1.5.

**Resolution:** Migration `20260428223000_gamma_flip_drop_global_min_fallback.sql` removed the global-min last-resort. Function now returns NULL when no near-spot crossing exists. Verified across all 10 watchlist tickers post-fix — every gamma_flip within 5% of spot. The 1.5 / 451 fabrication class is structurally impossible going forward.

---

### 11a. QQQ underlying_price null in ct_gex_timeseries ❌ FALSE PREMISE — investigation found different cause
**Symptom:** QQQ snapshot shows spot=null, gamma_flip falls back to last-resort logic (451 vs spot ~658). All other 9 watchlist tickers have spot populated correctly.

**Cause:** Whichever ingester populates `ct_gex_timeseries.underlying_price` is failing for QQQ specifically. UW returns the data; something downstream isn't setting the column.

**Fix:** Find the ingester (`ct-gex-ingester` or similar), check if it explicitly handles QQQ vs index ETFs differently, fix the column write. One-off ingester fix, ≤30 min.

**2026-04-28 evening investigation:** Database shows QQQ has 286,149 rows with `underlying_price` populated and only 4,296 null (FEWER nulls than SPY's 5,806). Today's QQQ snapshots all have `underlying_price=658.0105` correctly. **The bug premise was wrong.** The bad gamma_flip 451 / NVDA 1.5 symptoms were the gamma_flip global-min fallback (item 11b) picking far-OTM strikes from the adjusted-options chain, NOT a null-spot bug. With 11b shipped, the symptom is gone. Closing this item — no fix needed.

---

### 11. Pulse zero-rate residual
40-50% of `ct_flow_pulse_ticks` rows still have all-zero counts. Pre-fix-cron rows account for most. Don't backfill; let the new schedule's healthy rows crowd them out over a few sessions.

### 12. MaxPerRun bump beyond 100
The poller's at 100 now (was 60). UW budget allows higher. Could bump to 120-150 if 1-sweep % stays above 10% for too long. Watch metric: 1-sweep % over 7d should trend toward 5%.

---

## New items surfaced 2026-04-28 evening

### N0. Unified grading vision — /flags + /tape + drill sheet should tell ONE story  📅 WEEKEND DISCUSSION

**Problem James caught 2026-04-28 night:** /tape HORIZONS column shows "won 4h" / "loss 2h" tags on individual flow alerts (sourced from `ct_print_grades` / `ct_print_tracks` — print-grader Pass 1 + Pass 2). Meanwhile /flags Won/Lost tabs were empty because `ct_flag_grades` is a separate table with different criteria (target_price hit by horizon expiry, gated on score ≥ 70 fire-time). Two grading systems, two visual presentations, no connection. User sees winners on /tape but nothing on /flags and asks "does that make sense?"

**Tonight's quick-fix (commit shipped 2026-04-28 night, ship-Option-C):** /flags Won/Lost/Neutral now uses `ct_flag_grades!inner` + DB-level outcome filter + bypasses fire-time score floor when on outcome filter. So at least /flags surfaces its OWN graded wins/losses honestly. But the bigger question stays open.

**Weekend question to discuss:**
- Should /flags ALSO show print-level outcomes for the contract? E.g., MSFT 425C flag fires at score 70 → flag_grade looks at MSFT spot at horizon → win/loss verdict. But the SAME contract's prints get graded by print-grader against the contract's own price move. Both views are valid. Should the drill sheet show BOTH? "Flag-level: WIN (alpha +1.4%) | Print-level: WIN (contract paid +47% in 2h)"
- Or unify: drop ct_flag_grades entirely and have /flags read its outcome from ct_print_tracks for the contract? Means the flag inherits the contract's lifetime outcome, regardless of fire-time horizon.
- Or hybrid: flag-grader still runs but UI surfaces both verdicts side-by-side, makes the difference legible.

**What this would change on the site:**
- Drill sheet shows two verdicts (alpha-axis + contract-axis) — answers different questions
- /flags Won/Lost would have tighter signal (a flag with both verdicts matching is high-confidence)
- Detector calibration becomes richer — train against contract-level outcomes (where money was made), not just alpha-vs-spy

**What it would change architecturally:**
- ct_flag_grades + ct_print_grades + ct_contract_tracks all touch the same conceptual question: "did the signal pay?"
- Today they answer different versions of that question silently
- Worth a calibration philosophy chat on Saturday before any code touches

**Why this is on the punch list (not Sunday-default):** Sunday calibration sprint is detector-threshold tuning. This is one layer up — what the system MEANS by "win." Belongs in a Saturday architectural discussion before the Sunday tuning runs.

---

### N1. EOD generator left `regime_tag` + `snapshot_hit_rate` null ✅ SHIPPED (commit `920071e`)
EOD Slack message went out Mon + Tue saying "regime untagged · n/a hit rate" because generator never wrote to those columns despite them existing on `ct_eod_summaries`. Fixed: regime_tag derived from market_premium delta, snapshot_hit_rate computed from grade breakdown. Verified live.

### N2. ct-cron-health-check step-interval false alarm ✅ SHIPPED (commit `ba3938b`)
Health monitor was paging Slack hourly all night for `ct-self-grader` (schedule `0 13-20/2 * * 1-5` — RTH-only by design, fires 13/15/17/19 UTC then quiet). Schedule parser handled continuous ranges but treated step intervals as "active until 20:00 UTC", missing that the LAST scheduled hour was 19:00. Fixed: step intervals expanded to last-actual-fire-hour. Two consecutive post-fix ticks (23:00, 23:10 UTC) silent on ct-self-grader.

### N3. QQQ adjusted-strike series in ct_gex_timeseries — NOT a bug
Diagnostic ran 2026-04-28 evening: QQQ today has 438 strikes in latest snapshot, 88 of which end in `.78` (e.g., 174.78, 179.78, 184.78). These are **legitimate adjusted-strike option series** (post-corporate-action chains). They have small but non-zero OI/gex. Pre-fix, gamma_flip global-min fallback picked them on sparse chains. Post-fix (item 11b), gamma_flip returns NULL on sparse cases. The downstream symptom is resolved. **Open question for future tuning:** should adjusted-strike chains be filtered from gex calculation, or kept for completeness? Not blocking — file as P3.

---

## Already shipped today (reference)

1. Off-RTH ingester killed (UW budget)
2. ct-detector-scorer + cron */5 13-20
3. Specialist v2 prompts (hard-gated bias audit, 3:3:1 few-shot)
4. Pulse capture race fix (LEFT JOIN + cron resequencing)
5. Signature watcher score-race v1 (cron-level inline)
6. /flags page source filter (specialist + signature_alarm + detector_alarm)
7. directionInference RepeatedHits put → ask-aggressive (root cause of bullish bias)
8. Detector functions write target_price + invalidation_price
9. Grader uses MAX(peak) per option_symbol via new RPC
10. Poller throughput */5 → */3, maxPerRun 60 → 100
11. /flags spot lookup falls back to instrument when specialist_ticker null
12. /flags axis-aware progress chip (contract vs underlying spot)
13. Signature watcher score-race v2 (per-alert inline recovery)
14. Signature watcher score-race v3 (executed_at→ingested_at fallback)
15. Flow Butterfly historical date-range view (cp mode)

## Evening polish session shipped (2026-04-28 ~21:00–23:30 UTC)

16. EOD generator populates regime_tag + snapshot_hit_rate (commit `920071e`)
17. ct-cron-health-check step-interval suppression (commit `ba3938b`)
18. ct-slack-push-flag cluster dedup (commit `e5c5f11`)
19. ct_compute_gamma_flip drop global-min fallback (commit `d0973cc`)
20. /flags Won/Lost/Neutral auto-bump to 7d (commit `3e592ff`)
21. FlowPulse symmetric p_until threading for bb mode (commit `7755a30`)

---

## Notes on calibration philosophy

The morning's 10 structural fixes weren't pre-planned — each surfaced when live data exposed a bug that was invisible in test data. The pattern: ship, watch, see what breaks, fix, repeat.

For tomorrow: same loop. Don't wait for a "calibration sprint" — fix what we see when we see it.

---

## Wednesday 2026-04-29 — added during open watch

### Frontend — bell-ring refetch invalidation (caught 9:35 ET)
- Hooks with `refetchInterval: () => (isMarketHoursET() ? N : false)` freeze if the page is loaded pre-bell. React Query doesn't re-evaluate the interval at the 9:30 ET transition.
- Confirmed broken: `useNetPremiumCumulative` (Flow Butterfly).
- Suspected same pattern: `useFlowPulse`, `useMacroSparklines`, possibly other market-hours-gated hooks.
- Fix (Saturday): one `useMarketHoursTrigger` at app root that polls every 30s and calls `queryClient.invalidateQueries({ predicate: q => q.queryKey[0]?.toString().startsWith('ct_') })` on the bell transition.
- Workaround until then: hard refresh post-bell.
- See `~/.claude/projects/-Users-jameschellis/memory/feedback_market_hours_refetch_invalidation.md`.

### Cron health — staggered-minute schedule false alarm (caught 9:00 ET)
- 7 RTH-only crons fired stale alerts at 13:00 UTC because their first scheduled fire of the day is NOT at minute 0 (e.g., `1,6,11,...`). Tuesday's `ba3938b` step-interval fix doesn't catch staggered-minute schedules.
- Affected: ct-curiosity, ct-detector-{small-cap-inverted-put,weekly-atm-voi,zerodte-opening-call,zerodte-put-voi}-rth, ct-flow-pulse-capture, ct-trade-advisories.
- Auto-resolved at 13:20 UTC once first fires landed. Same false-alarm class as Tuesday's ct-self-grader.
- Fix (Saturday): extend `ct-cron-health-check` schedule parser to compute `nextFireAfter(now)` for staggered-minute lists (1,6,11,16,...) — alert only when `now > nextFireAfter + threshold`.

### 13:30 UTC ingester silent fire (one-off, may not recur)
- ct-flow-ingester-perticker-rth's 13:30 UTC fire at the open did NOT write any rows. 13:35 UTC fire was healthy.
- Could be: pg_cron skipped, UW returned empty at the open second, or function timed out before write.
- Single-day occurrence. If it happens again Thursday's open, escalate to root-cause investigation.

### VIX consumer cleanups (caught during VIX precision fix 2026-04-29)

- **`supabase/functions/ct-custom-rule-eval/index.ts:226`** selects `'date, close'` from `ct_vix_history` but the column is `level`. Returns NULL VIX in custom rule evaluation. One-line fix.
- **`build_ticker_quant_card` RPC** (4 migrations) — uses `WHERE date <= v_today ORDER BY date DESC LIMIT 1` for VIX. With intraday rows now stored, ties on `date` resolve to an arbitrary row. Should be `ORDER BY date DESC, created_at DESC`. Risk of touching 565-line RPC for one tweak — defer until next quant-card change.

### ContractDrillSheet — print_count indicator not rendering (caught live 2026-04-29 ~14:00 ET)

- DB has clean dedup: AMZN260605C00265000 has 1 ct_contract_tracks row with print_count=21 + 21 ct_contract_track_alerts ledger rows.
- /tape Stacking Patterns table column correctly shows "21 prints".
- `ContractDrillSheet.tsx:180-182` JSX renders `{track.print_count} prints · last {timestamp}` in amber when `track.print_count > 1`.
- **The amber indicator is NOT rendering** when drill sheet opened from Stacking Patterns row click. Page-text search confirmed absent.
- Likely cause: drill sheet `track` prop is undefined / loaded from wrong shape / stale React Query, so `track.print_count > 1` guard fails.
- Fix priority: medium. The actual dedup is structurally working — this is a UX-only gap that prevents James from visually confirming dedup at a glance.
