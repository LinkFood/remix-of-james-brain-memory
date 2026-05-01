# Co-Trader Monday Ops Playbook

Pre-open verification + at-open watch + bug-pattern catalog. Built 2026-04-26 night before the first portfolio test of 13 detectors.

For terminal-Claude sessions, the same content lives at `~/.claude/projects/-Users-jameschellis/memory/project_co_trader_morning_ops_checklist.md` and auto-loads. This file is for human reading on the go.

---

## Quick reference — at a glance

| When | What |
|------|------|
| **9:00am ET (13:00 UTC) Mon** | First detector cron fires (smart_money_repeat staggered :00, then :01-:04 for d2-d5) |
| **9:30am ET (13:30 UTC) Mon** | Markets open, real flow starts hitting `ct_flow_alerts` |
| **9:45am ET** | Verify all 5 new detectors have fires |
| **4:00pm ET (20:00 UTC) Mon** | Last RTH detector cron fires |
| **4:30pm ET (20:30 UTC) Mon** | EOD summary cron should fire |
| **5:00pm ET (21:00 UTC) Mon** | Edge miner cron should fire |

---

## Pre-open verification

### Step 1 — Open this in a terminal pane:
```bash
bash /tmp/monday_watch.sh
```

Refreshes every 5 min. Shows: per-detector fire deltas vs baseline, UW headroom, cost burn, cron failure count, watermark advancement.

### Step 2 — Quick health check on the site:
- Top-bar **Preflight** chip: should be green or yellow by 9:00am ET (red items are weekend-state and clear once Monday chain fires)
- Top-bar **`$today`** chip: should show $0.00 - $0.50 (just the overnight JAC research run)
- Top-bar **UW** chip: should be `~30%` (historical-quote-backfill ran over the weekend)
- Top-bar **3 alerts** chip: any unresolved health alerts

### Step 3 — Smoke-test one detector via Vault RPC (the auth-correct invocation pattern):
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
A healthy response has `body.ok: true`. A dead deploy returns `404 NOT_FOUND` → `npx supabase functions deploy <name> --no-verify-jwt`.

---

## At/after open

### Detector cron schedule (post-staggering)
```
:00 lane → smart_money_repeat (d1)         [also: cluster, signature-watcher, specialist-dispatcher, etc.]
:01 lane → weekly_atm_voi (d2)
:02 lane → zerodte_opening_call (d3)
:03 lane → zerodte_put_voi_extreme (d4)
:04 lane → small_cap_inverted_put (d5)
:05 lane → smart_money_repeat (d1) again
... every 5 min, 13:00-20:55 UTC, weekdays
```

### Verify each detector fires (10-15 min after open)
```bash
TODAY=$(date -u +%Y-%m-%d)
for d in smart_money_repeat_v1 weekly_atm_voi_v1 zerodte_opening_call_v1 zerodte_put_voi_extreme_v1 small_cap_inverted_put_v1; do
  n=$(curl -s -I "https://rvhyotvklfowklzjahdd.supabase.co/rest/v1/ct_flags?detector_id=eq.$d&created_at=gte.${TODAY}T13:30:00Z&select=id" -H "Authorization: Bearer $SR_KEY" -H "apikey: $SR_KEY" -H "Prefer: count=exact" 2>&1 | grep -i content-range | sed 's|.*/||' | tr -d '\r\n ')
  echo "  $d: ${n:-0} fires"
done
```

**Expected by 9:45am ET:**
- `smart_money_repeat_v1`: should have fires (non-0DTE pattern, broad)
- `weekly_atm_voi_v1`: should have fires (broad)
- `zerodte_opening_call_v1`: may have fires if any 0DTE call flow develops
- `zerodte_put_voi_extreme_v1`: less likely early, more likely later in day
- `small_cap_inverted_put_v1`: only fires on TSLA/IWM put-bid

If ANY shows 0 fires by 10am AND others have fires → likely bug, investigate.

