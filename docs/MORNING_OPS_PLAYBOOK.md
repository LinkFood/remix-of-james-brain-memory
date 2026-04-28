# Co-Trader Morning Ops Playbook

**Last major update: 2026-04-27 evening — first portfolio test + 15 live fixes shipped.**

For terminal-Claude sessions, the same content auto-loads from `~/.claude/projects/-Users-jameschellis/memory/project_co_trader_morning_ops_checklist.md`. This file is the human-readable repo-tracked version.

---

## What changed 2026-04-27 (read first)

15 fixes shipped during Monday's first portfolio test. The architecture you'll see Tuesday morning is meaningfully different from Monday's — read this section before assuming anything works the way it did Friday.

### Cron schedule changes

| Function | Old schedule | New schedule | Why |
|----------|--------------|--------------|-----|
| `ct-flow-ingester-perticker-rth` | (was single `*/3 10-22 * * 1-5`) | `*/5 13-20 * * 1-5` (per-ticker only) | UW budget — split out the heavy market-wide pass |
| `ct-flow-ingester-perticker-offrth` | — | `*/15 10-12,21-22 * * 1-5` (per-ticker only) | Off-RTH cadence drop |
| `ct-flow-ingester-marketwide` | — | `0,30 13-20 * * 1-5` (full pass) | Market-wide every 30min instead of every 3min |
| `ct-print-grader-rth` | (was single `*/30 * * * *`) | `*/10 13-20 * * 1-5` | P/L coverage was sawtoothing 75↔97% every 30min |
| `ct-print-grader-offhours` | — | `0,30 0-12,21-23 * * *` | Off-hours lane for overnight track maturation |

### Function logic changes

- **`ct-flow-ingester`**: WATCHLIST filter at insertion — drops off-watchlist alerts (77% of writes Monday) before write. `ct_flow_alerts` is now watchlist-only.
- **`ct-eod-summary`**: Now reads BOTH `ct_print_tracks` (Pass 2) AND `ct_contract_tracks` (Pass 3). Was missing all contract-axis WIN/LOSS.
- **All 7 new shadow detectors**: Bigint type bug fixed (`source_flow_ids: null` instead of `[a.alert_id]`). Was silently failing every flag insert.
- **`ct-cron-health-check`**: Now schedule-aware. Handles weekday-daily 3x cadence + hour-list-gap schedules. Stopped flooding Slack with 13 false positives every Monday.
- **`ct-slack-push-flag`**: `resolveTicker()` helper — falls back to instrument or OCC parse when specialist_ticker is null. No more "null BULLISH..." prefix.

### Frontend changes

- **`useMacroSparklines`, `MacroBanner`, `useDarkPoolChart`**: Per-ticker Promise.all fan-out instead of `.in('ticker', TICKERS)`. PostgREST 1000-row cap was leaving 7-8 of 10 tickers blank.
- **`MacroTile` sparklines**: Normalize to %-from-open with 0% reference line. Was rendering raw price scale (lines hugged the bottom).
- **`/flags` page**: Date filter (Today / 7d / 30d / All), defaults to Today.
- **FlowPulse "Today" window**: 30-min minimum floor. Was returning 0-15 minutes after open and rendering all-zeros.

---

## Quick reference — at a glance

| When | What |
|------|------|
| **9:00am ET (13:00 UTC) Mon-Fri** | First detector cron fires (5 staggered :00-:04 lanes) |
| **9:30am ET (13:30 UTC) Mon-Fri** | Markets open, real flow starts hitting `ct_flow_alerts` |
| **9:35am ET** | Verify all 5 new detectors have fires + watchlist filter is 100% |
| **10:00am ET** | P/L coverage ≥90%, no cron-degraded Slack noise |
| **4:00pm ET (20:00 UTC)** | Last RTH detector cron fires |
| **4:30pm ET (20:30 UTC)** | EOD summary cron fires (with new contract-tracks data) |
| **5:00pm ET (21:00 UTC)** | Edge miner cron should fire |

---

## Tuesday morning verification checklist

Use the watch script: `bash scripts/morning_watch.sh` from the repo root (5-min refresh, knows new architecture).

**At 9:30 ET (open)**:
- [ ] /tape "ALL" view shows ONLY watchlist tickers (no INTC/AMD/etc.)
- [ ] All 10 ticker chip sparklines populate immediately (was 3/10 Monday)
- [ ] First flow alert hits ct_flow_alerts within ~1 min of open
- [ ] Slack pushes don't start with "null"
- [ ] Sparklines show direction (NVDA/TSLA visible slopes, not flat-at-bottom)

**By 10:00 ET (30 min in)**:
- [ ] P/L coverage on /tape ≥90%
- [ ] No 13-cron-degraded Slack noise
- [ ] Detector flag count: signature_v1 + at least one new detector firing

**By 11:00 ET**:
- [ ] UW usage ≤ 35% (was at 45% by this time Monday)
- [ ] At least 1-2 high-score detector flags

