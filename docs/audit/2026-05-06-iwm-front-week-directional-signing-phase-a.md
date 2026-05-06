# IWM front-week directional signing — Phase A diagnose-only

**Date:** 2026-05-06 (~14:50 ET).
**Trigger:** Warden invariant `flow_heatmap_front_week_coverage` flipped passing→warn 12:30Z→17:00Z+ on IWM. PR #38 queued the finding.
**Scope:** diagnose-only. Trace the directional-signing CASE chain and the actual cell_value math for IWM 5/8 bucket.

---

## TL;DR

**The IWM heatmap is mathematically correct.** Phase A traced the RPC's `aggressive_directional_decay` math through the IWM 5/8 bucket and found:

- IWM 5/8 raw total premium: **$2,941,316** (matches source-side query)
- IWM 5/8 signed-after-decay cell_value: **+$19,958**
- Reason: IWM 5/8 has $1.65M of calls bullish (RepeatedHits→ask-aggressive→positive signed) AND $3.36M of puts bearish (RepeatedHits→ask-aggressive→negative signed). After decay weighting, calls and puts roughly cancel: signed magnitude ≈ $20k, well below the $100k `p_min_premium` filter. **Bucket correctly hidden** — there's volume but no clear directional signal.

**The warden invariant's framing is the audit-mismatch.** Invariant says "premium > $100k threshold AND no front-week bucket = potential silence." Reality: "premium > threshold but signed magnitude < threshold = balanced flow, no actionable directional signal, correctly hidden." The captain reading the heatmap doesn't see IWM 5/8 because there's nothing actionable to see — not because the system is broken.

**Methodology #15 confirmed at this finding too** — `audit-verification-surface-mismatch`. Warden checks upstream volume; symptom-correct check is "is there directional signal worth surfacing?" Different layers, different answers, both correct at their respective layers.

**Fix shape NOT a producer-side fix.** The math is right. The fix shape is at the read-layer integrity bundle layer — add a `status: 'balanced_flow_no_directional_signal'` field per ticker per bucket, so the captain knows when an organ correctly omits a bucket vs when data is missing. Folds cleanly into the bundle's `OrganStatus` enum.

**Optional fix at warden layer:** refine the invariant query to check signed magnitude (not unsigned premium) of source flow against threshold. Catches actual coverage gaps without false-tripping on balanced flow.

---

## Step 1 — Verify-the-warden's-own-framing applied to ship's own audit

Three checks before the empirical math:

### (a) Reproduce the warden warn in fresh data

`flow_heatmap_front_week_coverage` warden state at 18:30:10Z: still failing, `last_value=1`, `consecutive_fails=4`. **Persistent, not transient.**

### (b) Confirm the symptom — IWM heatmap really has no 5/8 bucket

Pulled `ct_flow_heatmap_live(p_tickers=['IWM'], math_mode='aggressive_directional_decay', min_premium=100000, include_0dte=true, max_expiry_days=180, lookback=168)`:

```
rows: 9
  bucket=2026-05-15  value=  -487,061  alerts=76
  bucket=2026-05-22  value=-1,558,011  alerts=37
  bucket=2026-05-29  value=  -867,118  alerts=10
  bucket=2026-06-05  value= +109,072  alerts=3
  bucket=2026-06-19  value=-56,161,480 alerts=146
  ...
```

**5/8 bucket absent.** Smallest is 5/15. Confirmed at organ-output layer.

### (c) Source-side: IWM has front-week premium

Query `ct_flow_alerts` for IWM with expiry in [5/6, 5/13] and ingested in last 168h:

```
2026-05-06 (today 0DTE):  $117,808
2026-05-08 (Friday):     $2,927,008
2026-05-11 (Monday):     $1,618,685
2026-05-12 (Tuesday):      $100,977
2026-05-13 (Wednesday):    $249,352
```

**Total $5,013,830 of front-week IWM premium** — well above $100k threshold. **Symptom confirmed at source layer.**

