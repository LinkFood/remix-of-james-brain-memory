# D2 Phase B — shipped 2026-05-05

**Audit:** `docs/audit/2026-05-05-d2-regime-threshold-recalibration-phase-a.md` (PR #16, merged on `main`).
**Brief:** James 2026-05-05 — all three aggressive paths approved + bundled.
**Reversibility:** every change is a one-row UPDATE / INSERT. Roll back any cell at any time.

## Four changes (all live before this doc was committed)

### 1. NVDA threshold 55 → 50
`PATCH /rest/v1/ct_config?key=eq.specialist.NVDA.wakeup_threshold` value=50, updated_at=2026-05-05T23:47:11.209196+00:00. Description: "NVDA threshold post-1A 55→50 — D2 Phase B per audit p75=52, +5pt margin lifted to 50; doubles event pool. Reversible."

### 2. MSFT threshold 60 → 55
`PATCH ...specialist.MSFT.wakeup_threshold` value=55, updated_at=2026-05-05T23:47:11.417601+00:00. Description: "MSFT threshold 60→55 — D2 Phase B per audit p75=57.5, +5pt margin lifted; was borderline frozen (only 1 read in 4d). Reversible."

### 3. AAPL threshold 60 → 55
`PATCH ...specialist.AAPL.wakeup_threshold` value=55, updated_at=2026-05-05T23:47:11.630662+00:00. Description: "AAPL threshold 60→55 — D2 Phase B per audit p75=60 (zero buffer; preventive); pct_init halved 30.8→13.4 same shape as NVDA. Reversible."

### 4. New warden invariant `specialist_threshold_within_5pts_of_p75`
INSERT into `ct_invariants`. SQL fully captured in the audit doc §5 step 2 + the runbook at `docs/runbooks/specialist_threshold_drift.md`. severity=warn, expected_max=0, runbook_path=`docs/runbooks/specialist_threshold_drift.md`.

Live SQL run immediately after insert returned:
```
metric_value = 5
message = "DRIFT WARN: QQQ:gap=5.0, SPY:gap=0.0, NVDA:gap=-2.0, MSFT:gap=-2.5, META:gap=-4.0"
```

## ⚠️ Open design tension surfaced live

The invariant fires WARN on 5/10 tickers immediately post-D2. The `> -5` boundary means even just-tuned thresholds (NVDA -2, MSFT -2.5) don't fully clear the danger zone.

This is either:
- **Forcing-function as designed** — the warden prompts ongoing re-tuning each regime shift
- **Permanent-yellow trap** per `feedback_warden_threshold_calibration.md` (perma-yellow desensitizes operators)

Surfaced in PR body for James's call. Three corrective paths if perma-yellow turns out to bite:
1. Loosen the boundary (`> -5` → `> -3` or `> 0`)
2. Lower per-ticker thresholds further (NVDA → 47, MSFT → 52)
3. Convert severity from `warn` → `info` so it's visible in dashboards but doesn't Slack

Each is a one-row UPDATE.

## Acceptance criteria (per audit + James's brief)

- [ ] All 3 affected specialists (NVDA, MSFT, AAPL) firing at ≥80% of pre-silence cadence within 2 trading days post-deploy
- [ ] `specialist_threshold_within_5pts_of_p75` invariant either lands green OR has explicit decision on perma-yellow path within 5 trading days
- [ ] No regression in the 7 unchanged tickers (QQQ, SPY, GOOGL, AMZN, META, TSLA, IWM) — verify their fire cadence stays at pre-D2 level
- [ ] C1 measurement window benefits from the 3 specialists rejoining the data set (specialist_recall organ regains representativeness)

## Verification queries

Per-ticker fire counts since D2 deploy:
```bash
SR=$(npx supabase projects api-keys --project-ref rvhyotvklfowklzjahdd | grep service_role | awk '{print $NF}')
curl -s "https://rvhyotvklfowklzjahdd.supabase.co/rest/v1/rpc/run_invariant_query" \
  -X POST -H "Authorization: Bearer $SR" -H "apikey: $SR" -H "Content-Type: application/json" \
  -d '{"p_sql":"SELECT ticker, COUNT(*) FILTER (WHERE skip_reason IS NULL OR skip_reason NOT IN (''no_events'',''cooldown'',''kill_switch'',''daily_cap'')) AS productive, COUNT(*) FILTER (WHERE skip_reason = ''no_events'') AS no_events_count, COUNT(*) AS total FROM ct_specialist_wakeup_log WHERE wakeup_at > timestamp ''2026-05-05T23:47:00Z'' GROUP BY ticker ORDER BY ticker"}'
```

## Don't bundle — separately queued

- **GOOGL/AMZN/META silence audit** — these were in the original ≥40% no_events list per D1 audit but D2's data shows their threshold buffer is already negative. Different cause (volume drop / bimodal distribution / non-scoring upstream). Phase A audit queued.
- **D3 — scoring-function recalibration** — NOT needed for current problem per D2 audit §6. Long-term Sunday-calibration question. Phase A queued separately.
- **dumps + messages orphan audits** — separate diagnose-only Phase A audits queued ahead of the GOOGL/AMZN/META audit.
