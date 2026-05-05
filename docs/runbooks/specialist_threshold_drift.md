# Runbook — `specialist_threshold_within_5pts_of_p75` warden invariant

**Triggered by:** the `specialist_threshold_within_5pts_of_p75` warden invariant going RED (warn severity). Fires whenever any of the 10 watchlist specialists has `wakeup_threshold − trailing_5d_p75 > -5` (i.e., threshold is less than 5pts below the 75th-percentile of recent scored events).

**Born from:** D2 Phase A audit 2026-05-05 (`docs/audit/2026-05-05-d2-regime-threshold-recalibration-phase-a.md`). The structural class kill of silent specialist starvation. Without this invariant, every regime drift triggers a fresh threshold-patch cycle and the silence-class never gets killed.

## What this means

The specialist's wakeup threshold has drifted into the "danger zone" relative to recent score distribution. One of three is true:

1. **Score distribution dropped** — fewer events qualify; specialist is going silent (or about to).
2. **Threshold was raised** above the regime — recently or by misconfiguration.
3. **Just-tuned baseline** — D2 Phase B (2026-05-05) shipped per-ticker thresholds that landed in the danger zone by design (audit's stated 5pt margin from the OLD threshold, not from the NEW p75). Permanent-yellow possibility flagged in PR — see calibration note below.

## Diagnosis

### 1. Identify which ticker(s) are in the danger zone

```bash
SR=$(npx supabase projects api-keys --project-ref rvhyotvklfowklzjahdd | grep service_role | awk '{print $NF}')
SUPA="https://rvhyotvklfowklzjahdd.supabase.co"
curl -s "$SUPA/rest/v1/ct_invariants?name=eq.specialist_threshold_within_5pts_of_p75&select=last_value,last_run_at" \
  -H "Authorization: Bearer $SR" -H "apikey: $SR" | python3 -m json.tool
```

The invariant's `message` field (in `ct_invariant_log` recent rows) names the offending tickers + their gap.

### 2. Cross-check against `ct_specialist_wakeup_log`

For each flagged ticker:

```bash
TICKER=NVDA
curl -s "$SUPA/rest/v1/ct_specialist_wakeup_log?ticker=eq.$TICKER&order=wakeup_at.desc&limit=20&select=wakeup_at,skip_reason,parse_ok,current_read_present" \
  -H "Authorization: Bearer $SR" -H "apikey: $SR" | python3 -m json.tool
```

If `skip_reason='no_events'` is the dominant pattern → the threshold has crossed below where events score; specialist is going silent. Lower threshold per D2's pattern.

If `skip_reason` is mixed and reads are still landing → the invariant is firing pre-emptively; threshold is in the buffer zone but specialist is still productive. Watch but don't necessarily act.

### 3. Inspect the actual score distribution

Use the `run_invariant_query` RPC with a percentile query against `ct_scored_flow` filtered to the last 5 days for the watchlist tickers; compare per-ticker p50/p75/p90 against the current `ct_config.specialist.<TICKER>.wakeup_threshold` value.

### 4. Decide: lower threshold, or accept buffer-zone state?

Per D2 audit's safety margin convention — threshold should be at LEAST 5pts below p75 to fully clear this invariant. Each lowering is a `ct_config` UPDATE via REST PATCH.

Don't drop below `min_value` (per `ct_config` row, typically 40).

## ⚠️ Calibration note — known design tension (live as of 2026-05-05)

The D2 Phase B PR surfaced that this invariant fires WARN on 5/10 tickers immediately post-deploy: QQQ (gap +5), SPY (0), NVDA (-2), MSFT (-2.5), META (-4). The `> -5` boundary chosen by the audit means "anything not fully clear of the buffer zone fires." Two interpretations:

1. **Forcing-function** (audit's stated intent): the warden becomes the prompt for ongoing re-tuning every time the regime shifts.
2. **Permanent-yellow** (per `feedback_warden_threshold_calibration.md`): a perma-yellow invariant desensitizes the warden — operators stop reading the alerts.

If the invariant has been WARN for 5+ consecutive runs without anyone acting, that's the perma-yellow trap. Two corrective options:
- **Loosen boundary:** change `(t.thr - s.p75) > -5` to `> -3` or `> 0` (only fires when truly at/above p75).
- **Aggressive thresholds:** lower per-ticker thresholds further so they're properly buffered (e.g., NVDA → 47, MSFT → 52).

Either is a one-row UPDATE to `ct_invariants` or `ct_config`. Don't leave the invariant permanently yellow — adjust within 5 trading days if it doesn't naturally settle as a result of regime shifts.

## Linked artifacts
- D2 Phase A audit: `docs/audit/2026-05-05-d2-regime-threshold-recalibration-phase-a.md`
- Calibration lesson memory: `feedback_warden_threshold_calibration.md`
- Sibling runbook: `docs/runbooks/specialist_per_ticker_freeze.md`
- Sibling runbook: `docs/runbooks/jac_principles_silent_no_op.md`
