# Phase A — flow heatmap front-week buckets, diagnose-only

**Date:** 2026-05-06 (Wed, ~07:55 ET pre-bell, T-1:35 to RTH open).
**Trigger:** Trading-session report — "MCP flow heatmap output skips front-week buckets. 5/8 missing, smallest DTE shown is 5/15."
**Bell-window relevance:** Today is single-name 0DTE for Mag7+IBIT+AVGO. If 0DTE/sub-week flow isn't reaching the captain, the primary signal of the day is degraded.
**Scope discipline:** Phase A diagnose-only. No fixes, no patches. Class-kill candidates flagged for explicit per-PR approval before Phase B.

---

## TL;DR

The trading session's framing was **partially correct** — instance #10 of the methodology-errors-cascade pattern (partial-frame). For 5 of 10 watchlist tickers (AAPL, GOOGL, AMZN, SPY, IWM), the 5/8 bucket genuinely isn't surfaced; for the other 5 (NVDA, MSFT, META, TSLA, QQQ), 5/8 IS surfaced in top-3. The proximate cause the framing implied (0DTE filter dropping the 5/8 bucket entirely) is **wrong** — every 5/8 bucket survives the 0DTE exclusion. The actual cause is **two compounding consumer-side filters**:

1. **`p_include_0dte: false`** at `supabase/functions/_shared/flowHeatmapContext.ts:62`. Drops today's 0DTE expiry rows entirely from the source RPC. Material: AAPL +225% (sign flip), AMZN +51%, MSFT +42%, META +22%, TSLA +18%, NVDA +7.5% on the 5/8 bucket value.
2. **`DEFAULT_CAP = 3`** at `flowHeatmapContext.ts:32`. Top-3 stacks per ticker by `|value|`. For AAPL/GOOGL/AMZN/SPY/IWM, the 5/8 bucket isn't top-3 today and gets truncated.

**No ingestion gap.** `ct_flow_alerts` has 343 0DTE rows for today's expiry across the watchlist (TSLA 125 alerts/$26.8M, SPY 49/$8.1M, QQQ 47/$8M, NVDA 29/$7.5M, AMZN 25/$6.7M, MSFT 23/$5M, META 20/$7M, AAPL 15/$5.1M, GOOGL 9/$1.7M, IWM 1/$118k). The signal exists in prod, the helper filters it out before it reaches the MCP.

**Bell-window risk:** today is single-name Mag7 0DTE day; suppressing 0DTE flow at the helper kills the most signal-rich dimension at the worst moment.

---

## §a — Verify the framing (audit-can-have-false-premises)

### What the user said
> "MCP flow heatmap output skips front-week buckets. 5/8 missing, smallest DTE shown is 5/15."

### What the data says

Pulled `ct_flow_heatmap_live(p_include_0dte=false)` for all 10 watchlist tickers and applied the helper's `cap=3` per-ticker sort:

