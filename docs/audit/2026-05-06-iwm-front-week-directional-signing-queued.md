# Queued audit — IWM front-week directional signing produces $0 cell_value

**Status:** queued, no action this round.
**Source:** observed during Track 2 (D2.2) post-deploy verification when warden invariant `flow_heatmap_front_week_coverage` flipped from passing (12:30Z) to failing (warn, `last_value=1`, `consecutive_fails=3` by 18:00Z).
**Filed:** 2026-05-06 ~14:15 ET.

## What was observed

The new `flow_heatmap_front_week_coverage` warden invariant (shipped this morning via PR #25) fired warn three consecutive 30-min ticks (17:00Z / 17:30Z / 18:00Z). `last_value=1` means **one watchlist ticker has front-week premium > $100k threshold but no front-week bucket in heatmap output under global config defaults.**

**Identified ticker: IWM.**

## Empirical evidence at audit time

| check | finding |
|---|---|
| IWM front-week (next 7 days) total premium | **$5,013,830** (well above $100k threshold) |
| Per-expiry breakdown | 5/6: $117k, 5/8: $2.93M, 5/11: $1.62M, 5/12: $101k, 5/13: $249k |
| IWM heatmap output (with global defaults) | smallest bucket = 5/15. **No 5/8 bucket present.** |
| `is_ask` / `is_bid` flag distribution on IWM front-week alerts | **All 0 / NULL** across the 500-row sample |
| Net signed_premium under aggressive_directional_decay math mode | **$0** |

## Hypothesis (NOT load-bearing — verify in Phase A)

The aggressive_directional_decay math mode signs each event's premium based on `aggressor` direction. The `aggressor` is computed from a chain of fallbacks at `ct_flow_heatmap_live` RPC (lines 111-137 of `20260430170000_ct_flow_heatmap_live_rewrite.sql`):

1. mid-print check (both sides effectively zero) → NULL
2. `is_ask = TRUE` → 'ask'
3. `is_bid = TRUE` → 'bid'
4. `alert_rule LIKE 'RepeatedHits%'` → 'ask'
5. compare `ask_prem` vs `bid_prem` from raw JSON
6. fallback bid/ask comparisons

**For IWM front-week specifically, all rows have `is_ask = NULL/false` AND `is_bid = NULL/false`.** The signing logic falls through to step 4 (RepeatedHits check) or step 5 (raw-JSON ask/bid comparison). If neither produces a clear aggressor, `signed_premium = NULL`, contributes 0 to `sum_aggdir_decay`. Cell value = 0; below `p_min_premium=100000`; bucket dropped from output.

**Other expiries (6/19 etc.) for IWM produce signed values** (heatmap shows 6/19 = -$56M for IWM). So the signing logic IS working for IWM in some windows. The front-week specifically has the data-quality issue.

**Possible causes (each requires verification):**

1. UW's IWM front-week alerts are tagged with `alert_rule` outside RepeatedHits AND lack the `total_ask_side_prem`/`total_bid_side_prem` raw fields. Result: aggressor=NULL, signed=NULL.
2. IWM front-week alerts are predominantly mid-prints (both sides ~zero), correctly classified as NULL aggressor by step 1.
3. UW data-quality regression for IWM specifically — could be a recent change to UW's tagging for low-volume tickers.

## Why warden flipped passing → warn between 12:30Z and 17:00Z

This morning's verification at 12:30Z (post-PR-#25) showed all 10 watchlist tickers passing. At that time IWM's front-week premium was below the $100k threshold OR the alerts hadn't accumulated enough to cross.

By 17:00Z, IWM front-week premium had accumulated to $5M (from the 4-5 hour window of additional UW alerts intra-RTH). The threshold crossing tripped the warden's qualifying-ticker check while the heatmap output remained unchanged (still no 5/8 IWM bucket because the directional-signing produces 0).

**The warden caught a real regression** — IWM accumulated enough front-week flow to qualify for coverage check, and the coverage check correctly identified the gap.

## Why this is NOT D2.2's problem

D2.2 ship at 18:00Z modified GOOGL/AMZN/META wakeup thresholds, not IWM nor flow_heatmap. The directional-signing issue is in `ct_flow_heatmap_live` RPC, which D2.2 didn't touch. The warden warn is **independent of D2.2** and pre-existed (just below the 12:30Z verification threshold).

D2.2's pair-shipped invariant `specialist_per_ticker_freshness_rth` is also unrelated — different category (specialist, not synthesis), different surface.

## Phase A scope (queued for separate per-PR approval)

When this audit activates:

### Step 1 — Verify the directional-signing root cause

(a) Pull IWM front-week alerts and inspect `is_ask`, `is_bid`, `alert_rule`, raw `total_ask_side_prem`, raw `total_bid_side_prem` per row.

(b) Compute the actual aggressor classification for each row through the RPC's CASE chain. Determine which step produces NULL aggressor for which fraction of rows.

(c) Compare against IWM 6/19 expiry alerts (which DO produce signed values). What's different in tagging?

### Step 2 — Determine cause class

- (i) UW data quality — IWM front-week tagging differs from other expiries
- (ii) Helper RPC logic gap — falls through the case chain incorrectly for low-volume tickers
- (iii) Math mode mismatch — aggressive_directional_decay isn't the right mode for low-volume tickers
- (iv) Compound — multiple factors

### Step 3 — Decision matrix for fix

| cause | fix shape |
|---|---|
| (i) UW data quality | document, work around — math mode fallback for low-tag tickers |
| (ii) Helper RPC logic | tighten the CASE chain; possibly add a NULL-aggressor handling that produces a sensible default value |
| (iii) Math mode | per-ticker math mode override in ct_config (Tenet 16) |
| (iv) Compound | per-cause sub-fix |

## Cross-cluster framing

This finding is in the **read-layer integrity bundle** family (🟡#6 expansion):
- The bundle's `status` field would NOT directly resolve this — the issue is in the producer-layer math, not the read-projection.
- BUT the bundle's `as_of` + `source` metadata would help the captain understand WHEN the heatmap was computed and WHICH math mode produced the IWM gap.
- A new `confidence_floor` or `data_quality_note` metadata field could declare per-ticker known-data-quality issues so the captain doesn't have to investigate ad-hoc.

Worth flagging for read-layer integrity bundle scoping review.

## Captain trajectory implication

This is a real signal-loss for IWM. Captain reading IWM heatmap today does NOT see the $5M front-week flow that exists upstream. **Trust gap on IWM front-week reads.**

If IWM is in active trading watchlist: medium-priority. If IWM is rarely-traded: low-priority.

Per memory + brief context, IWM IS in the canonical 10-ticker watchlist. Medium priority. Worth Phase A this week or early next week, before the captain misses an IWM-front-week trade based on the empty heatmap.

## Out of scope for this round

No code changes. No schema changes. No production writes. Just this queued doc. Phase A activates with explicit per-PR approval.

## Cross-references

- Warden invariant: `flow_heatmap_front_week_coverage` (PR #25, this morning)
- RPC: `supabase/migrations/20260430170000_ct_flow_heatmap_live_rewrite.sql:111-137` (directional signing CASE chain)
- Read-layer integrity bundle scope: `/Users/jameschellis/Documents/cowork-cotrader/scope/2026-05-06-read-layer-integrity-bundle-scoping.md`
- Sibling pattern: `feedback_uw_is_ask_bid_never_set.md` memory entry (mentioned this morning's instance #4 catches: "Never check ct_flow_alerts.is_ask/is_bid. Always inferDirection() from _shared/directionInference.ts.") — the underlying RPC math may need same discipline applied to its CASE chain.