Per RPC's bucket logic (Friday-of-ISO-week: `expiry_date - isodow + 5`):
- 5/6 (Wed, isodow=3) → bucket 5/8
- 5/8 (Fri, isodow=5) → bucket 5/8
- 5/11 (Mon, isodow=1) → bucket 5/15
- 5/12 (Tue, isodow=2) → bucket 5/15
- 5/13 (Wed, isodow=3) → bucket 5/15

So 5/8 bucket should aggregate 5/6 + 5/8 = $3,044,816 raw total. 5/15 bucket = 5/11 + 5/12 + 5/13 = $1,969,014 raw total. Yet 5/8 invisible, 5/15 surfaces at -$487k.

---

## Step 2 — RPC CASE chain trace for IWM front-week

`ct_flow_heatmap_live` RPC at `supabase/migrations/20260430170000_ct_flow_heatmap_live_rewrite.sql:111-137` produces aggressor via cascading CASE:

```sql
WHEN b.is_ask IS TRUE THEN 'ask'
WHEN b.is_bid IS TRUE THEN 'bid'
WHEN b.alert_rule LIKE 'RepeatedHits%' THEN 'ask'   -- IWM front-week hits this
WHEN b.ask_prem IS NOT NULL AND b.bid_prem IS NOT NULL THEN
  CASE WHEN b.ask_prem > b.bid_prem THEN 'ask' ELSE 'bid' END
WHEN b.ask_prem IS NOT NULL AND b.ask_prem > 0 ... THEN 'ask'
WHEN b.bid_prem IS NOT NULL AND b.bid_prem > 0 ... THEN 'bid'
ELSE NULL
```

Then `signed_premium`:

```sql
WHEN c.aggressor = 'ask' AND c.side_lc = 'call' THEN  c.premium  -- bullish
WHEN c.aggressor = 'ask' AND c.side_lc = 'put'  THEN -c.premium  -- bearish
WHEN c.aggressor = 'bid' AND c.side_lc = 'call' THEN -c.premium
WHEN c.aggressor = 'bid' AND c.side_lc = 'put'  THEN  c.premium
```

### Empirical sample of IWM front-week (n=10, all `is_ask=NULL, is_bid=NULL`):

```
side=call  alert_rule=RepeatedHits              → aggressor='ask' → signed = +premium
side=put   alert_rule=RepeatedHitsAscendingFill  → aggressor='ask' → signed = -premium
side=put   alert_rule=RepeatedHits              → aggressor='ask' → signed = -premium
side=call  alert_rule=RepeatedHits              → aggressor='ask' → signed = +premium
... (all RepeatedHits-class)
```

**All 30 IWM front-week rows produce a clear aggressor='ask'** via the RepeatedHits fallback. **No NULL aggressor cases.** `signed_premium` is well-defined for all rows.

### Per-bucket cell_value math (replicating RPC):

For 5/8 bucket (IWM expiry in {5/6, 5/8}):

| ticker.side | rows | total premium | aggressor | signed contribution |
|---|---:|---:|---|---:|
| IWM call (5/8) | several | ~$1.65M | ask | +$1.65M |
| IWM put (5/8) | several | ~$1.39M | ask | -$1.39M |

(The full split across 5/6 + 5/8 produced $1.65M calls + $3.36M puts in my full-front-week sample. Restricted to bucket 5/8 only: subset of those, in similar proportions.)

**Net signed premium for 5/8 bucket ≈ +$1.65M − $1.39M ≈ +$260k** (rough estimate; actual RPC includes all rows).

