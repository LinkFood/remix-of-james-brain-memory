# Data Freshness Runbook

## Symptom
- Latest row in `ct_flow_alerts` > 10 min old during RTH (should be < 5 min).
- `ct_news_analyses` gap > 30 min during RTH.
- `ct_oi_snapshots` missing for the day (especially the close snapshot).
- `ct_flow_pulse_ticks` has zero/null spot mid-session.
- `/tape` banner says "stale" or specialist context warning organ returns `meta.warning='stale'`.

## What's actually happening

Each table has its own freshness expectation tied to its ingester cron cadence. The Synthesis Layer organs trust their source tables — if the source is stale, the organ surfaces the staleness via `meta.warning`. Consumers see degraded context, not crashes.

Per-table freshness expectations (RTH = 09:30–16:00 ET):

| Table | Expected gap | Cron | Notes |
|---|---|---|---|
| `ct_flow_alerts` | < 5 min RTH | `ct-flow-ingester-perticker-rth */5 13-20 * * 1-5` | Primary firehose |
| `ct_contract_quotes` | < 6 min RTH | `ct-contract-poller */5 RTH` | Per-contract P&L |
| `ct_news_analyses` | < 30 min RTH | `ct-news-ingester` (varies) | News sweep |
| `ct_breaking_news` | < 10 min RTH | `ct-news-ingester` | Severity-ranked |
| `ct_oi_snapshots` | 1× pre-open + 1× close | `ct-oi-snapshot`, `ct-oi-snapshot-close` | Daily |
| `ct_flow_pulse_ticks` | < 6 min RTH | `ct-pulse-capture */5 :30 :35` | Sequenced after `:29` snapshot refresh |
| `ct_specialist_reads` | per-ticker varies | 10 specialist crons | Ticker-keyed |
| `ct_session_embeddings` | 1× per session at 21:30 UTC | `ct-session-analog` | First row was 2026-05-01 |

Load-bearing files:
- Per-ingester edge function (`supabase/functions/ct-<thing>-ingester/`)
- `_shared/uwClient.ts` — write path
- `_shared/eventCoherenceValidator.ts` — surfaces freshness warnings post-Claude

The freshness symptom is downstream of one of three causes: ingester broken (see `uw_pollers.md`), cron broken (see `cron_health.md`), or upstream API silent (UW returned empty, Tavily exhausted, eBird throttled).

## Diagnostic ladder

1. **Latest-row scan across the freshness-critical tables.**
   ```bash
   KEY=$(npx supabase projects api-keys --project-ref rvhyotvklfowklzjahdd | grep service_role | awk '{print $NF}')
   for tbl in ct_flow_alerts ct_contract_quotes ct_news_analyses ct_breaking_news ct_flow_pulse_ticks ct_oi_snapshots; do
     echo "=== $tbl ==="
     curl -s "https://rvhyotvklfowklzjahdd.supabase.co/rest/v1/$tbl?select=created_at&order=created_at.desc&limit=1" \
       -H "Authorization: Bearer $KEY" -H "apikey: $KEY"
   done
   ```

2. **Hourly distribution today vs last week** for the lagging table.
   For `ct_flow_alerts`, use `get_uw_usage_by_hour()` as a proxy. For others, group by `date_trunc('hour', created_at)`.

3. **Trace upstream.** If freshness gap is on `ct_flow_alerts` → goto `uw_pollers.md`. If on `ct_news_analyses` → check Tavily budget (could be exhausted) and `ct-news-ingester` cron health. If on `ct_oi_snapshots` → check `ct-oi-snapshot` deployment status (close snapshot specifically had `last_run_status = none` precedent — verify deployment).

4. **Pulse-capture race.** If `ct_flow_pulse_ticks` shows zeros at the open, see `feedback_pulse_capture_open_race.md` — `ct-spot-snapshot-refresher` must run at `:29`, before `ct-pulse-capture` at `:30 :35`. Verify schedule order.

5. **PostgREST 1000-row cap.** If a backfill or "create-missing" loop seems to stall on a known-large table, see `feedback_postgrest_1000_row_cap.md` — `.limit(8000)` silently caps at 1000. Paginate via `.range(offset, end)`.

## Common causes

- **Poller cron broken.** Most common. Goto `uw_pollers.md`.
- **UW empty response.** Rare; UW returned `[]` for the window. Verify by hitting UW MCP directly with the same params via terminal-me. If genuinely empty upstream, no fix — wait it out, log the gap.
- **Tavily exhausted budget tier.** Monthly cap of 4000. Mid-month exhaust means news ingester gracefully skips. Verify via `ct_tavily_usage_monthly` view (per `budget_views.md`). If exhausted, no fresh news till month rollover.
- **`ct-oi-snapshot-close` not deployed.** Precedent flagged in plan. Verify with `npx supabase functions list | grep oi-snapshot`. If missing, deploy.
- **Pulse-capture spot race at the open.** `feedback_pulse_capture_open_race.md`. Sequence: `:29` snapshot refresh → `:30 :35` pulse capture. Inner-join on `ct_ticker_snapshots.spot` returns NULL otherwise.
- **Signature watcher score race.** `feedback_signature_watcher_score_race.md`. See `detectors.md`.
- **DESC sort starvation.** `feedback_create_query_sort_desc.md` — "create-missing" loops on growing tables MUST sort DESC. ASC + `.limit(N)` freezes the scan window on the oldest N rows. Caught 2026-04-25 — every /tape chip went blank because the grader stopped creating tracks 8 days post-launch.
- **Stale + market-hours refetch.** `feedback_market_hours_refetch_invalidation.md` — frontend hooks gating `refetchInterval` on `isMarketHoursET()` freeze if the page was loaded pre-bell. React Query doesn't re-read the interval at the 9:30 ET transition. Caught 2026-04-29. Fix: a single `useMarketHoursTrigger` at app root invalidating `ct_*` queries on bell-ring.

## Fix steps

For ingester gap → `uw_pollers.md`.

For OI close snapshot missing:
1. `npx supabase functions list | grep oi-snapshot-close`
2. If missing: `npx supabase functions deploy ct-oi-snapshot-close --no-verify-jwt`
3. Verify cron points at it: `SELECT * FROM cron.job WHERE jobname LIKE '%oi-snapshot%'`
4. Wait for next scheduled fire (post-close) and confirm row landed.

For Tavily exhausted: nothing to fix — wait for ET-month rollover. Confirm pause is graceful (no Slack spam) by checking `ct_tavily_alarm_state`.

For DESC-sort starvation: code fix in the offending function. Pattern is `.order('created_at', { ascending: false })`. Audit any "create-missing" loop on growing tables.

## Related

- Tables: `ct_flow_alerts`, `ct_contract_quotes`, `ct_news_analyses`, `ct_breaking_news`, `ct_oi_snapshots`, `ct_flow_pulse_ticks`, `ct_specialist_reads`, `ct_session_embeddings`
- Memory: `feedback_pulse_capture_open_race.md`, `feedback_postgrest_1000_row_cap.md`, `feedback_create_query_sort_desc.md`, `feedback_market_hours_refetch_invalidation.md`, `feedback_signature_watcher_score_race.md`
- Related runbooks: `uw_pollers.md`, `cron_health.md`, `budget_views.md`, `detectors.md`