| ticker | 5/8 in top-3? | 5/8 value (no 0DTE) | smallest DTE shown |
|---|---|---:|---|
| NVDA  | **YES** (top, $19.9M) | +$19.9M | 5/8 |
| MSFT  | **YES** (#3, $1.7M)   | +$1.7M  | 5/8 |
| META  | **YES** (top, $3.3M)  | +$3.3M  | 5/8 |
| TSLA  | **YES** (#2, $5.6M)   | +$5.6M  | 5/8 |
| QQQ   | **YES** (#2, $24.0M)  | +$24.0M | 5/8 |
| AAPL  | **NO** (#5, $922k)    | +$922k  | 5/15 |
| GOOGL | **NO** (#4, $1.93M)   | +$1.93M | 5/15 |
| AMZN  | **NO** (#4, $3.58M)   | +$3.58M | 6/5  |
| SPY   | **NO** (#4, $19.4M)   | +$19.4M | 5/15 |
| IWM   | **NO** (#5, $237k)    | +$237k  | 5/15 |

The user's claim "smallest DTE shown is 5/15" is **literally true for AAPL, GOOGL, SPY, IWM** (4 of 10) and **almost true for AMZN** (smallest is 6/5, not 5/15). For the other 5 names, **5/8 is in fact the top or near-top stack** — the framing is wrong for half the watchlist.

**Class:** partial-frame / methodology-errors-cascade #10. Symptom observation correct on a subset; proximate cause inferred from the symptom (0DTE exclusion entirely dropping front-week buckets) is empirically wrong. Same shape as the §5 "AAPL/MSFT/GOOGL/NVDA absent" finding from this morning's prior audit (PostgREST 1000-cap artifact, not real silence).

---

## §b/c — Consumer-side filter vs ingestion gap

### Source data — ct_flow_alerts has 0DTE rows for today (no ingestion gap)

`ct_flow_alerts` rows where `expiry = 2026-05-06` (today's 0DTE), ingested in last 168h:

| ticker | alerts | total premium (last 168h) |
|---|---:|---:|
| TSLA  | 125 | $26,827,898 |
| SPY   |  49 |  $8,126,202 |
| QQQ   |  47 |  $8,015,582 |
| NVDA  |  29 |  $7,534,571 |
| AMZN  |  25 |  $6,729,967 |
| MSFT  |  23 |  $5,012,373 |
| META  |  20 |  $6,998,418 |
| AAPL  |  15 |  $5,110,744 |
| GOOGL |   9 |  $1,662,066 |
| IWM   |   1 |    $117,808 |

**Total:** 343 rows, $76.1M premium of 0DTE flow for the watchlist sitting in prod. Pre-bell at the moment of audit, no rows ingested today (`ingested_at` starts 2026-05-06: 0 rows) — that's expected since pre-RTH.

The signal exists. The helper is dropping it.

### Filter location 1 — `p_include_0dte: false`

`supabase/functions/_shared/flowHeatmapContext.ts:58-65`:

```typescript
const { data, error } = await supabase.rpc('ct_flow_heatmap_live', {
  p_tickers: watchlist,
  p_math_mode: 'aggressive_directional_decay',
  p_min_premium: 100000,
  p_include_0dte: false,         // ← here
  p_max_expiry_days: 180,
  p_lookback_hours: 168,
});
```

Underlying RPC at `supabase/migrations/20260430170000_ct_flow_heatmap_live_rewrite.sql:109`:

```sql
AND (p_include_0dte OR a.expiry::date > CURRENT_DATE)
```

Per-row gate: when `p_include_0dte=false`, only rows where `expiry > today` are included. So **0DTE rows (expiry = today) are entirely excluded.**

The same pattern appears in 4 sibling RPCs:
- `ct_flow_heatmap_live` (live aggregate)
- `ct_flow_heatmap_diff` (window-vs-window delta)
- `ct_flow_heatmap_strikes` (per-strike for /heatmap UI)
- `ct_flow_heatmap_top_n_strikes` (top-N strikes for /heatmap UI)

All default to `false`. No comment in any migration explains the rationale.

### Filter location 2 — `DEFAULT_CAP = 3`

`flowHeatmapContext.ts:32`:

```typescript
const DEFAULT_CAP = 3;
```

And at line 78 in `getFlowHeatmapContext`:

```typescript
stacks: stacks.sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, cap),
```

The MCP doesn't override this — `get_co_trader_context.ts` calls `buildClaudeContext` without per-helper opts, so the helper takes `DEFAULT_CAP = 3`. Result: only top-3 stacks per ticker reach the captain, sorted by `|value|` desc.

For tickers where farther-out weeks have higher `|value|` (AAPL, GOOGL, AMZN, SPY, IWM today), the 5/8 bucket — even when present — falls below the cap.

### Quantified 0DTE contribution to 5/8 bucket today

Comparing `include_0dte=true` vs `=false` for the 5/8 bucket per ticker:

| ticker | with 0DTE | without 0DTE | delta | % |
|---|---:|---:|---:|---:|
| **AAPL** | **-$733k** | **+$922k** | **−$1.65M** | **(SIGN FLIP, +225%)** |
| AMZN | +$7.33M | +$3.58M | +$3.75M | +51.2% |
| MSFT | +$2.94M | +$1.72M | +$1.22M | +41.6% |
| META | +$4.27M | +$3.31M | +$959k  | +22.5% |
| TSLA | +$6.89M | +$5.61M | +$1.28M | +18.5% |
| NVDA | +$21.51M| +$19.90M| +$1.61M | +7.5% |
| GOOGL| +$2.16M | +$1.93M | +$234k  | +10.8% |
| QQQ  | +$24.02M| +$24.07M| -$54k   | -0.2% |
| SPY  | +$17.83M| +$19.40M| -$1.57M | -8.8% |
| IWM  | +$135k  | +$237k  | -$103k  | -76.3% |

**For AAPL, the filter doesn't just suppress magnitude — it flips the sign of the 5/8 bucket from bullish (+$922k without 0DTE) to bearish (-$733k with 0DTE).** The captain looking at the no-0DTE heatmap reads AAPL front-week as bullish; with 0DTE included, it's net bearish. **This is the loss-of-signal James was concerned about**, in its strongest form.

Across the watchlist, **6 of 10 tickers have the 5/8 bucket inflated by 0DTE flow** (AAPL/AMZN/MSFT/META/TSLA/NVDA — all Mag7 names). The 4 names where 0DTE flow is net-negative on the 5/8 bucket (GOOGL/QQQ/SPY/IWM) include 3 broad-index ETFs that don't trade single-name 0DTE today.

### Are buckets entirely dropped by the 0DTE filter?

Cross-tab: **0** buckets present with `include_0dte=true` drop out under `=false`. Every bucket survives the filter; the difference is purely magnitude (and AAPL's sign).

So the user's framing "5/8 missing because of 0DTE filter" is wrong about the **mechanism** (the filter doesn't drop the bucket, it just suppresses 0DTE contribution to it), but right about the **direction of the loss** (front-week visibility is degraded for Mag7 names that have material 0DTE flow today).

---

## §d — Cross-check today's Mag7 0DTE relevance

| Mag7 name | trades single-name 0DTE Mon/Wed/Fri? | today's 0DTE alerts (last 168h) | premium suppressed by filter |
|---|---|---:|---:|
| NVDA  | yes | 29 | $7.5M |
| AAPL  | yes | 15 | $5.1M |
| MSFT  | yes | 23 | $5.0M |
| GOOGL | yes |  9 | $1.7M |
| AMZN  | yes | 25 | $6.7M |
| META  | yes | 20 | $7.0M |
| TSLA  | yes | 125 | $26.8M |

**All 7 Mag7 names have material 0DTE flow today, all of it filtered out before reaching the MCP organ.** TSLA at $26.8M is by far the largest individual signal — the MCP captain reads TSLA front-week without seeing $26.8M of 0DTE positioning.

For NVDA specifically (today's most-watched name per yesterday's EOD): 0DTE flow contributes $1.6M to the $19.9M 5/8 bucket — a 7.5% magnitude understatement, but the bucket itself is intact and dominant. **NVDA D2 verification at 10:30 ET should not be load-bearing on heatmap front-week visibility** — NVDA's 5/8 bucket is the top stack regardless.

For AAPL: the filter is **sign-flipping** front-week direction. The captain reading AAPL gets a misleading bullish read.

---

## Class-kill candidates (require explicit per-PR approval before Phase B)

### Candidate A — flip `p_include_0dte: true` in the helper

**Shape:** one-line change in `flowHeatmapContext.ts:62`.

**Pros:** zero migration; fixes the immediate bell-window concern; restores front-week magnitudes (and AAPL sign).

**Cons:** patches the symptom, not the root. Doesn't address the discovery problem (next dev who asks "should we include 0DTE here?" has no documented answer). Violates Tenet 16 ("every number tunable, config in `ct_config`"). Same accretion-prone pattern as the warden filter we just killed this morning.

**Decision-ritual gate:** patch, not class kill.

### Candidate B — bump `DEFAULT_CAP` from 3 to ~6 (or 8)

**Shape:** constant change in `flowHeatmapContext.ts:32`.

**Pros:** front-week buckets that exist but rank #4-5 (AAPL, GOOGL, AMZN, SPY, IWM today) now reach the captain. Token impact minimal — each stack is ~30 bytes serialized.

**Cons:** same patching critique. Why 6? Why not 4 or 10? No principled basis. The 8k token budget for the MCP's flow_heatmap organ allows much more, but bigger isn't better — the captain wants signal density, not noise.

**Decision-ritual gate:** patch, not class kill.

### Candidate C — config-table-driven helper params (Tenet 16 class kill)

**Shape:** read `p_include_0dte`, `cap`, `min_premium`, `lookback_hours` from `ct_config.flow_heatmap.*` instead of hardcoded constants. One config row, mutate via SQL UPDATE, no code change to retune.

**Pros:** **structural class kill.** Tenet 16 ("every number tunable, config in `ct_config`") satisfied. Tenet 25 ("evolves in structure") — adjusting helper behavior becomes a database UPDATE, not a code change. Sibling consumers (`ct-eod-report`, `ct-eod-summary`, `ct-daily-brief`, `ct-trade-idea-generator`, `tapeContext`) inherit the same source-of-truth and stop drifting.

**Cons:** higher build cost than A or B. New table or new rows in `ct_config`. Need a default-seed migration. All consumers need to read the config (one helper change reaches them all if they go through `getFlowHeatmapContext`). Risk: `ct_config` growth-class violations if not bounded.

**Decision-ritual gate:** class kill. Captures the rule once, applies to every consumer, makes future tuning a DB UPDATE.

### Candidate D — warden invariant for front-week DTE coverage

**Shape:** new row in `ct_invariants`. Query: count distinct watchlist tickers where the heatmap output contains a bucket within 7 days of `CURRENT_DATE`. Threshold: `expected_min ≥ 8` (allow 2 tickers to legitimately have no front-week material flow). Severity: warn.

**Pros:** defense-in-depth. Catches future regressions in the helper, RPC, or upstream. Independent of A/B/C.

**Cons:** detection without prevention. Warns when the front-week is dark, but doesn't fix it. Best paired with C.

**Decision-ritual gate:** complementary class-kill (catches the failure mode going forward, even if A/B/C drift back).

### Candidate E — decompose helper into two independent concerns

**Shape:** split `getFlowHeatmapContext` into `fetchHeatmapBuckets()` (which expiries/min_premium/lookback) and `selectStacks()` (cap/sort policy). Each independently configurable.

**Pros:** cleaner architectural shape. Caller can pass policy without touching ingestion params (or vice versa). Sets up future per-audience caps (cotrader = top-3 dense; analyst = top-10 wide; voice = top-1 only).

**Cons:** higher build cost than C. Premature unless we have evidence of multiple audience policies needing different cuts. YAGNI watch.

**Decision-ritual gate:** worth queuing for v2 of the helper, not blocking class kill.

---

## Recommendations for Phase B (per-PR review queue)

My read:

1. **Bell-window urgency vs. discipline:** Candidate A would solve James's bell-window concern in 5 minutes. But **the warden critical from this morning was Option-A-shaped reasoning** (extend filter, accrete patches), and we class-killed it (Option B). Re-applying Option A to a different problem 2 hours later contradicts the discipline we just enforced.

2. **Recommended Phase B path:** **C + D together.** C kills the class (config-driven helper, 1 source of truth across consumers). D adds defense-in-depth so future regressions surface as warden warnings rather than another trading-session post-hoc.

3. **Bell-window mitigation while C+D ship:** if the bell-window risk is unacceptable until C+D are merged, ship A as a **temporary patch** WITH the C+D PR pre-queued. The patch lives only until the class kill lands. Document in the patch PR that "this is intentionally a patch until #N (C+D PR) merges, then revert/migrate to config."

4. **Cap question (B):** I have no principled answer for why DEFAULT_CAP should be 3 vs 6 vs 8. Recommend that go through C — write a migration that initializes `ct_config.flow_heatmap.cap = 3`, then adjust empirically by mutating the row, never by editing code.

5. **Out of scope for this audit:** the AAPL sign-flip is the most striking single finding. Whether AAPL's actual 5/8 directional bias today is bullish or bearish is a trading question, not a code question. Flag for trading-session attention regardless of which Phase B path ships.

---

## Methodology audit (self-check)

- ✅ Pulled raw RPC output (both `include_0dte=true` and `=false`) directly, did not infer from helper code alone.
- ✅ Source-data ground truth via `ct_flow_alerts` count=exact (343 rows, Range header verified — applied today's lesson on hidden row caps).
- ✅ Cross-checked the framing's literal claim ("5/8 missing") per-ticker, not in aggregate. Found the partial-frame.
- ✅ Verified no buckets are entirely dropped by the 0DTE filter (cross-tab `with ∖ without`).
- ✅ Identified two compounding filters, not one. Resisted the temptation to attribute to the filter the user named.
- ✅ Confirmed sole consumer of `ct_flow_heatmap_live` in app code is the helper; no other consumer to coordinate with.
- ✅ Bell-window relevance quantified per ticker, not handwaved.
- ⚠️ Did NOT re-execute the helper end-to-end via a Deno smoke test — replicated the helper's cap/sort logic in Python. Functionally equivalent for the data shape; flagging the methodological trade-off.
- ⚠️ Did NOT inspect `ct-eod-report`, `ct-eod-summary`, `ct-daily-brief`, `ct-trade-idea-generator` for whether they call `getFlowHeatmapContext` with custom opts that override the defaults. The grep showed they import the helper, but the call-site opts weren't audited per-consumer. Pre-flag: if any of those consumers passes a custom cap or include_0dte, the per-consumer fix surface is wider than the MCP organ alone. Worth verifying in Phase B before locking the C config schema.

No empirical-cause claims made beyond what data + code support. Hypothesis-to-verify items resolved with explicit yes/no rather than left ambiguous.
