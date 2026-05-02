# TSLA/IWM Aggressive Bid-Put → Bearish (`small_cap_inverted_put_v1`)

- **Status:** shadow (per ct_detectors)
- **Source file:** `supabase/functions/ct-detector-small-cap-inverted-put/index.ts`
- **DTE class:** all
- **Live config row:** SELECT * FROM ct_detectors WHERE id = 'small_cap_inverted_put_v1'

## Known issue — `is_bid` reliance contradicts global rule

This detector is built on identifying aggressive bid-side puts on TSLA/IWM. Per global rule `feedback_uw_is_ask_bid_never_set.md` and `feedback_direction_inference_repeatedhits_put_inverted.md`, the raw `is_ask`/`is_bid` fields on `ct_flow_alerts` are unreliable across UW alert types — directional inference must always route through `inferDirection()` from `_shared/directionInference.ts`. The current implementation does call `inferDirection()` and gates on `inferred.source === 'aggressive_bid_put'`, but the corpus thesis (commit `5141c31`: "100% of TSLA+IWM winners came from this pattern") was derived from raw-`is_bid` filtering, predating the canonical inference rule. **The math below is documented as the detector's INTENT; the corpus calibration was done against the un-canonical signal and must be re-derived against `inferDirection()` output before promoting beyond shadow.**

## What it sees

TSLA or IWM puts where the aggressor lifted the bid (put seller hitting bid = put buyer aggressive on the bid side). Per-ticker inversion thesis: in TSLA/IWM the bid-aggressive put correlates with put-buying that precedes underlying drops, NOT writing — opposite of the default put-side directional mapping.

## Math

`tickers = ['TSLA', 'IWM']`, `dedupe_min = 60`. Direction interpretation: bid-aggressive put → underlying **bearish** (inverted from default put-side mapping). Horizon 24h. Contract target +50%, invalidation -30%.

## Regime fit

Bearish small-cap regimes — when smart money is buying puts on the small-cap leg of risk-on/risk-off rotation. Calibration TBD.

## False-positive shapes

- `is_bid` unreliability on RepeatedHits-class prints that should route through `inferDirection()` (see Known issue).
- Dealer hedges that fire bid-side without directional conviction.
- Thin TSLA/IWM put activity periods where small samples drift the inversion thesis.

## Demote criteria

Per Q1 thresholds: shadow → trial requires `n ≥ 50` AND `hr_v3 ≥ 0.30`. Currently 0 fires lifetime in last 30d. **Hold shadow indefinitely UNTIL** the `is_bid`/`inferDirection` reliance is reconciled with the corpus calibration AND a graded sample accumulates.

## Calibration history

TBD — never fired in last 30d, revisit when first sample lands. Commits: `5141c31` initial ship (corpus inversion thesis: 14% raw HR, 81/81 winners from this exact pattern), `7d80831` source_flow_ids null fix, `54224d1` target/invalidation on every flag.
