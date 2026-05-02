# 2026-05-02 — ct-historical-quote-backfill leak audit

**Discovery:** LB8 audit ([uw-budget-rebaseline](./2026-05-02-uw-budget-rebaseline.md)) found this caller at 16.3% of mid-week UW share (~2,100 calls/day weekday).
**Audit type:** Read-only diagnosis. James decides Sat whether to fix or let it ride.
**UW budget impact tonight:** zero.

## Verdict (TL;DR)

**No leak. No fix needed.** The function fired exactly when designed to (Sat/Sun UTC, weekend gate enforced in code AND in cron). The LB8 sample window crossed the UTC midnight boundary, and the `session_date` column buckets by **Eastern Time**, not UTC — so Saturday-UTC fires got attributed to Friday's ET trading session, creating the appearance of mid-week activity in the LB8 caller-share table.

## Cron schedule (current)

[`supabase/migrations/20260427000030_historic_backfill_cron.sql:45`](../../supabase/migrations/20260427000030_historic_backfill_cron.sql#L45):

```
'*/30 * * * 0,6'   -- every 30 min, Sun(0) and Sat(6) UTC only
```

**Belt + suspenders matches the migration comment:** the function ALSO checks `getUTCDay()` and returns early on Mon-Fri ([index.ts:263](../../supabase/functions/ct-historical-quote-backfill/index.ts#L263)). Body `{force: true}` overrides; nothing in the data shows a forced run.

Schedule is weekend-only as the LB8 plan intended. Last touched 2026-04-27 (commit `07be201`); no recent change.

## What the function does

Walks `ct_contract_tracks` from the last 7d (watchlist-filtered, ASC by print_time so Mon-Wed holes get filled first), computes 4 horizon timestamps per track (30m / 2h / eod / +1d), pre-filters symbols that already have ANY quote in the 8-day window via one paginated read, then for the rest does per-horizon ±6h slop checks. For symbols still needing fills, calls UW `/api/option-contract/<SYMBOL>/historic` (daily OHLC, limit 30) at concurrency 2, synthesizes mid from nbbo bid/ask, and upserts into `ct_contract_quotes` with `source='uw_historic_backfill'`. Cap: 200 unique symbols/run. Idempotent via UNIQUE(option_symbol, ts). Pass 3 grader then fills the /tape Horizons column.

## Activity timeline (last 8 days)

Two independent breakdowns reveal where LB8's apparent mid-week share came from:

**By UTC clock day** (when the cron actually fires):

| UTC date | DoW | calls |
|---|---|---|
| 2026-04-25 | Sat | 780 |
| 2026-04-26 | Sun | 3,579 |
| 2026-04-27 | Mon | 0 |
| 2026-04-28 | Tue | 0 |
| 2026-04-29 | Wed | 0 |
| 2026-04-30 | Thu | 0 |
| 2026-05-01 | Fri | 0 |
| 2026-05-02 | Sat | 206 (so-far at 01:01 UTC) |

**By `session_date` (Eastern-Time bucketing — what LB8's `session_date=eq.2026-05-01` filter saw):**

| ET session_date | DoW | calls |
|---|---|---|
| 2026-04-25 | Sat | 1,317 |
| 2026-04-26 | Sun | 3,042 |
| 2026-04-27 | Mon | 0 |
| 2026-04-28 | Tue | 0 |
| 2026-04-29 | Wed | 0 |
| 2026-04-30 | Thu | 0 |
| **2026-05-01** | **Fri** | **206** |
| 2026-05-02 | Sat | 0 |

The 206 calls tagged `session_date=2026-05-01` (Fri) all fired between **00:00 UTC and 01:01 UTC Saturday** — i.e., **20:00–21:01 ET Friday evening**, which sits inside the Saturday-UTC cron window and inside Friday's ET trading session by the column definition (`(now() AT TIME ZONE 'America/New_York')::date` per `20260418000002_uw_usage.sql:10`).

The LB8 sample's `observed_at` window was 21:00 UTC Friday → 01:01 UTC Saturday — exactly the boundary slice where the weekend-UTC backfill spills into Friday's ET session_date label.

## Endpoint breakdown

100% `/api/option-contract/<SYMBOL>/historic`. 100% `status=200`. Zero 429s, zero 5xx. Median 60ms. No retry storm signature; this is a clean, well-behaved batch caller hitting exactly one endpoint as documented in the function header.

## Hypothesis

**(b)-modified: legitimate weekend batch, mis-classified by the LB8 sample as mid-week due to ET-vs-UTC bucketing of `session_date`.**

Not (a): cron is correct. Not (c): zero error rate. Not (d): no recent code changes. Not a true (b) either — the work isn't running mid-week at all; it's the boundary slice of the weekend run getting tagged with Friday's ET trading-session label.

## Recommendation

**Document and accept. No code, no schedule, no migration changes.**

Optional (low-priority, not urgent):

1. Re-run the LB8 caller-share query bucketing by **UTC date** instead of `session_date` to confirm zero mid-week spend across all callers, not just this one. The same column-semantics gotcha may be inflating other weekend-only callers' apparent mid-week numbers in the LB8 baseline.
2. Add a one-line note to `docs/decisions/2026-05-02-uw-budget-rebaseline.md` calling out that `session_date` is ET-bucketed and a sample crossing UTC midnight will appear to attribute weekend-UTC fires to Friday's session.

Estimated effort: 5 minutes for the note, 15 minutes for the re-baseline query if James wants the cleaner number.

## Open questions for James

- Do you want the LB8 caller-share table re-cut by UTC clock-day for cleaner mid-week attribution? (Same data already in `ct_uw_usage`, just different `WHERE` clause.)
- Should the budget-views ET-bucketing fix from 2026-04-30 (commit `67c4a19`) extend to a documented convention for caller-share audits — i.e., always specify which time basis the audit is using? Tonight's confusion was a 4-minute round-trip; same trap will catch the next audit if not flagged.
- Worth adding an invariant that flags `caller=ct-historical-quote-backfill` rows with `EXTRACT(DOW FROM observed_at AT TIME ZONE 'UTC') BETWEEN 1 AND 5`? Would catch a real future leak without the ET/UTC confusion (current count: 0).
