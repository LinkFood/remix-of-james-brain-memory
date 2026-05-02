# 2026-05-02 — ct-historical-quote-backfill — Investigation

**Decision class:** Investigation / UW spend audit (Track 2 follow-up to LB8)
**Type:** Read-only re-verification. Zero UW calls, zero migrations, zero deploys.
**Verdict:** **A — Expected behavior. No code/schedule change. The 16.3% framing was an LB8 sampling + ET-vs-UTC bucketing artifact, not a real mid-week leak.**
**Supersedes (in part):** `docs/decisions/2026-05-02-historical-quote-backfill-audit.md` — Saturday's audit identified the boundary-slice bucketing artifact; this Track 2 file re-verifies independently against current `ct_uw_usage` and quantifies how off the 16.3% number actually was.

## Context

LB8 ([uw-budget-rebaseline.md](./2026-05-02-uw-budget-rebaseline.md)) sampled the last 1,000 rows of `ct_uw_usage` filtered by `session_date=2026-05-01` and computed each caller's share. `ct-historical-quote-backfill` registered 16.3% — surprising for a function whose own header says "weekend-only." LB8 flagged it as an "active leak," estimated −2,100 calls/day savings if mid-week firing was eliminated, and recommended a Saturday investigation.

A Saturday audit ([historical-quote-backfill-audit.md](./2026-05-02-historical-quote-backfill-audit.md)) inspected the function + cron and concluded the apparent mid-week activity was a UTC↔ET boundary-bucketing artifact: the cron is genuinely weekend-only, and the rows tagged `session_date=2026-05-01` had `observed_at` in the 00:00–01:01 UTC Saturday slice (= 20:00–21:01 ET Friday by the column definition). Track 2's job: re-verify that conclusion independently against current data, and quantify the actual % share rather than trusting either prior framing.

## Phase A — Function behavior

**File:** `supabase/functions/ct-historical-quote-backfill/index.ts` (487 lines)

What it backfills (`index.ts:35-90`, `:201-221`, `:374-473`):
- Walks `ct_contract_tracks` from the last 7d (watchlist-filtered, ASC by `print_time` so Mon-Wed holes get filled before re-scanning newer days — deliberate exception to `feedback_create_query_sort_desc`, documented at `:186-191`).
- Per track, computes 4 horizon timestamps (30m / 2h / eod / +1d). 
- Pre-filters: one paginated read of `ct_contract_quotes` over an 8-day window finds symbols that have ANY quote — drops ~20k sequential per-horizon DB lookups to 1 paginated lookup (`:302-318`).
- For symbols with quotes, per-horizon ±6h slop check via `count:'estimated', head:true` (`:205-221`). For zero-quote symbols, every valid horizon goes straight to the needs list.
- Calls UW endpoint `/api/option-contract/<SYMBOL>/historic` with `limit: 30` daily bars at concurrency 2 (`:386, :406`).
- Synthesizes mid from `nbbo_bid + nbbo_ask` / 2 (fallback `avg_price` then `last_price`) and upserts into `ct_contract_quotes` with `source='uw_historic_backfill'` via the unique-index-backed onConflict path (`:445-466`).
- Cap: 200 unique option_symbols per run (`:45`, `:294`).