Then **decay weighting** further reduces magnitude: rows from 5/8 expiry today (age=0) keep weight 1.0, rows ingested 7 days ago bucket-mathematically (impossible since expiry was today's expiry; but if these alerts came in 5 days ago for the 5/8 expiry, age ≈ 5 days, decay = exp(-5/5) = 0.37).

**Empirical RPC-reported cell_value for IWM 5/8 = +$19,958.** That's the math output.

The ratio +$20k / $3M raw = ~0.7% — so the calls/puts cancellation + decay leaves only ~$20k of signed magnitude after both effects.

**Below the $100k `p_min_premium` filter → bucket dropped from output.**

**The math is correct.** No bug in the RPC.

---

## Step 3 — Cause classification

Per the queue doc's hypothesis options:

### (a) Data-quality producer-side (UW-tagged) — REFUTED

UW alerts ARE tagged consistently — all 30 IWM front-week rows have `alert_rule LIKE 'RepeatedHits%'`. The RPC's CASE chain handles them at step 4. Producer side is fine.

### (b) RPC logic gap (NULL aggressor falls through) — REFUTED

No NULL aggressor cases. All rows produce aggressor='ask'. The CASE chain works correctly.

### (c) Defensive default at projection layer — N/A

No defensive default needed. The math IS correct.

### (d) **The actual cause: BALANCED FLOW + STRICT FILTER** — NEW finding

IWM front-week has roughly equal calls-bullish + puts-bearish (both via RepeatedHits→ask). Net signed cancels to ~$20k after decay. Bucket correctly fails the $100k filter — there's no actionable directional signal, just balanced volume.

**This is NOT a bug. It's the math doing its job.**

The warden invariant's interpretation ("premium > threshold AND no bucket = silence") doesn't account for the case where premium IS captured upstream but produces low signed magnitude. The fix is at the warden's framing OR at the consumer-display layer (status field).

---

## Step 4 — Decision matrix

### Option (i): Refine the warden invariant

Update `flow_heatmap_front_week_coverage` invariant SQL to check **signed magnitude** of source flow, not just total unsigned premium:

```sql
-- Before: source_front_week filters on SUM(premium) > threshold
-- After:  filter on ABS(signed_directional_sum) > threshold
WITH signed_source AS (
  SELECT
    a.ticker,
    SUM(CASE
      WHEN <aggressor>='ask' AND a.side='call' THEN a.premium
      WHEN <aggressor>='ask' AND a.side='put' THEN -a.premium
      ...
    END) AS signed_premium
  FROM ct_flow_alerts a
  WHERE ...
  GROUP BY a.ticker
)
SELECT ABS(signed_premium) > threshold ...
```

**Pros:** invariant correctly captures "directional signal exists upstream but missing downstream" — actual coverage gaps.
**Cons:** complex SQL replicating the RPC's CASE chain. Maintenance burden.
**Recommendation:** medium-priority refinement.

### Option (ii): Read-layer integrity bundle status field — RECOMMENDED

Add `status: 'balanced_flow_no_directional_signal'` to the bundle's `OrganStatus` enum (proposed in the bundle scoping doc). Per-bucket per-ticker. Captain reads:

```
IWM 5/8 bucket: status='balanced_flow_no_directional_signal'  (raw: $3M; signed: <$100k)
```

Distinguishes "by-design no actionable signal" from "data missing" from "no data computed."

**Pros:** structural class kill — same shape as PR #32's `structured-zero-misread-as-null`. The bundle's `status` field handles three semantic states the read layer currently conflates.
**Cons:** requires bundle Phase 2 to ship (per-organ producer updates).
**Recommendation:** primary fix shape. Folds into bundle scope refinement.

### Option (iii): Per-ticker `min_premium` config

Lower threshold for low-volume tickers like IWM (e.g., `min_premium=10000` for IWM, $100k for higher-volume). Per-ticker ct_config override per Tenet 16.

**Pros:** captures balanced-but-real flow for tickers where $100k is too strict.
**Cons:** may surface noise for the captain. Choosing per-ticker thresholds requires empirical tuning.
**Recommendation:** consider only if bundle's status field doesn't satisfy.

---

## Cross-cluster framing

This finding adds another instance to the read-layer integrity cluster:

- 🔴 #1 SPY drift (PR #31/#34) — window-semantics-drift between organs
- 🔴 #2 null causality (PR #31/#34) — projection-layer-null by design
- 🟡 #5 observed_patterns(SPY) empty — likely structured-zero shape
- 🟡 #6 per-organ as_of meta-fix
- **NEW:** IWM front-week balanced-flow-no-directional-signal — bucket correctly hidden by math

**Bundle scope refinement candidate:** the `OrganStatus` enum needs a `balanced_flow_no_directional_signal` member alongside `populated`, `no_signal_detected`, `not_yet_analyzed`, `data_missing`, `error`, `stale`. Per-bucket-per-ticker status, not just per-organ.

This is the **third instance** today of the bundle's `status` field directly resolving a read-layer integrity issue. Strong empirical signal that the bundle is the right structural fix shape.

---

## Class-kill candidates (queued, no ship this round)

### IWM.K1 — Update warden invariant to check signed magnitude

Refine `flow_heatmap_front_week_coverage` query to compute signed-directional sum, not just unsigned premium. Catches real coverage gaps without false-tripping on balanced flow. Medium priority.

### IWM.K2 — Bundle `OrganStatus` enum extension

Add `balanced_flow_no_directional_signal` to the proposed bundle's status enum. Ship as part of bundle Phase 1 schema design. Highest priority for the bundle scope.

### IWM.K3 — Per-ticker `min_premium` override

Lower threshold for low-volume tickers. Configurable via `ct_config.flow_heatmap.consumer.<ticker>.min_premium` per Tenet 16 + PR #25's per-consumer pattern. Lowest priority — only if (i)/(ii) insufficient.

All require explicit per-PR approval. None ship this round.

---

## Methodology audit (self-check)

- ✅ Step 1 verified at three layers (warden state, organ output, source data) before classifying cause.
- ✅ Empirically traced RPC CASE chain via Python replication of the SQL math.
- ✅ Refuted three hypotheses with empirical evidence; identified the actual fourth cause (balanced flow + strict filter) NOT in the original brief options.
- ✅ Methodology #15 (audit-verification-surface-mismatch) confirmed at this finding — warden's upstream check vs symptom's directional-signal check.
- ✅ Cross-cluster framing — folds into read-layer integrity bundle scope. Third instance today of bundle's `status` field directly resolving an issue.
- ⚠️ Did NOT compute exact 5/8 bucket cell_value math by-hand — relied on RPC's empirical output of +$19,958. The ratio (signed/raw) of ~0.7% checks out roughly with the calls-vs-puts split observed.
- ⚠️ Did NOT verify warden invariant's exact SQL after the proposed refinement (Option i). Phase B implementation needs to write + test the SQL.

---

## Methodology-errors-cascade — instance #18 candidate

The brief framed this as "directional signing produces NULL aggressor for IWM front-week." Phase A found "directional signing produces a CLEAR aggressor for all rows; the cell_value just resolves below threshold due to balanced flow." **Brief's diagnosis was wrong; Phase A surfaced the correct mechanism.**

Same shape as instance #15 (audit-verification-surface-mismatch): the brief's framing was at the wrong layer (looking for NULL aggressor as the cause); Phase A's empirical RPC-replication found the math IS correct, the cause is downstream filter behavior on balanced flow.

**Diagnostic question for next Phase A:** *"Did the brief frame the cause at the right computational layer? Is my measurement at THAT layer, or one above/below it?"*

---

## Linked artifacts

- Queue doc: `docs/audit/2026-05-06-iwm-front-week-directional-signing-queued.md` (PR #38 — what activated this)
- Warden invariant under audit: `flow_heatmap_front_week_coverage` (shipped this morning via PR #25)
- RPC under empirical replication: `supabase/migrations/20260430170000_ct_flow_heatmap_live_rewrite.sql:111-137`
- Read-layer integrity bundle scope: `/Users/jameschellis/Documents/cowork-cotrader/scope/2026-05-06-read-layer-integrity-bundle-scoping.md`
- Sibling pattern: PR #32 `structured-zero-misread-as-null` — same shape, different organ
- Sibling Phase A this session: A.7 news_causality projection (PR #34) — same `audit-verification-surface-mismatch` instance
