# Budget Views Runbook

## Symptom
- UW badge on `/tape` or `/dashboard` drops from a real number (e.g. 100% EXHAUST, 14,200/20k) to a fresh-looking near-zero (e.g. 0.8%, 169/20k) without any actual reset.
- Tavily count vanishes at month boundary — was 257/4000 yesterday, shows 0/4000 this morning.
- Slack EXHAUST alert fires then "recovers" without anything actually changing on the API side.
- The badge resets at UTC midnight (8 PM ET in EDT, 7 PM ET in EST) — that's the tell.

## What's actually happening

Budget views are SQL views over usage tables (`ct_uw_usage`, `ct_tavily_usage`). Two bugs in the original implementation, both hidden by the same pattern: the *display* logic disagrees with the *underlying counter semantics*.

1. **UW server-side counter resets at UTC midnight.** UW's API returns `daily_count` based on its own UTC day. James's ET trading session straddles that midnight. The original `ct_uw_usage_latest` view used `DISTINCT ON (session_date) ORDER BY observed_at DESC` — so any cron firing after UTC midnight (still session 4/30 in ET) wrote a row with the post-reset counter, and the view picked *that* as "the latest". Real day's peak (20,000) got hidden by the post-reset value (169).

2. **Tavily monthly window flipped at UTC midnight on the first.** Original `ct_tavily_usage_monthly` filtered `observed_at >= date_trunc('month', now())`. UTC ticked into May 1; April's 257 credits fell out of scope; badge showed 0.

Fix: migrate both views to use ET boundaries + MAX(daily_count) within the session bucket. Migration `20260501040000_fix_budget_views_utc_rollover.sql` is the canonical patch.

Load-bearing files:
- `supabase/migrations/20260501040000_fix_budget_views_utc_rollover.sql` — the fix
- `supabase/migrations/20260429230000_*` — original Tavily usage table + view
- `~/.claude/projects/-Users-jameschellis/memory/feedback_budget_views_use_et_not_utc.md` — the rule

## Diagnostic ladder

1. **Check the badge value against raw data.**
   ```bash
   KEY=$(npx supabase projects api-keys --project-ref rvhyotvklfowklzjahdd | grep service_role | awk '{print $NF}')
   # UW: max daily_count today (ET session)
   curl -s "https://rvhyotvklfowklzjahdd.supabase.co/rest/v1/ct_uw_usage?select=session_date,daily_count,observed_at&order=observed_at.desc&limit=20" \
     -H "Authorization: Bearer $KEY" -H "apikey: $KEY" | jq
   # Tavily: month-to-date credits
   curl -s "https://rvhyotvklfowklzjahdd.supabase.co/rest/v1/ct_tavily_usage?select=*&order=observed_at.desc&limit=20" \
     -H "Authorization: Bearer $KEY" -H "apikey: $KEY" | jq
   ```
   If raw rows show real consumption but the view returns near-zero: the view is wrong, not the data.

2. **Inspect the view definition.**
   ```sql
   SELECT pg_get_viewdef('public.ct_uw_usage_latest', true);
   SELECT pg_get_viewdef('public.ct_tavily_usage_monthly', true);
   ```
   Look for `date_trunc(..., now())` without an `AT TIME ZONE 'America/New_York'`, or `DISTINCT ON ... ORDER BY observed_at DESC` without a `MAX(daily_count)` aggregation.

3. **Verify ct_config still has the limits.**
   ```sql
   SELECT key, value FROM ct_config
   WHERE key IN ('uw_daily_limit_override', 'tavily_monthly_limit', 'uw_tier');
   ```
   If `uw_daily_limit_override` was nulled or `tavily_monthly_limit` is missing, denominator goes weird.

4. **If still confused: ask James.** Don't patch the view live during RTH — the badge feeds his decision-making.

## Common causes

- **UTC rollover artifact.** The bug class. Read `feedback_budget_views_use_et_not_utc.md`.
- **ct_config tier flipped.** James edited `uw_tier` (`free`→`pro`→`enterprise`) and the view's denominator-lookup didn't pick it up. Verify `uw_daily_limit_override` is set when overriding.
- **`tavily_monthly_limit` missing.** Cron tried to write a usage row, view tried to compute `used / limit`, division returned weird. INSERT the config row.
- **New usage table added without a view.** Someone shipped a fourth API counter (e.g. ElevenLabs) and didn't write the matching `*_latest` / `*_monthly` view. Slack alarm has no source.

## Fix steps

For UTC-rollover regression:
1. Read `feedback_budget_views_use_et_not_utc.md` — the rule pattern.
2. Read migration `20260501040000_fix_budget_views_utc_rollover.sql` — the canonical fix.
3. Write a new migration that drops + recreates the view with:
   - `(date_trunc('<unit>', (now() AT TIME ZONE 'America/New_York')) AT TIME ZONE 'America/New_York')` for boundary timestamps
   - `MAX(daily_count)` over `session_date` for the headline number
   - Live-tail columns (`observed_at`, `minute_remaining`) can come from the latest row, but never the headline counter
4. `npx supabase db push`
5. Verify badge against raw data (step 1 above) before closing.

For new budget views: same rule pattern from day one. Don't ship a view using `date_trunc(..., now())` — UTC at runtime is wrong for any user-facing window.

## Related

- Tables: `ct_uw_usage`, `ct_tavily_usage`, `ct_uw_alarm_state`, `ct_tavily_alarm_state`
- Views: `ct_uw_usage_latest`, `ct_tavily_usage_monthly`
- Config: `ct_config` (`uw_tier`, `uw_daily_limit_override`, `tavily_monthly_limit`)
- Memory: `feedback_budget_views_use_et_not_utc.md`
- Migration: `supabase/migrations/20260501040000_fix_budget_views_utc_rollover.sql`