**By 4:00 ET (close)**:
- [ ] UW close ≤ 50% (was 100% Monday)
- [ ] No `ct-flow-ingester` cron failures
- [ ] `ct_flow_alerts` watchlist-purity 100%

**By 4:31 ET (after EOD)**:
- [ ] EOD Slack push lands with NON-ZERO `tracks realized` count
- [ ] Sonnet narrative references contract-axis WIN/LOSS

---

## Pre-open verification (run anytime after 8 AM ET)

### Step 1 — open this in a terminal pane:
```bash
bash scripts/morning_watch.sh   # from repo root
```

Refreshes every 5 min. Shows: per-detector flag counts, UW headroom, cost burn, cron failure count, watchlist purity, Slack quality, watermark advancement.

### Step 2 — quick health check on the site:
- Top-bar **Preflight** chip: should be green or yellow by 9:00am ET
- Top-bar **`$today`** chip: should show $0.00 - $0.50 (just overnight JAC research)
- Top-bar **UW** chip: should be `~5-10%` (much lower than yesterday's 30% — overnight backfill ran but didn't blow budget)
- Top-bar **alerts** chip: any unresolved health alerts (likely 1-2 max)

### Step 3 — smoke-test one detector via Vault RPC:
```bash
SR_KEY=$(npx supabase projects api-keys --project-ref rvhyotvklfowklzjahdd 2>/dev/null | grep service_role | awk '{print $NF}')

RID=$(curl -s -X POST "https://rvhyotvklfowklzjahdd.supabase.co/rest/v1/rpc/invoke_edge_function" \
  -H "Authorization: Bearer $SR_KEY" -H "apikey: $SR_KEY" -H "Content-Type: application/json" \
  -d '{"function_name":"ct-detector-whale","body":{}}')
echo "request_id=$RID"
sleep 4

curl -s "https://rvhyotvklfowklzjahdd.supabase.co/rest/v1/rpc/get_backtest_response" \
  -H "Authorization: Bearer $SR_KEY" -H "apikey: $SR_KEY" -H "Content-Type: application/json" \
  -d "{\"req_id\":$RID}" | python3 -m json.tool
```

A healthy response has `body.ok: true`. A 404 → `npx supabase functions deploy <name> --no-verify-jwt`.

---

## Bug pattern catalog

15 known patterns documented. See `~/.claude/projects/-Users-jameschellis/memory/project_co_trader_morning_ops_checklist.md` for the full catalog with diagnosis + fix for each. Quick reference list:

1. Detector fires zero with no error → silent watermark stall
2. is_ask/is_bid silent failure → use `inferDirection()`
3. 404 NOT_FOUND on Vault RPC invoke → re-deploy
4. PostgREST 1000-row cap → paginate or fan-out
5. DESC sort starvation → use DESC for create-missing loops
6. Cron-failure noise → schedule-aware health check (FIXED 2026-04-27)
7. Cost indicator stuck → refresh page
8. Scan-limit blowout → bump SCAN_LIMIT
9. Slack noise on shadow detector → check config flag
10. Direct curl to edge function → use Vault RPC pattern
11. **Bigint type mismatch on detector flag insert** (NEW — FIXED 2026-04-27)
12. **EOD summary undercounting realized tracks** (NEW — FIXED 2026-04-27)
13. **UW post-close burn** (NEW — FIXED 2026-04-27)
14. **Off-watchlist data ingest waste** (NEW — FIXED 2026-04-27)
15. **Sparklines render only some tickers** (NEW — FIXED 2026-04-27)

---

## After Tuesday: capture surprises

If something unexpected happens (good OR bad), append it to "Bug pattern catalog" in `~/.claude/projects/-Users-jameschellis/memory/project_co_trader_morning_ops_checklist.md` with: the smell, the cause, the fix. The catalog gets better every session.

---

## File map

- `scripts/morning_watch.sh` — live ops monitor (5min refresh) — committed to repo so it survives terminal restart
- `~/.claude/projects/-Users-jameschellis/memory/project_co_trader_morning_ops_checklist.md` — full memory version (auto-loads in Claude sessions)
- `docs/MONDAY_OPEN_PUNCH_LIST.md` — punch list with completed + pending items
- `supabase/migrations/20260427150000_grader_cron_faster_rth.sql` — grader cron split
- `supabase/migrations/20260427233000_throttle_flow_ingester_uw_budget.sql` — initial flow-ingester throttle
- `supabase/migrations/20260427234500_split_market_wide_vs_per_ticker.sql` — final flow-ingester split
- `supabase/functions/ct-flow-ingester/index.ts` — WATCHLIST filter at insertion + per_ticker_only flag
- `supabase/functions/ct-eod-summary/index.ts` — contract-tracks merge
- `supabase/functions/_shared/{detectorRegistry,detectorState,directionInference}.ts` — detector framework
