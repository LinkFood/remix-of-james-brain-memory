# B-3 — Post-deploy synthetic probe (Phase A diagnose-only design doc)

**Date:** 2026-05-06 (~15:20 ET).
**Trigger:** Pairs with B-4 (PR #44, just shipped — runtime freshness warden). Class kill B-3 = post-deploy synthetic probe runtime defense at deploy time, ~30s detection latency for today's P0 archetype.
**Scope:** diagnose-only. Phase B implementation queued for explicit per-PR approval next session.

---

## TL;DR

**Recommended Phase B implementation: dedicated edge function `ct-deploy-probe` invoked by CI step after deploy.**

The probe function runs inside Supabase with vault key access; CI calls it via REST + service-role JWT. CI gets aggregated probe result and fails the workflow if any non-200 / no-telemetry / timeout. Detection latency: ~30 sec post-deploy.

**Probe scope: 9 RTH-frequent brain consumers** (mirroring B-4's coverage) for v1. Other consumers added incrementally as Phase B iterates.

**Per-function probe config:** YAML at `supabase/functions/_probe-config.yaml`. Each function declares: minimal valid payload (defaults to `{}`), success criteria (HTTP 200 + telemetry row in 30s window default), per-function overrides for special cases.

**Failure-mode dispatch** per PR #37's classification:
- HTTP 401 → auth issue (today's P0 shape) → fail CI immediately
- HTTP 500 → function code error → fail CI
- HTTP 200 + no telemetry → silent-no-op-write class → fail CI elevated
- Timeout → cold-start or non-response → retry once, then fail
- HTTP 200 + telemetry → PASS

---

## Step 1 — Verify-the-warden's-own-framing applied to ship's own design

Three checks before locking the design:

### (a) Cross-reference auto-discover output (PR #42) for consumer set

Per PR #42's import-graph: 18 brain consumers import `_shared/claudeReadSurface.ts`. B-4 covers 9 RTH-frequent. **B-3 v1 should match B-4's 9-consumer scope** so build-time + deploy-time + runtime-fast + runtime-slow defenses all share the same target set.

The 9 RTH-frequent consumers (per B-4):
```
ct-tape-reader               ct-watcher              ct-curiosity
ct-news-sweep                ct-hypothesis-health-check
ct-hypothesis-proposer       ct-alert-post-mortem    ct-self-grader
ct-daily-brief
```

Phase B implementation can extend to the 9 event-driven consumers later, but they need different probe semantics (no telemetry within 30s expected since they fire on triggers). v1 covers the RTH-frequent set.

### (b) Confirm RPC access pattern works for the 9 consumers' invocation shapes

Empirical probe shape per `serve(async (req) => {...})` inspection:

```typescript
// All 9 follow this pattern:
serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  if (!isServiceRoleRequest(req)) return new Response('Unauthorized', { status: 401 });
  const body = await req.json().catch(() => ({}));
  // ... function-specific logic ...
});
```

**All 9 accept empty `{}` body** with `.catch(() => ({}))` default. **Auth via `isServiceRoleRequest` requires `Authorization: Bearer <vault SERVICE_ROLE_KEY>`** — NOT the CLI key (per this morning's auth investigation, instance #11).

**The probe MUST run with vault key access**, not CI service-role key. CI access token doesn't authenticate function endpoints (verified empirically this morning).

**Implication:** the probe is an edge function or RPC with vault read access. Cannot be a CI shell script with curl + CI's service_role key.

### (c) Confirm existing post-deploy state remains zero-coverage

Per PR #37 Phase A: zero existing automated post-deploy verification. `scripts/linkjac_cotrader_watch.sh` is operator-driven, not deploy-triggered. Confirmed unchanged. No conflict / no overlap with B-3.

---

## Step 2 — Probe design

### Approach: dedicated `ct-deploy-probe` edge function

```
1. CI's deploy step (post-B-1, post-B-2) succeeds
2. CI's NEW "Post-deploy probe" step:
   - HTTP POST to /functions/v1/ct-deploy-probe with the just-deployed function list
   - ct-deploy-probe runs inside Supabase, has vault key access
   - For each input function name: send HTTP POST to /functions/v1/<fn> with vault key + minimal payload
   - Wait N seconds (default 30)
   - Query ct_brain_telemetry for telemetry row from <fn>'s consumer_name within window
   - Aggregate per-function results
   - Return JSON: { results: [{function, http_status, telemetry_landed, latency_ms, error?}] }
3. CI parses result. Any failure → step fails (CI exits 1).
```

### Why edge function, not CI shell script

- **Auth pivot:** vault key access requires running inside Supabase. CI's service_role key (or SUPABASE_ACCESS_TOKEN) doesn't authenticate `/functions/v1/*` endpoints (empirically verified instance #11).
- **Shared probe logic:** future probe extensions (per-function payload variants, timing histograms, slack alerts) live in one place.
- **Reusable from cron:** the same probe RPC can be invoked from cron for periodic fleet health checks, not just at deploy.

### Why not RPC (SQL function) with `net.http_post`

Considered: a SECURITY DEFINER RPC that uses `vault.decrypted_secrets` + `net.http_post` to invoke functions. Rejected because:
- `net.http_post` is async — returns request_id, response in `net._http_response` after delay. Polling pattern is awkward.
- Edge function is more flexible for telemetry verification (JOIN ct_brain_telemetry directly).
- Edge function can return aggregated structured response; SQL can too but verbosely.

### Per-function probe config

`supabase/functions/_probe-config.yaml` (Phase B file):

```yaml
# Per-function probe configuration.
# Each function declares minimal probe payload + success criteria.
# Defaults: payload={}, expect_telemetry_row=true, wait_seconds=30.

functions:
  ct-tape-reader:
    payload: { "trigger_kind": "scheduled", "window_minutes": 10 }
    expect_telemetry_consumer: ct-tape-reader
    wait_seconds: 30
  ct-watcher:
    payload: {}
    expect_telemetry_consumer: ct-watcher
    wait_seconds: 30
  ct-curiosity:
    payload: {}
    expect_telemetry_consumer: ct-curiosity
    wait_seconds: 30
  # ... other 6 RTH-frequent consumers ...
```

For functions accepting empty `{}`, payload defaults work without override. Per-function override only when payload is required (e.g., ct-tape-reader's `trigger_kind`).

---

## Step 3 — Failure-mode dispatch

| probe outcome | cause class | dispatch action |
|---|---|---|
| HTTP 401 | Auth issue (env var divergence post-deploy, key rotation) — today's P0 archetype | Fail CI + Slack alert |
| HTTP 500 | Function code error (handler panic) | Fail CI + Slack alert |
| HTTP 200 + telemetry row in window | Healthy | PASS |
| HTTP 200 + NO telemetry row | Silent-no-op-write class — handler returned 200 but threw exception caught silently before write | Fail CI elevated severity + Slack alert |
| Timeout (no HTTP response within 60s) | Deploy not propagated, function not responding, cold-start | Retry once with 90s window; if still timeout, fail CI |
| HTTP 200 + telemetry row with `error LIKE 'warning:%'` | Function ran with degraded signal | PASS with warning surface |

**Today's P0 was HTTP 401 class.** Probe would have caught within 30s.

---

## Step 4 — Integration points

### Probe invocation from CI

```yaml
# .github/workflows/deploy-functions.yml — added after Deploy step
- name: Post-deploy probe
  if: steps.changes.outputs.slugs != ''
  env:
    SUPABASE_PROJECT_REF: ${{ secrets.SUPABASE_PROJECT_REF }}
    SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
  run: |
    DEPLOYED_FNS='${{ steps.changes.outputs.slugs }}'
    RESPONSE=$(curl -sS -X POST \
      "https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1/ct-deploy-probe" \
      -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
      -H "Content-Type: application/json" \
      -d "{\"function_names\": $(echo $DEPLOYED_FNS | jq -R 'split(\" \")'), \"wait_seconds\": 30}")
    # Parse response, fail if any function reports non-PASS
    echo "$RESPONSE" | jq '.results' | ...
```

**Security note:** the CI calls `ct-deploy-probe` with CI's service_role JWT. The probe function then internally uses VAULT key (not CI key) to invoke target functions. This works because `ct-deploy-probe` is itself authenticated by CI's key (which is a different shape than the probe-target functions' `isServiceRoleRequest` check — `ct-deploy-probe` either uses different auth or is `verify_jwt = false`).

**TBD in Phase B:** verify that CI's service_role JWT authenticates against `ct-deploy-probe` specifically. If not, the probe needs `verify_jwt = false` + custom auth (HMAC over a shared secret with CI).

### Probe function uses vault key for downstream

```typescript
// ct-deploy-probe/index.ts (sketch)
serve(async (req) => {
  // CI auth check (TBD shape per Step 4 security note)
  if (!isCiAuthenticated(req)) return new Response('Unauthorized', { status: 401 });

  const { function_names, wait_seconds = 30 } = await req.json();

  // Get vault key (not CI's key — this auth-roundtrips)
  const vaultKey = await getVaultServiceRoleKey(supabase);

  const results = await Promise.all(
    function_names.map(async (fn: string) => {
      const config = await loadProbeConfig(fn);
      const t0 = Date.now();

      // Probe HTTP
      const resp = await fetch(
        `${supabaseUrl}/functions/v1/${fn}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${vaultKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(config.payload ?? {}),
        }
      );
      const httpStatus = resp.status;

      // Wait window for telemetry
      await sleep(wait_seconds * 1000);

      // Telemetry verification
      const { data, error } = await supabase
        .from('ct_brain_telemetry')
        .select('id, error')
        .eq('consumer_name', config.expect_telemetry_consumer ?? fn)
        .gte('created_at', new Date(t0).toISOString())
        .limit(1);

      const telemetryFound = Array.isArray(data) && data.length > 0;
      const telemetryError = telemetryFound ? data[0].error : null;

      return { fn, httpStatus, telemetryFound, telemetryError, latencyMs: Date.now() - t0 };
    })
  );

  return new Response(JSON.stringify({ results }), { status: 200 });
});
```

---

## Step 5 — Telemetry verification semantics

Per PR #37's classification, with refinements from B-4 (just shipped):

```
- Found row, error IS NULL              → PASS
- Found row, error LIKE 'warning:%'     → PASS with warning surface
- Found row, error LIKE 'skipped:%'     → PASS (legitimate skip)
- Found row, error not NULL/warning/skipped → FAIL (real error)
- No row in window                      → FAIL (silent-no-op suspected)
```

**Wait window: 30s default.** Configurable per function. Cold-start latency for newly-deployed functions might exceed 30s on first invocation; Phase B should include retry logic with extended window for cold-start.

**Edge case: ct-deploy-probe itself.** The probe function's invocation can't probe itself (chicken-and-egg). Probe runs, succeeds via aggregated result; warden monitors `ct-deploy-probe`'s own health via B-4-style invariant on `ct-deploy-probe` consumer telemetry rows (when it writes its own probe activity to telemetry).

---

## Decision matrix for Phase B (queued for explicit per-PR approval)

| component | scope | priority | dependency |
|---|---|---|---|
| **B-3.1** ct-deploy-probe edge function | new file `supabase/functions/ct-deploy-probe/index.ts` | HIGH | none |
| **B-3.2** Probe config YAML | new file `supabase/functions/_probe-config.yaml` | HIGH | feeds B-3.1 |
| **B-3.3** CI workflow probe step | edit `.github/workflows/deploy-functions.yml` | HIGH | needs B-3.1 deployed |
| **B-3.4** Probe self-monitoring | warden invariant on probe success rate | MEDIUM | defense-in-depth on B-3 itself |
| **B-3.5** Cold-start handling | retry logic with extended window | MEDIUM | inside B-3.1 |

**Phase B implementation estimate:** 1-2 hours for first iteration. Probe runner + config + CI step + initial 9-consumer coverage. Cold-start handling + self-monitoring queue as iteration 2.

**Sequencing:** B-3.1 + B-3.2 ship first as new edge function (no production behavior change). Test via manual invoke. Then B-3.3 ships when probe is verified working. CI integration is the contract change.

---

## Class-kill candidates (queued, no ship this round)

### B-3.K1 — ct-deploy-probe edge function + config (HIGH priority, queue for next session)

The actual probe runner. Estimated 30-45 min for first iteration covering 9 RTH-frequent consumers.

### B-3.K2 — CI workflow integration

After B-3.K1 verified working in dev, add post-deploy probe step. Contract change to deploy-functions.yml.

### B-3.K3 — Probe self-monitoring (defense-in-depth)

Warden invariant `ct_deploy_probe_success_rate_24h` — alerts if probe failure rate exceeds threshold. Catches if probe itself breaks.

### B-3.K4 — Cold-start handling + extended-window retry

For functions with high cold-start latency, retry once with 90s window before declaring failure.

All require explicit per-PR approval. None ship this round.

---

## Cross-cluster framing

**Today's P0 archetype defense net (post-B-3 implementation):**

| layer | guarantee | latency |
|---|---|---|
| Build time | ReferenceError / type error | merge time |
| Deploy time fail | `||` swallow removed | deploy time |
| Deploy time coverage | wrong consumers redeployed | deploy time |
| **Runtime fast** | **probe per-function pass/fail** | **~30 sec post-deploy** |
| Runtime slow | freshness warden invariant | 30-90 min |

**B-3 fills the ~30-sec post-deploy detection gap** that B-4 (30-90 min) and operator detection (~40 min today) couldn't close.

---

## Methodology audit (self-check)

- ✅ Cross-referenced PR #42's auto-discover for consumer set
- ✅ Empirically inspected 4 consumer entry points to confirm `serve(async (req)=>{})` + `isServiceRoleRequest` + empty-body-default pattern
- ✅ Verified vault key requirement against this morning's auth investigation (instance #11)
- ✅ Recommendation refines PR #37's brief from "CI shell script" to "dedicated edge function" per the auth pivot
- ✅ Phase B decomposed into B-3.1 through B-3.5 sub-components for incremental ship
- ⚠️ Did NOT prototype the auth roundtrip from CI → ct-deploy-probe → vault → target function. Pre-flag: Phase B's first task is verifying CI's service_role JWT actually authenticates against ct-deploy-probe.
- ⚠️ Did NOT enumerate per-function payload requirements for the 9 consumers beyond the 4 sampled. Phase B implementation should grep each consumer's body-parsing for required keys before defaulting to `{}`.

---

## Linked artifacts

- Sibling B-4 (just shipped): `supabase/migrations/20260506200000_b_4_brain_consumer_freshness_warden.sql`
- Class kill A (build-time): PR #33 — deno check CI gate
- Class kill B-1 (deploy fail propagation): PR #39
- Class kill B-2 (auto-discover consumer detection): PR #42
- PR #37 (original B Phase A surfacing the design space)
- This morning's P0 retro: `docs/audit/2026-05-06-pr25-reference-error-incident-retro.md`
- Methodology instance #11 (false-cause cascade caught Path 1): same retro doc, "auth investigation" section
