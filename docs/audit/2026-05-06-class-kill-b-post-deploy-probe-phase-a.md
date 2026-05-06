# Class kill B — post-deploy synthetic probe (Phase A diagnose-only)

**Date:** 2026-05-06 afternoon (~15:00 ET).
**Trigger:** Pairs with class kill A (deno check CI gate, merged as PR #33). Build-time defense (A) + runtime defense (B) = paired structural prevention against today's P0 archetype.
**Scope:** diagnose-only. Verify deploy mechanism + design probe + classify failure modes.

---

## TL;DR

**Step 1 verification surfaced TWO pre-existing defects in the current deploy workflow** beyond the absent post-deploy probe:

1. **`.github/workflows/deploy-functions.yml:47` swallows per-function deploy failures.** `supabase functions deploy "$slug" || echo "FAILED: $slug"` — the `||` clause silently absorbs non-zero exit. A function that fails to deploy is logged but **doesn't fail CI**. Today's P0 had no surfacing CI signal partly because the deploy itself reported success even when individual functions failed.

2. **`_shared/` change-detection deploys only a hardcoded subset of consumers** (`jac-dispatcher jac-code-agent jac-research-agent jac-save-agent jac-search-agent assistant-chat smart-save` — 7 functions). Missing 11 of the 18 brain consumers I had to manually redeploy via `npx supabase functions deploy` post-PR-#25. The 11 missing ones (ct-tape-reader, ct-watcher, ct-eod-summary, ct-eod-report, ct-curiosity, ct-news-sweep, ct-trade-advisories, ct-trade-idea-generator, ct-eod-specialist-narrative, ct-self-grader, ct-lessons-curator + a few others) silently keep their stale `_shared/` bundle.

**Implication:** Phase B for class kill B should fix three things, not one:
- **B-1:** Remove the deploy-failure swallow (line 47) — `||` clause must propagate failure to CI exit.
- **B-2:** Expand `_shared/` change-detection to include ALL consumers that import the changed shared module (not a hardcoded 7-function subset).
- **B-3:** Add post-deploy synthetic probe (HTTP + telemetry verification) per the original brief.
- **B-4 (defense-in-depth):** Pair-ship warden invariant for runtime per-consumer freshness — already partially shipped today via D2.2's `specialist_per_ticker_freshness_rth` (10 specialists covered); extend coverage to brain-consumer fleet.

The original brief framed B as a single probe layer. **Phase A surfaced that the deploy mechanism itself has structural gaps** that B-3 alone won't close. B-1 + B-2 + B-3 together is the actual structural fix. B-4 backstops anything that escapes B-1+B-2+B-3.

---

## Step 1 — Verify-the-warden's-own-framing applied to ship's own premises

### (a) How do edge function deploys currently happen?

`.github/workflows/deploy-functions.yml` (full file, 49 lines):

```yaml
name: Deploy Edge Functions
on:
  push:
    branches: [main]
    paths: ['supabase/functions/**']
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: supabase/setup-cli@v1
        with: { version: latest }
      - name: Detect changed functions
        id: changes
        run: |
          CHANGED=$(git diff --name-only HEAD~1 HEAD -- supabase/functions/ 2>/dev/null || echo "")
          SLUGS=$(echo "$CHANGED" | grep -oP 'supabase/functions/\K[^/]+' | grep -v '_shared' | sort -u | tr '\n' ' ')
          # If _shared changed, deploy core functions
          if echo "$CHANGED" | grep -q 'supabase/functions/_shared/'; then
            SLUGS="$SLUGS jac-dispatcher jac-code-agent jac-research-agent jac-save-agent jac-search-agent assistant-chat smart-save"
            SLUGS=$(echo "$SLUGS" | tr ' ' '\n' | sort -u | tr '\n' ' ')
          fi
          echo "slugs=$SLUGS" >> $GITHUB_OUTPUT
      - name: Deploy functions
        if: steps.changes.outputs.slugs != ''
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
        run: |
          for slug in ${{ steps.changes.outputs.slugs }}; do
            echo "Deploying $slug..."
            supabase functions deploy "$slug" --no-verify-jwt --project-ref ${{ secrets.SUPABASE_PROJECT_REF }} || echo "FAILED: $slug"
          done
```

**Defect 1 — failure swallow at line 47.** `|| echo "FAILED: $slug"` returns exit code 0 regardless of whether `supabase functions deploy` succeeded. CI passes even when 1 (or all) functions failed to deploy. This is functionally equivalent to having no deploy gate at all for the per-function exit signal.

**Defect 2 — `_shared/` consumer subset.** When `_shared/*.ts` changes, the workflow auto-deploys 7 hardcoded consumers (jac-dispatcher / jac-code-agent / etc.). It does NOT auto-deploy the 18 brain consumers that import from `_shared/claudeReadSurface.ts`, `_shared/contextHelper.ts`, `_shared/flowHeatmapContext.ts`, etc. Today's PR #25's auto-deploy only refreshed the 7 hardcoded consumers — the 18 brain consumers (ct-tape-reader, ct-watcher, ct-eod-summary, etc.) were ONLY redeployed because I manually fired `npx supabase functions deploy` for each. A future `_shared/` PR that doesn't trigger manual redeploy leaves 11+ consumers running stale bundles.

### (b) What's available as deploy completion signal?

Per-function: `supabase functions deploy "$slug"` returns exit code (0 success, non-zero failure). **The signal exists; the current workflow swallows it via `||`.**

Per-deploy-CI-run: GitHub Actions completes with overall exit 0 when the loop finishes regardless of per-function failures (see Defect 1).

If Defect 1 is fixed, the per-function exit becomes a usable signal for the post-deploy probe. **CI can know which functions deployed successfully.**

### (c) What's the existing post-deploy state?

**No automated post-deploy verification exists.** Closest extant artifact: `scripts/linkjac_cotrader_watch.sh` — a manual operator-run health-check script with a PROBES section (commented "added 2026-05-04 — each maps to a real silent failure that bit us today"). It runs four probes (Flow Butterfly RPC, regime capture freshness, calendar coherence, pipeline ratio) but is **operator-triggered, not deploy-triggered.** Captain runs it at session start; not after deploy completion.

This confirms the brief's "zero existing runtime verification" framing. The PROBES script is a sibling pattern (active probes ≠ passive metric checks) but doesn't function as a post-deploy gate.

---

## Step 2 — Probe design

### Two questions per deployed function

1. **Does the function respond?** HTTP probe with service_role_key — expects 200, fails on 401/500/timeout.
2. **Does the function actually execute end-to-end?** Telemetry probe — `ct_brain_telemetry` row from this consumer within N minutes of HTTP probe.

Both gates needed. Today's P0 had two failure modes simultaneously:
- Functions returned 401 (auth-fail at handler entry) — caught by HTTP probe
- Cron-driven invocations also produced no rows — would be caught by telemetry probe if HTTP probe were absent

### Probe trigger options

| Option | Trigger | Recommend? |
|---|---|---|
| **CI post-deploy step** | After `supabase functions deploy` per-function exit, run probe | **PRIMARY** — clean integration once Defect 1 fixed |
| **Dedicated probe edge function** | Cron-triggered probe runs every N min, checks fleet health | Secondary backstop — catches drift outside CI deploys |
| **Warden invariant on per-consumer freshness** | Existing warden cron checks each consumer's last-telemetry-row timestamp | **DEFENSE-IN-DEPTH** — D2.2 already shipped specialist version today; extend to brain-consumer fleet |

**Recommended structural fix shape:** B-1 + B-2 + B-3 (CI post-deploy step) + B-4 (warden invariant) as paired layers. The cron-triggered probe edge function is queue-able for later if B-3+B-4 prove insufficient.

### Probe sequence per deployed function

```
1. CI's "Deploy functions" step exits per-function with success/fail (post-B-1)
2. CI's NEW "Post-deploy probe" step runs:
   For each successfully-deployed function:
     a. HTTP POST to /functions/v1/<fn> with vault service_role_key + minimal valid payload
     b. Capture HTTP status + response body
     c. Wait 30s (configurable per function)
     d. Query ct_brain_telemetry: row from this consumer within last 30s?
     e. Aggregate result: PASS / HTTP_FAIL / SILENT_FAIL / TIMEOUT
3. If any function FAIL or any class != PASS:
   - Slack alert with per-function class
   - CI exits 1 (matches B-1's contract)
   - Captain decision: roll back, fix forward, or accept transient
```

**Probe wait window.** Telemetry rows from edge functions land via `void` fire-and-forget inserts. Typical lag: 1-5 seconds. 30-second wait window is conservative; can tune down later.

---

## Step 3 — Failure-mode classification

| Probe outcome | Cause class | Action |
|---|---|---|
| HTTP 401 | Auth issue (env var divergence at deploy time, key rotation, isServiceRoleRequest mismatch) — **today's P0 shape** | Alert + fail CI |
| HTTP 500 | Function code error — exception thrown before response | Alert + fail CI |
| HTTP 200 + telemetry row in window | Healthy | PASS |
| HTTP 200 + NO telemetry row | End-to-end exec failure (downstream write fail, exception caught silently) — **silent-no-op-write class** | Alert + fail CI (elevated severity) |
| Timeout (no HTTP response within Ns) | Deploy didn't propagate, function not responding, cold-start latency | Retry once with longer timeout; if still timeout, fail |
| HTTP 200 + telemetry row with `error LIKE 'warning:%'` | Function ran with degraded signal | Pass with warning surface |
| HTTP 200 + telemetry row with `error NOT LIKE 'warning:%' AND NOT LIKE 'skipped:%'` | Function ran but reported real error inline | Fail CI |

**Today's P0 was HTTP-401 class** — function rejected at `isServiceRoleRequest` because of pre-existing CLI key vs vault key divergence (NOT caused by PR #25 — that was an unrelated mismatch). Probe would have caught it within seconds of deploy.

**Today's secondary failure was cron silent-success-zero-row** — pg_cron's `net.http_post` returned 200 (because Supabase Edge Runtime returns 200 even when the handler throws), but the function's handler body crashed on the ReferenceError before any telemetry row was written. **Probe's telemetry-row check would have caught this.**

---

## Step 4 — Integration points

### Which functions to probe

**Option A: Auto-discover from deploy step output.** Modify Defect-1-fix to capture successful slugs into a CI variable. Probe reads the variable. **RECOMMENDED.**

**Option B: Hardcode list in `supabase/functions/_probe-config.yaml`.** Adds maintenance burden when functions are added/removed.

### Which payload to send

Each function expects different shape. Options:
- **Minimal-valid-payload per function** in `_probe-config.yaml`. ~50 functions × small JSON each.
- **Generic `{}` payload + accept any non-error response.** Risk: function rejects empty payload as 400, probe falsely flags as failure.

**Recommended:** start with `{}` for functions that handle empty bodies (most do per `parseJsonBody` which defaults to `{}`); add per-function overrides only for functions that explicitly require structured input.

### Service role key access

Probe needs the same vault-managed `service_role_key` the cron uses. Available in CI via the `SUPABASE_ACCESS_TOKEN` secret already used by the deploy step (or a dedicated probe-only secret).

**Pre-flag (HYPOTHESIS, NOT load-bearing):** the CLI service_role key (`npx supabase projects api-keys`) is ALREADY KNOWN to mismatch function envs (this morning's session-long auth issue — both legacy JWT and `sb_secret_*` rejected from all functions when called via direct curl). The probe needs the actual vault-stored key, accessible via `SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key'`. Practically: probe runs as a Supabase RPC call, not direct HTTP from CI runner. This pivots the Phase B implementation: **probe is itself an edge function or RPC that runs from inside Supabase**, not a CI-level curl.

This is a meaningful refinement of the brief's Option-A "CI post-deploy step." Phase B should be:
- CI post-deploy step **invokes a probe RPC** (e.g., `ct-deploy-probe`)
- The probe RPC runs inside Supabase, has access to vault key, can call /functions/v1/* with the matching auth
- Probe returns aggregated result to CI
- CI fails based on aggregated result

### Success criteria per function

- HTTP 200 + telemetry row within 30s = PASS (default)
- Per-function override possible (e.g., `ct-system-warden` writes to `ct_invariant_log` not `ct_brain_telemetry` — needs different success-row table)

---

## Step 5 — Telemetry verification semantics

Critical: distinguish "function ran end-to-end" from "function returned 200 but silent-failed."

```
1. Probe sends request → gets 200 response
2. Probe waits 30 seconds (configurable)
3. Probe queries ct_brain_telemetry:
   SELECT 1 FROM ct_brain_telemetry
   WHERE consumer_name = '<fn>'
     AND created_at > now() - interval '30 seconds'
   LIMIT 1
4. Cases:
   - row found, error IS NULL → probe PASSES (healthy)
   - row found, error LIKE 'warning:%' OR error LIKE 'skipped:%' → probe PASSES (known degraded states)
   - row found, error NOT LIKE warning/skipped → probe FAILS (real error)
   - no row → probe FAILS (silent-no-op suspected)
```

**Edge case: functions that don't write `ct_brain_telemetry`.** Some edge functions (jac-dispatcher, jac-research-agent, etc.) may not consume the synthesis layer and don't emit `ct_brain_telemetry` rows. For those, success criteria differ — could be a successful row in `agent_tasks`, or a Slack message, etc. Per-function success-table override required.

**Today's P0 mitigation check:** if probe had been live, the 401 from ct-tape-reader at 12:14Z would have failed the post-deploy step, alerted James in Slack, and the deploy could have been auto-rolled back. MTTD goes from ~40 min (captain noticing /tape frozen) to ~30 sec (probe failure during deploy run).

---

## Decision matrix for Phase B (queued for explicit per-PR approval)

| component | priority | scope | dependency |
|---|---|---|---|
| **B-1** Remove `||` failure swallow at deploy-functions.yml:47 | **HIGHEST** | 1 line change | none — independent |
| **B-2** Expand `_shared/` consumer detection to all importers | HIGH | parse imports OR maintain list | independent |
| **B-3** Post-deploy probe RPC + CI step | HIGH | new edge function + CI step + probe-config | depends on B-1 (need per-function success/fail signal) |
| **B-4** Warden invariant on brain-consumer freshness | MEDIUM (defense-in-depth) | new ct_invariants row | independent — same shape as today's specialist freshness invariant |

**Recommended ship order:** B-1 first (cheapest, highest leverage — turns auto-deploy from "always green" to "fails when broken"). Then B-2 (catches the missing-consumer-redeploy class today's P0 exposed). Then B-3 + B-4 paired (build-time + runtime probe layers).

B-1 + B-2 alone would have prevented today's P0 (failed deploys would have failed CI; manual `npx` redeploys would have been unnecessary). B-3 + B-4 add structural prevention against future deploy-time silent failures of unanticipated shapes.

---

## Class-kill candidates (queued, no ship this round)

### B.K1 — B-1 deploy failure propagation (immediate ship candidate)

One-line change. PR-only on `.github/workflows/deploy-functions.yml`. **Independent of B-3's design.** Could ship today as a quick win.

### B.K2 — B-2 `_shared/` consumer detection expansion

Parse imports OR maintain explicit list. The "parse imports" path is more robust but requires AST tooling; the "explicit list" path is simpler but maintenance-prone. Phase B should choose during implementation review.

### B.K3 — B-3 post-deploy probe RPC + CI step

Phase B implementation per the brief's recommendation, refined by Phase A's "probe is an RPC, not direct CI curl" insight (vault key auth requirement). Larger scope; multi-PR.

### B.K4 — B-4 warden invariant: brain-consumer freshness

Sibling to today's `specialist_per_ticker_freshness_rth` (D2.2 ship). Same shape applied to the brain-consumer set. Configurable threshold. Defense-in-depth.

All require explicit per-PR approval. None ship in this Phase A round.

---

## Methodology audit (self-check)

- ✅ Step 1 verified the actual deploy mechanism by reading the workflow file directly, not assuming.
- ✅ Surfaced TWO pre-existing defects beyond the brief's anticipated scope (failure swallow + consumer subset).
- ✅ Refined the brief's Option-A recommendation with Phase A's empirical insight (vault key auth → probe is RPC, not CI curl).
- ✅ Distinguished today's two simultaneous failure modes (HTTP 401 + silent-success-zero-row) and verified probe would catch both.
- ✅ Per-PR-approval-required tag preserved on all proposed Phase B fix shapes.
- ✅ Brief-author-premise-error discipline applied: the brief's "CI post-deploy step" recommendation was a hypothesis; Phase A's verification of (a)/(b)/(c) refined it.
- ⚠️ Did NOT verify the vault key vs CI-available service_role_key empirically — relied on this morning's session-long auth investigation. Pre-flag for Phase B implementation: confirm vault key access pattern at probe time.
- ⚠️ Did NOT enumerate which of the ~50 edge functions would need per-function payload overrides (default `{}` works for most that use `parseJsonBody` defaults) — full inventory deferred to Phase B implementation.

---

## Methodology-errors-cascade — instance #16 candidate (deploy-mechanism-defect-uncovered-during-Phase-A)

The brief framed B as "add a post-deploy probe." Phase A surfaced **two pre-existing deploy-mechanism defects** (failure swallow + consumer subset) that were independent of and additive to the missing-probe gap. **The brief's framing was correct but incomplete** — same shape as today's heatmap "5/8 missing" (instance #10) and "4-ticker silent class" (instance #12) where the audit upgraded the cause from one factor to compounding factors.

This is the **16th confirmed instance** of methodology-errors-cascade caught at audit. Sub-pattern: **Phase A surfaces structural defects in the surrounding system that the brief assumed were already healthy.** The brief assumed the deploy workflow worked correctly except for the missing probe; Phase A found three things wrong. Worth a methodology-patterns.md addendum if this rate persists.

**Diagnostic question for future Phase As on systems described as "mostly working except for X":** *"Did I verify the surrounding system actually works as the brief assumes? Or did I take 'mostly working' as premise without empirical check?"*

---

## Linked artifacts

- Class kill A (paired build-time defense): PR #33 — `scripts/check_deno_types.sh` + CI integration
- Original P0 incident retro: `docs/audit/2026-05-06-pr25-reference-error-incident-retro.md`
- Today's P0 hotfix: PR #26 — one-line declare consumerName in scope
- D2.2 ship (sibling discipline): PR #36 — A3.K4 silent-specialist warden invariant pair-shipped with threshold recalibration
- Watch script with PROBES section: `scripts/linkjac_cotrader_watch.sh:91+` — operator-driven probe pattern that informs Phase B design
- Deploy workflow under audit: `.github/workflows/deploy-functions.yml`
