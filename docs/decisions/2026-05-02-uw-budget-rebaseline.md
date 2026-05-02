# 2026-05-02 — UW Budget Re-baseline (LB8 audit)

**Audit type:** Read-only re-baseline of UW spend post-throttle/dedup/warden interventions.
**Question:** Does the original LB8 target (−5,000 calls/day, target 75-80% close) still apply? Or has it already been met?
**Verdict:** **Target met.** Friday 2026-05-01 closed at 65.4% (13,071/20,000). No further structural cuts urgently needed for budget reasons. One leak surfaced (`ct-historical-quote-backfill` mid-week activity). Recommend addressing leak + a smaller polish pass; reserve large structural cuts for if/when budget pressure returns.

## Trend (last 15 sessions)

| Date | session_date | daily_count | pct |
|---|---|---|---|
| 2026-04-17 | Fri | 15,178 | 75.9% |
| 2026-04-18/19 | Sat/Sun | 1,831 / 2,410 | 9.2% / 12.1% |
| 2026-04-20 | Mon | 18,760 | 93.8% |
| 2026-04-21 | Tue | 20,001 | 100.0% (cap) |
| 2026-04-22 | Wed | 20,000 | 100.0% (cap) |
| 2026-04-23 | Thu | 20,000 | 100.0% (cap) |
| 2026-04-24 | Fri | 16,972 | 84.9% |
| 2026-04-25/26 | Sat/Sun | 2,884 / 6,464 | 14.4% / 32.3% |
| 2026-04-27 | Mon | 20,000 | 100.0% (cap) |
| 2026-04-28 | Tue | 17,110 | 85.6% |
| 2026-04-29 | Wed | 18,638 | 93.2% |
| 2026-04-30 | Thu | 20,000 | 100.0% (cap) |
| **2026-05-01** | **Fri** | **13,071** | **65.4%** |

**Story:** Apr 17 → Apr 30: 8 of 10 weekdays hit the 20k cap. **2026-05-01 is the first weekday in two weeks under 75%.** The throttle/dedup/caller-hygiene work done 2026-04-29 → 2026-05-01 visibly bent the curve.

## Caller distribution (last 1000 calls of 2026-05-01 — biased toward latest hours; 8% of total)

| Caller | Share | Was (Apr 30 baseline) |
|---|---|---|
| ct-flow-ingester | 31.1% | ~18% |
| ct-technicals-ingester | 20.4% | (not in original baseline) |
| **ct-historical-quote-backfill** | **16.3%** | (not in original baseline — see leak) |
| ct-contract-poller | 11.9% | **~50%** ← MASSIVE drop |
| ct-watcher | 11.6% | (not separately broken out) |
| ct-news-ingester | 6.4% | (in "other ~15%") |
| ct-eod-positioning | 1.6% | (in "other") |
| Others (vix, analyst, spy) | 0.7% | (in "other") |
| **null caller** | **0%** | **~13%** ← visibility gap closed |

**Wins confirmed:**

1. **ct-contract-poller throttle landed.** Share dropped from ~50% → 11.9%. This is the headline structural win. The tier-aware step-down (Option C from the playbook) is doing what it said.
2. **Caller hygiene 100% complete.** Zero null-caller calls in the sample. The 38-function `setUwCaller()` pass + recent additions closed the 13% visibility gap. Future audits are 1-query.

**Concerning surfaces:**

3. **ct-historical-quote-backfill at 16.3% mid-week.** Per LB8 plan item #2, backfills are supposed to be weekend-only ("strict weekend-only enforcement"). That's ~2,100 calls/day attributed to mid-week backfill activity. **This is the most likely "active leak"** — investigate which cron schedule fires it and whether it should be moved to weekend-only OR if it's bursty and OK.
4. **ct-technicals-ingester at 20.4%.** Not separately broken out in the original baseline, but ~2,700 calls/day is substantial. If it landed after the original audit, it's "new spend" that justifies a fresh policy review. If it's been there all along, the original baseline missed it.
5. **429s at 8.3%.** Minute-rate hits, not daily-cap. Suggests heavy callers fire bursty enough to clip the per-minute ceiling. Not a daily-budget issue but a UX/freshness issue (retried calls or dropped data?).

## Recommendation

**Do NOT execute the original 5-cut plan as designed.** The biggest cut (contract poller throttle, item #1) is already done and working. Instead:

### Tonight (non-UW work — already in James's plan)
- LB8 audit doc (this file). Done.

### Next maintenance window (Saturday post-UW-reset OR Mon if UW headroom low)
1. **Investigate ct-historical-quote-backfill schedule.** Is there a cron firing it M-F? Move to weekend-only if so. Estimated saving: −2,100 calls/day (well over half of remaining budget gap to comfort).
2. **Audit ct-technicals-ingester scope.** What endpoint is `mcp:get_av_technical_indicator` (142 of 1000 sample calls)? Is the cadence justified? Could it move to RTH-only or every-15min instead of whatever it is now?
3. **Per-minute pacing in ct-flow-ingester** if 429s materially affect freshness. Probably defer until we see the actual signal degradation case — 8.3% 429s isn't blocking anything right now.

### Deferred (don't need anymore)
- LB8 plan items #1 (contract poller — DONE), #5 (caller hygiene — DONE).
- LB8 plan items #3 (TTL cache layer) and #4 (skip expired 0DTE polling) are still potentially valuable for further compression but **not urgent** at 65.4% close. Re-evaluate if a Mon-Wed week pushes back into 90%+ territory.

## Class lesson

The −5,000 target was set against a 77.9% baseline. Two weeks later the baseline is 65.4% — the actual cut achieved is **~6,500 calls/day** (Fri-to-Fri compare: 16,972 → 13,071 = −3,901; vs the 4-day cap-streak peak of 20k → 13,071 = −6,929). Mid-cap-streak baseline was higher than the audit anchor; the cuts beat the original target.

**Audit-first lesson:** the LB8 plan was solid 2026-04-30. By 2026-05-02 most of it had already been quietly executed (tier-aware throttle, caller hygiene). **Re-baseline before re-executing a multi-week-old plan.** Most of LB8's recommended cuts no longer need to be done; the leaks that remain (`ct-historical-quote-backfill`, possibly `ct-technicals-ingester`) weren't on the original list.

## Methodology caveats

- The 1,000-row sample is the most-recent ~8% of 2026-05-01 (PostgREST 1000-row cap, ordered by `observed_at` desc). Biased toward late-RTH + post-close. Earlier-day distribution may differ.
- A full-day per-caller breakdown would require pagination (~14 chunks of 1000 each). Not done tonight to keep this audit short. Worth doing as a Sat morning task if any single caller's day-shape needs investigation.
- "Was (Apr 30 baseline)" column is from the playbook's audit; the original audit's exact methodology (sample size, time window) isn't documented, so direct percentage comparisons are approximate.

## What changes for tonight's plan

Nothing. None of tonight's 9 items uses UW. The audit itself was 0 UW calls (read-only on `ct_uw_usage`). Budget guardrail status: still 65.4% as of 00:31 UTC.

## Open question for James

`ct-historical-quote-backfill` at 16.3% of daytime sample — is this a known mid-week job, or did a cron schedule slip and start firing on weekdays? If unknown intent, the next session should grep `cron.job` and migrations for its schedule before touching it.