### Watch site at open
- `/alarms` — filter chip by detector_id for each new detector
- `/health` — cron table, all `*-rth` should show last_run < 5 min old
- `/tape` — flow ingest visible, charts populating
- Top-bar `$today` cost — should tick up
- Top-bar UW chip — should climb

---

## Common bug patterns

10 known patterns are documented. See `~/.claude/projects/-Users-jameschellis/memory/project_co_trader_morning_ops_checklist.md` for the full catalog with diagnosis + fix for each. Quick reference list:

1. Detector fires zero with no error → watermark didn't advance
2. is_ask/is_bid silent failure → use `inferDirection` instead
3. 404 NOT_FOUND on Vault RPC invoke → re-deploy
4. PostgREST 1000-row cap → paginate via `.range()`
5. DESC sort starvation → use DESC for create-missing loops
6. Cron-failure noise → bulk-resolve Sunday-only stale entries
7. Cost indicator stuck → refresh page to reconnect realtime
8. Scan-limit blowout → bump SCAN_LIMIT or shorten cron interval
9. Slack noise on shadow detector → check `signature_alarm_slack_enabled = false`
10. Direct curl to edge function returns Unauthorized → use Vault RPC pattern

---

## Top-3 risks for first-portfolio Monday (2026-04-27)

1. **9:00am ET cron storm** — staggered the 5 new detectors :00-:04. If pool still saturates Monday, stagger the existing 3 detectors + flow-pulse-capture on Tuesday.

2. **5 new detector first-ever live fire** — verify each by 9:45am ET. Any zero-fire while others fire = predicate bug.

3. **Historical-quote-backfill UW spike** — runs weekend-only (`*/30 * * * 0,6`), should be quiet Monday. Verify UW usage doesn't have unexpected spikes at 9:00am.

---

## End-of-day verification (after 4:00pm ET)

```bash
TODAY=$(date -u +%Y-%m-%d)

# Total fires today
for d in signature_v1 cluster_default cluster_slow_stacker whale_v1 unusual_oi_v1 pair_qqq_iwm_v1 smart_money_repeat_v1 weekly_atm_voi_v1 zerodte_opening_call_v1 zerodte_put_voi_extreme_v1 small_cap_inverted_put_v1; do
  n=$(curl -s -I "https://rvhyotvklfowklzjahdd.supabase.co/rest/v1/ct_flags?detector_id=eq.$d&created_at=gte.${TODAY}T13:30:00Z&select=id" -H "Authorization: Bearer $SR_KEY" -H "apikey: $SR_KEY" -H "Prefer: count=exact" 2>&1 | grep -i content-range | sed 's|.*/||' | tr -d '\r\n ')
  echo "  $d: ${n:-0}"
done

# EOD summary
curl -s "https://rvhyotvklfowklzjahdd.supabase.co/rest/v1/ct_eod_summaries?session_date=eq.${TODAY}&select=session_date,id" -H "Authorization: Bearer $SR_KEY" -H "apikey: $SR_KEY"

# Total cost today
curl -s "https://rvhyotvklfowklzjahdd.supabase.co/rest/v1/ct_claude_usage?created_at=gte.${TODAY}T00:00:00Z&select=cost_usd" -H "Authorization: Bearer $SR_KEY" -H "apikey: $SR_KEY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'Total: \${sum((r.get(\"cost_usd\") or 0) for r in d):.2f} ({len(d)} calls)')"
```

---

## After Monday: capture the surprises

If something unexpected happened (good OR bad), append it to the memory checklist under "Bug patterns" with: the smell, the cause, the fix. The catalog gets better every session.

---

## File map

- `/tmp/baseline_pre_monday.json` — pre-open snapshot (captured 2026-04-26 21:33 UTC)
- `/tmp/monday_watch.sh` — live ops monitor (5-min refresh)
- `~/.claude/projects/-Users-jameschellis/memory/project_co_trader_morning_ops_checklist.md` — full memory version (auto-loads in Claude sessions)
- `supabase/migrations/20260428001000_stagger_new_detectors.sql` — staggers 5 new detectors :00-:04
- `supabase/functions/_shared/{detectorRegistry,detectorState,directionInference}.ts` — detector framework
