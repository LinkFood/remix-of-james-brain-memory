# UW Pollers Runbook

## Symptom
- `ct_uw_usage` hourly count drops to zero mid-day during RTH.
- `ct_flow_alerts` not getting new rows; `/tape` goes stale.
- Per-ticker drill panels show "no recent activity" on tickers that should be active.
- Specialists complain "no fresh flow" via warning row in their reads.
- Contract poller (`ct-contract-poller`) hasn't written a `ct_contract_quotes` row in > 10 min during RTH.

## What's actually happening

UW MCP is **write-path only** (Synthesis Layer rule D4). Ingester crons hit UW via shared HTTP + MCP wrappers, write to per-purpose tables, and post telemetry to `ct_uw_usage`. Consumers never call UW at runtime — they read through `buildClaudeContext`. So a consumer outage is downstream of an ingester outage.

The ingester family:
- `ct-flow-ingester-perticker-rth` (cron `*/5 13-20 * * 1-5`) → `ct_flow_alerts` — primary firehose
- `ct-contract-poller` (every 5 min RTH) → `ct_contract_quotes` (joined back to `ct_contract_tracks`)
- `ct-oi-snapshot` / `ct-oi-snapshot-close` → `ct_oi_snapshots`
- `ct-news-ingester` → `ct_news_analyses` + `ct_breaking_news`
- `ct-pulse-capture` (every 5 min RTH at `:30 :35`) → `ct_flow_pulse_ticks`
- `ct-vix-ingester`, `ct-greek-flow-ingester`, `ct-spot-snapshot-refresher` (sequenced before pulse at `:29`)

Load-bearing files:
- `supabase/functions/_shared/uwClient.ts` — central MCP wrapper, 5-min isolate cache, kill-switch via `ct_config.uw_enabled`
- `supabase/functions/_shared/uwUsageTracking.ts` — telemetry write to `ct_uw_usage`
- Per-ingester edge function: `supabase/functions/ct-flow-ingester-perticker-rth/`, etc.

Two failure modes hide as the same symptom: function 404 (cron "succeeded" because pg_cron only checks the SQL, not the HTTP response — see `cron_health.md`) and pg_net timeout (function returns 200 in slow path, but pg_cron's net.http_post resolves async without `timeout_milliseconds` set). Both look like "ingester silently stopped" until you check the actual function logs.

## Diagnostic ladder

1. **Hourly distribution: today vs last week.**
   ```bash
   KEY=$(npx supabase projects api-keys --project-ref rvhyotvklfowklzjahdd | grep service_role | awk '{print $NF}')
   curl -s "https://rvhyotvklfowklzjahdd.supabase.co/rest/v1/rpc/get_uw_usage_by_hour" \
     -H "Authorization: Bearer $KEY" -H "apikey: $KEY" \
     -H "Content-Type: application/json" -d '{}' | jq
   ```
   If today's hour-N is zero but week-prior hour-N shows a typical band — that's the gap window.

2. **Cron status across the ingester family.**
   ```sql
   SELECT * FROM get_cron_status() WHERE jobname LIKE 'ct-%-ingester%' OR jobname LIKE 'ct-%-poller%';
   ```
   Look for `last_run_status = 'failed'`, `last_run_status = 'never'`, or `last_run_at` older than the schedule expects.

3. **Hit the function manually via vault-stored service role.**
   Use the SQL pattern from `_shared/auth.ts` smoke pattern. If function returns 404 → not deployed (deploy with `npx supabase functions deploy <name> --no-verify-jwt`). If it returns 5xx → check edge function logs. If it returns 200 with `processed: 0` → upstream UW issue or watchlist filter.

4. **UW kill-switch and budget exhaust.**
   ```sql
   SELECT key, value FROM ct_config WHERE key IN ('uw_enabled', 'uw_tier', 'uw_daily_limit_override');
   SELECT MAX(daily_count) FROM ct_uw_usage
   WHERE session_date = (now() AT TIME ZONE 'America/New_York')::date;
   ```
   Budget exhaust triggers graceful skip in `uwClient.ts` (not a crash) — symptom looks identical to "function died".

5. **Escalate to James** if all four pass and rows still aren't landing. Do not attempt UW API key rotation without his explicit go.

## Common causes

- **pg_net timeout missing.** The cron's `net.http_post` call lacks `timeout_milliseconds := 60000`. Some ingesters take 30-50s; without an explicit timeout, pg_net silently aborts. Fix: add `timeout_milliseconds := 60000` to the cron body, repush the schedule.
- **Function 404 (deployment missing).** `ct-session-analog` precedent (2026-04-30): cron fired into nothing for weeks, pg_cron showed "succeeded". Always verify function was actually deployed via `npx supabase functions list` after any rename or new function.
- **UW API key rotated.** `uwClient.ts` reads from env var; rotation requires `npx supabase secrets set UW_API_KEY=<new>` then redeploy every UW-importing function.
- **Watchlist filter excluded a ticker.** `ct_config.watcher.watchlist` defines the universe. Per `feedback_watchlist_filter_default.md`, every per-ticker poller must filter by it. If James added a new ticker but didn't restart the cron, polling won't include it until next deploy.
- **Daily budget exhaust.** Graceful skip, not crash. Verify against `MAX(daily_count)` per session_date (see `budget_views.md`).
- **Pulse-capture / spot-snapshot race.** Per `feedback_pulse_capture_open_race.md`, if `ct-spot-snapshot-refresher` fires after `ct-pulse-capture` at the open, FlowPulse writes zeros. Sequence: snapshot at `:29` < pulse at `:30 :35`.

## Fix steps

Triage by which family stopped:
- Flow ingester only → start at step 3 (manual hit). Most often pg_net timeout or function 404.
- All ingesters at once → check `uw_enabled` flag and budget exhaust first (step 4). One config flip kills everything.
- One ticker only → watchlist filter or per-ticker stale-state. Log into the function and check `tickers` array.

For all fixes: after deploying or repushing cron, watch `ct_uw_usage` for 10 min to confirm rows resume landing.

## Related

- Tables: `ct_flow_alerts`, `ct_contract_quotes`, `ct_oi_snapshots`, `ct_news_analyses`, `ct_flow_pulse_ticks`, `ct_uw_usage`
- Shared: `supabase/functions/_shared/uwClient.ts`, `_shared/uwUsageTracking.ts`
- Config: `ct_config` (`uw_enabled`, `uw_tier`, `uw_daily_limit_override`, `watcher.watchlist`)
- RPC: `get_cron_status()`, `get_uw_usage_by_hour()`
- Memory: `feedback_watchlist_filter_default.md`, `feedback_pulse_capture_open_race.md`, `feedback_weekend_for_uw_heavy_work.md`
- Related runbooks: `cron_health.md`, `data_freshness.md`, `budget_views.md`
