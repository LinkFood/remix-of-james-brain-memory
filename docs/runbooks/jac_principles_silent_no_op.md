# Runbook — `jac_principles_growing_weekly` warden invariant

**Triggered by:** the `jac_principles_growing_weekly` warden invariant going RED (warn severity). Fires when `jac_principles` has zero rows inserted/updated in the last 8 days.

**Born from:** 2026-05-05 audit + fix of `distill-principles` silent no-op. The function had been writing to `.from('brain_principles')` since 2026-02-28 (~10 weeks) against a table that was never created. PostgREST silently returned `PGRST205` for every write; cron saw HTTP 200; no alert fired because no invariant existed on principles-table growth.

## What this means

The `distill-principles` cron runs every Sunday 03:00 UTC. It pulls recent `jac_reflections` and Claude-distills them into structured principles. If the warden fires this invariant, one of these happened:

1. The cron is registered but isn't actually firing (pg_cron silent registration failure — see `feedback_pg_cron_schedule_idempotency.md`).
2. The cron fires but the function is hitting an error before write.
3. The function is writing to the wrong table again (regression of the 2026-05-05 brain_principles bug).
4. There are no recent `jac_reflections` to distill from.

## Diagnosis (in order)

### 1. Confirm the cron is scheduled and recent fires

```bash
SR=$(npx supabase projects api-keys --project-ref rvhyotvklfowklzjahdd | grep service_role | awk '{print $NF}')
curl -s "https://rvhyotvklfowklzjahdd.supabase.co/rest/v1/rpc/get_cron_job_status" \
  -X POST -H "Authorization: Bearer $SR" -H "apikey: $SR" -H "Content-Type: application/json" -d '{}' \
  | python3 -c "
import json, sys
for r in json.load(sys.stdin):
    if 'distill' in str(r.get('jobname','')).lower():
        print(r)"
```

If no `distill-principles` job is shown → re-run the original schedule migration.

### 2. Check which table the function currently writes to

The 2026-05-05 fix renamed all 4 sites in `supabase/functions/distill-principles/index.ts` from `brain_principles` → `jac_principles`. Verify the current code:

```bash
grep -n "from('brain_principles')\|from('jac_principles')" supabase/functions/distill-principles/index.ts
```

Expected: 4 matches, all to `jac_principles`. If any match `brain_principles` again → regression. The CI script `scripts/check_supabase_table_refs.sh` should have caught this; if it didn't, the script's allowlist may have grown stale.

### 3. Check `jac_reflections` source pool

```bash
curl -s "https://rvhyotvklfowklzjahdd.supabase.co/rest/v1/jac_reflections?select=id&order=created_at.desc&limit=5&created_at=gte.$(date -u -v-30d +%Y-%m-%dT00:00:00Z)" \
  -H "Authorization: Bearer $SR" -H "apikey: $SR" | python3 -m json.tool
```

If empty / very few → the distiller has nothing to work with; the silence is real, not a bug. Check `jac-reflect` and `ct-reflect-to-jac` are firing.

### 4. Manually fire the function

Use the Supabase Dashboard's function "Invoke" button on `distill-principles`. Direct curl to `/functions/v1/distill-principles` is HMAC-gated for the service-role key (see `feedback_service_role_key_rotation.md`); use the dashboard UI or wrap a one-off SQL `net.http_post` call with the vault service-role key.

After invocation, verify a new `jac_principles` row landed:

```bash
curl -s "https://rvhyotvklfowklzjahdd.supabase.co/rest/v1/jac_principles?select=id,principle,confidence,last_validated&order=last_validated.desc&limit=5" \
  -H "Authorization: Bearer $SR" -H "apikey: $SR" | python3 -m json.tool
```

## Class-kill mechanism

`scripts/check_supabase_table_refs.sh` runs in CI on push/PR to main. Greps every `.from('<TABLE>')` reference in `supabase/functions/`, cross-checks against the live PostgREST schema, fails the build on any orphan. Allowlist at `scripts/check_supabase_table_refs.allowlist` for known false-positives.

If this runbook gets triggered AND the CI script is passing, the issue is operational (cron / source data), not a code-reference orphan.

## Why this runbook exists

Born from the 2026-05-05 audit that traced JAC's missing principles layer to a 4-month silent typo. Three nested silent-failures:

1. `.from('brain_principles')` → PostgREST `PGRST205` → caller catches + `console.warn`s, returns benign result
2. `distill-principles` returns `ok` regardless → cron sees HTTP 200
3. No warden invariant on `jac_principles` row growth → no alert

This invariant + the CI script + this runbook close all three.

## Linked artifacts
- Phase A audit: `docs/audit/2026-05-05-distill-principles-silent-noop-phase-a.md`
- Companion warden-gap memory: `feedback_warden_count_distinct_misses_single_entity_failure.md`
- Class-kill CI script: `scripts/check_supabase_table_refs.sh`
- Sibling runbook: `docs/runbooks/specialist_per_ticker_freeze.md` (same MIN-freshness pattern)