UW math per fire:
- `1 UW call per unique option_symbol` × ≤200 symbols = **≤200 UW calls per fire**.
- Concurrency 2 against UW (`:48`, leaves headroom under UW's 3-concurrent cap).
- Idempotency: subsequent fires skip already-filled horizons via the ±6h slop check or the bulk pre-filter, so steady-state cost decays as the 7d window converges.

What it skips:
- **Weekday gate at `:262-271`:** UTC day 1-5 (Mon-Fri) returns early with `weekday_gated: true`. Override only via `body {force: true}`. Belt + suspenders against cron misconfig.
- Already-filled horizons (±6h slop check).
- Symbols with `result.rows.length === 0` from `/historic` (`:387-389`).

UW endpoints called: exactly one — `/api/option-contract/<SYMBOL>/historic`. 100% of the function's UW spend.

**Cron schedule:** `supabase/migrations/20260427000030_historic_backfill_cron.sql:43-47`:

```
'*/30 * * * 0,6'   -- every 30 min, Sun(0) and Sat(6) UTC only
```

Belt + suspenders: cron is weekend-day-of-week-restricted AND the function's `getUTCDay()` gate at `index.ts:262-271` fires on weekdays. Either failure mode (cron misconfig OR manual cron addition with weekday window) is still gated.

System map entry: `docs/system-map/edge-functions.md:75` — already documents `cron */30 * * * 0,6`, weekend-only, status LIVE.

## Phase B — Actual measurements (re-verified 2026-05-02 ~12:35 UTC)

### Per-day max `daily_count` for `ct-historical-quote-backfill` (last 8 sessions)

| `session_date` | DoW | max `daily_count` |
|---|---|---|
| 2026-04-25 | Sat | 2,884 |
| 2026-04-26 | Sun | 6,464 |
| 2026-04-27 | Mon | **0** |
| 2026-04-28 | Tue | **0** |
| 2026-04-29 | Wed | **0** |
| 2026-04-30 | Thu | **0** |
| 2026-05-01 | Fri | 564 |
| 2026-05-02 | Sat | 1,572 (in-progress at sample time) |

Direct confirmation: `caller=eq.ct-historical-quote-backfill&observed_at=gte.2026-04-27&observed_at=lt.2026-05-01` returned **0 rows**. The function did not record a single UW call across the entire mid-week (Mon-Thu) window.

### The 564-call "spillover" on session_date=2026-05-01

All 564 calls attributed to Friday's ET trading session have `observed_at` between `2026-05-02T00:00:59 UTC` and `2026-05-02T01:01 UTC` — i.e., 20:00–21:01 ET Friday evening. That falls inside the Saturday-UTC cron window (cron expression `*/30 * * * 0,6`), and inside Friday's ET trading session because `session_date` is computed as `(now() AT TIME ZONE 'America/New_York')::date` per `supabase/migrations/20260418000002_uw_usage.sql:10`. This is the boundary slice the Saturday audit identified.

### LB8's 16.3% number, re-derived against the full population

LB8 sampled the last 1,000 rows of `session_date=2026-05-01` ordered by `observed_at` desc. That sample is biased toward the **late** evening (because of the 1,000-row PostgREST cap) — the exact slice where `ct-historical-quote-backfill` is over-represented because the boundary spillover lives there. Of LB8's 1,000-row sample, 163 rows belonged to backfill = 16.3% of that sample.

Full-day share (re-derived):

- Friday 2026-05-01 total UW spend: **13,071 calls** (per LB8's own daily total).
- `ct-historical-quote-backfill` Friday-ET-session spend: **564 calls** (max `daily_count`).
- True share: **564 / 13,071 = 4.31% of Friday's full-day spend**, **2.82% of the 20k UW daily cap**.

The 16.3% headline is roughly **3.8x the actual day-share**, and 100% of even that 4.31% is the Saturday-UTC weekend backfill firing during the Friday-ET → Saturday-UTC boundary. Real mid-week (Mon-Thu) share: **0%**.

### Mid-week top callers — `ct-historical-quote-backfill` does not appear

Top callers by max `daily_count` per session_date (Mon-Thu of the same week):

| session_date | top non-null callers (sample of top 5) |
|---|---|
| 2026-04-27 (Mon) | (legacy `null` caller at 20k from pre-tagging history) |
| 2026-04-28 (Tue) | ct-contract-poller 17,110 |
| 2026-04-29 (Wed) | ct-vix-capture 18,593, ct-watcher 18,589, ct-contract-poller 18,341 |
| 2026-04-30 (Thu) | ct-watcher 19,967, ct-spy-capture 19,915, ct-technicals-ingester 19,914, ct-price-tick-capture 19,746, ct-vix-capture 19,612 |

`ct-historical-quote-backfill` does not register in the top 10 for any mid-week session — consistent with the 0-row direct query.

### Top-5 callers, Friday 2026-05-01 (full-population by max-daily-count, full 1000-row scan)

| Caller | max daily_count | % of Fri sum-of-max |
|---|---|---|
| ct-flow-ingester | 13,071 | 9.4% |
| ct-news-ingester | 13,030 | 9.3% |
| ct-vix-capture | 12,884 | 9.2% |
| ct-analyst-ingester | 12,875 | 9.2% |
| ct-watcher | 12,830 | 9.2% |
| (… ct-historical-quote-backfill is NOT in the top 10 …) | | |
| ct-historical-quote-backfill | 564 | 0.4% of sum-of-max |

(`% of sum-of-max` is a different denominator from `% of daily total spend` — the former sums each caller's peak. Either way, backfill is not material on a weekday.)

## Phase C — Diagnosis

**Classification: A — Expected behavior. The 16.3% finding was a sampling + bucketing artifact, not real mid-week firing.**

Evidence:

1. **Code is gated correctly.** `index.ts:262-271` returns early on UTC weekdays. Override requires explicit `body {force: true}`; no caller in the codebase passes that flag, and no logged stat shows `forced: true`.
2. **Cron is gated correctly.** Migration `20260427000030_historic_backfill_cron.sql:43-47` schedules only Sat (6) and Sun (0) UTC. No competing schedule exists for this function name.
3. **Data is gated correctly.** Direct query `caller=eq.ct-historical-quote-backfill&observed_at=gte.2026-04-27&observed_at=lt.2026-05-01` returned 0 rows. No mid-week UW call was made.
4. **The 564 Friday-ET-session calls are 100% boundary spillover.** Every one had `observed_at` between 00:00:59 and 01:01 UTC Saturday — i.e., 20:00–21:01 ET Friday — which is the exact UTC↔ET boundary the column tags as Friday's ET session.
5. **No 5xx, no 429s, no retry storm.** Per the Saturday audit, 100% status=200, median 60ms — clean batch caller.
6. **LB8's 16.3% was a 1,000-row sample, not the population.** Full-day re-derivation: 4.31%. Mid-week re-derivation: 0%.

Not B (excessive cadence): cadence is already weekend-only.
Not C (bug): no over-firing, no idempotency miss, no re-fetch loop. Idempotency confirmed by the unique index + ±6h slop check + zero-quote bulk pre-filter — re-runs cost nothing on already-filled horizons.

## Recommended action

**Document this conclusion and close. No code change, no schedule change, no migration.**

The Saturday audit already wrote the right verdict. This Track 2 verification independently confirms it and adds the population-level math (4.31% actual day-share vs LB8's 16.3% sample-share) so the next audit doesn't repeat the same trap.

Optional polish (low-priority, defer or batch with the next caller-share audit):

1. **Update LB8 doc** ([uw-budget-rebaseline.md:33](./2026-05-02-uw-budget-rebaseline.md#L33), :48, :60, :86) — strike-through or annotate the 16.3% / "active leak" / "−2,100 calls/day savings" framing with a pointer to this investigation. Effort: 5 minutes.
2. **Add an invariant** to `ct_invariants` that flags `caller=ct-historical-quote-backfill` rows with `EXTRACT(DOW FROM observed_at AT TIME ZONE 'UTC') BETWEEN 1 AND 5` (current count: 0). Catches a real future leak without ET/UTC confusion. Severity `warn`. Effort: 10 minutes.
3. **Convention note for caller-share audits** — `session_date` is ET-bucketed; samples crossing UTC midnight will appear to attribute weekend-UTC fires to the prior ET session. Either always specify which time basis the audit uses, or audit by `EXTRACT(DOW FROM observed_at AT TIME ZONE 'UTC')` for caller-cadence questions. The same trap caught the 2026-04-30 budget-views bug (commit `67c4a19`); now caught a second time in the LB8 framing. Worth a one-paragraph entry in the runbook navigator (`docs/SYSTEM_INDEX.md`) calling out the convention so the third occurrence is structurally impossible.

**None of these need captain approval.** They're documentation hygiene. James can pick them up Saturday after the larger UW work, or skip — the operational risk is zero either way.

## Methodology lesson

**The 16.3% headline was wrong by ~3.8x because of two compounding effects:**

1. **Sample-vs-population.** LB8 used the last 1,000 rows ordered by `observed_at` desc — biased toward the late-evening slice. PostgREST 1,000-row cap (`feedback_postgrest_1000_row_cap`) makes this trap easy to fall into.
2. **ET-vs-UTC bucketing.** The biased late-evening slice happens to be the exact 4-hour UTC↔ET boundary slice where Saturday-UTC weekend cron fires get tagged with Friday's ET trading session. So the slice that's already over-sampled also happens to be where this caller's only on-disk activity for the week lives.

These two effects multiply. A weekend-only caller's tiny boundary-slice activity got amplified to 16.3% in a sample biased toward exactly the boundary slice. **The fix is methodological, not architectural** — for any future caller-share audit, choose between:

- **Population query:** sum or max by caller across the full session, no row-cap. Cost: a few seconds per session.
- **UTC-clock-day query:** group by `observed_at::date` (UTC) instead of `session_date` (ET). Eliminates the boundary-slice ambiguity for weekend-only callers.
- **Bias-aware sampling:** if you must sample, sample uniformly across the day (not "last N rows"), and report it as a sample-share with confidence interval, never as the full-day share.

The 2026-04-30 budget-views ET-bucketing fix (commit `67c4a19`) addressed the badge UX. This 2026-05-02 LB8 finding is the same class showing up in audit methodology rather than UI. **Class lesson:** ET-vs-UTC time-basis is ambient context that has to be specified at every query touching `ct_uw_usage`. Anywhere the column meaning ("ET trading session" vs "UTC clock day") isn't load-bearing on the answer, choose UTC clock day for caller-cadence questions and ET session_date for budget-vs-cap questions — and never silently mix.

## Related

- `docs/decisions/2026-05-02-historical-quote-backfill-audit.md` — Saturday audit (first write-up of the boundary-slice diagnosis).
- `docs/decisions/2026-05-02-uw-budget-rebaseline.md` — LB8 audit (origin of the 16.3% framing; lines 33, 48, 60, 86 reference the supposed leak).
- `supabase/functions/ct-historical-quote-backfill/index.ts` — the function itself.
- `supabase/migrations/20260427000030_historic_backfill_cron.sql` — the cron schedule.
- `supabase/migrations/20260418000002_uw_usage.sql:10` — `session_date` column definition (`(now() AT TIME ZONE 'America/New_York')::date`).
- `docs/system-map/edge-functions.md:75` — system-map entry, already accurate.
- 2026-04-30 commit `67c4a19` — prior ET-vs-UTC bucketing fix (budget views).
