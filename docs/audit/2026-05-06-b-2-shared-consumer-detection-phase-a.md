# B-2 — `_shared/` consumer detection expansion (Phase A diagnose-only)

**Date:** 2026-05-06 (~14:45 ET).
**Trigger:** PR #37 surfaced that `_shared/` change-detection in `.github/workflows/deploy-functions.yml` only auto-deploys 7 hardcoded consumers. The other 11 of the 18 brain consumers needed manual redeploy this morning post-PR-#25.
**Scope:** diagnose-only. Identify hardcoded list + missing consumers + recommend structural fix shape.

---

## TL;DR

**The 7 hardcoded consumers DON'T match the actual import-graph at all.** Empirical grep:

| `_shared/` file changed | Actual importers (count) | Currently auto-redeployed |
|---|---|---|
| `_shared/claudeReadSurface.ts` | **18 ct-* brain consumers** | **0 of 18** (hardcoded list is JAC-side functions that don't import this file) |
| `_shared/contextHelper.ts` | 3 (ct-eod-report, ct-eod-summary, ct-tape-reader) | unknown — depends on whether they import auth.ts/cors.ts via shared chain |
| `_shared/specialistRunner.ts` | 10 ct-specialist-* | 0 of 10 |
| `_shared/auth.ts` (etc.) | ~162 function importers | hardcoded 7 (incomplete) |

**The hardcoded 7 list is legacy JAC-side fixture from when JAC was the only Cowork surface.** ct-* brain consumers were added later; no one updated the list as the codebase grew. Today's PR #25 changing `claudeReadSurface.ts` triggered redeploy of **0** of the 18 brain consumers per the workflow — they were ONLY refreshed because I manually fired `npx supabase functions deploy` post-PR-#25.

**Recommendation: Option (b) auto-discover via grep import-graph.** Drift-proof, zero maintenance, exactly mirrors current code. Phase B implementation queued for explicit per-PR approval.

---

## Step 1 — Verify-the-warden's-own-framing applied to brief's empirical claim

Brief claimed "11 missing of the 18." Empirical verification:

### Hardcoded list (per `.github/workflows/deploy-functions.yml:30`)

```
jac-dispatcher jac-code-agent jac-research-agent jac-save-agent
jac-search-agent assistant-chat smart-save
```

Count: **7.**

### Actual `_shared/claudeReadSurface.ts` importers (grep verified)

```
ct-alert-post-mortem        ct-curiosity              ct-eod-report
ct-eod-summary              ct-eod-specialist-narrative
ct-hypothesis-health-check  ct-hypothesis-proposer    ct-lessons-curator
ct-news-sweep               ct-playbook-curator       ct-self-grader
ct-tape-reader              ct-trade-advisories       ct-trade-idea-generator
ct-watcher                  ct-chat                   ct-debate-outcome-scorer
ct-daily-brief
```

Count: **18.**

### Overlap between hardcoded-7 and actual-18

**ZERO.** The hardcoded 7 are all JAC-side or smart-save; the actual 18 are all ct-* brain consumers. Brief's "11 missing" was a partial frame: in fact, **18 of 18 are missing**, not 11. The hardcoded 7 don't import claudeReadSurface.ts at all; they're triggered for a DIFFERENT reason (probably to refresh whenever any `_shared/` file changes since they import `_shared/auth.ts` or similar).

**Methodology refinement:** brief's empirical claim ("11 missing") was wrong by under-count. Phase A's empirical import-graph showed the actual gap is bigger: every ct-* brain consumer is missing from auto-deploy when claudeReadSurface.ts changes. Sub-pattern of brief-author-premise-empirical-verification (PR #30).

### Why the hardcoded list?

Reading `git log` of `.github/workflows/deploy-functions.yml`:

```
0309037 — feat(co-trader): UW API usage tracking + live header dashboard badge
```

The list appears to predate the brain consumers. Inheritance: JAC was the early surface; ct-* brain consumers added 2026-04-15 onward (per build trail in CLAUDE.md). The hardcoded list never grew to match. Classic accumulated-legacy pattern.

---

## Step 2 — Decision matrix

Per the brief's options:

### (a) Expand to 18 hardcoded — REJECTED

- **Problem:** hardcoded lists drift. Adding the 18 today doesn't prevent the same drift in 2 months when the brain consumer set changes.
- **Sub-pattern:** today already has THREE hardcoded lists (the 7 in deploy-functions.yml + the watchlist in 5+ places + the heatmap consumer list). Each is a future-drift surface.
- **Verdict:** does NOT address root cause. Same shape as PR #23 morning's "extend warden filter to add NOT LIKE 'cache_hit:%'" patch we explicitly rejected per Option-B class-kill discipline.

### (b) Auto-discover via grep import-graph — RECOMMENDED

- **Drift-proof:** always reflects current code state. Add a new function tomorrow that imports `_shared/claudeReadSurface.ts`, it auto-redeploys on next `_shared/` change without manual list update.
- **Implementation:** when `_shared/X.ts` changes, run `grep -rln "from '../_shared/X'" supabase/functions/` to enumerate importers. Add those to SLUGS.
- **Edge cases:** transitive imports (Y imports X, Z imports Y); circular imports; non-`from` imports (dynamic). For Co-Trader's current code, none of these apply at scale — direct imports are the dominant pattern. If a future case surfaces, can extend.
- **Cost:** ~10 lines of bash in the workflow. Low complexity.
- **Verdict:** structural class-kill. Recommended.

### (c) Lift to ct_config consumer list per Tenet 16 — VIABLE

- **Drift-proof if maintained:** ct_config row lists which functions import which `_shared/` modules. Updating the row is a DB UPDATE, not a code change.
- **Trade-off vs (b):** ct_config requires manual list maintenance (or a separate cron that syncs the import-graph into ct_config). (b) is automatic; (c) is configurable but maintenance-prone.
- **Use case:** if there's a need to OVERRIDE the import-graph (e.g., function X imports Y but you don't want X to redeploy when Y changes), ct_config wins. (b) doesn't support this.
- **Today's case:** no override needs. (b) is sufficient. If override needs surface later, (c) can be added on top of (b).
- **Verdict:** layer on top of (b) if needed. Not first-priority.

---

## Step 3 — Recommended Phase B implementation (queued, no ship this round)

### B-2.1 — Auto-discover via grep (RECOMMENDED)

```bash
# Inside workflow's "Detect changed functions" step
CHANGED_SHARED=$(echo "$CHANGED" | grep '^supabase/functions/_shared/')
if [ -n "$CHANGED_SHARED" ]; then
  for shared_file in $CHANGED_SHARED; do
    # Strip 'supabase/functions/_shared/' and '.ts'
    shared_basename=$(basename "$shared_file" .ts)
    # Find all importers
    IMPORTERS=$(grep -rln "from '\.\./_shared/${shared_basename}" supabase/functions/ \
      | grep -v "_shared/" \
      | sed 's|supabase/functions/||; s|/index\.ts||' \
      | sort -u)
    SLUGS="$SLUGS $IMPORTERS"
  done
  SLUGS=$(echo "$SLUGS" | tr ' ' '\n' | sort -u | tr '\n' ' ')
fi
# Drop the legacy hardcoded list — it's now redundant since auto-discover
# covers all importers.
```

**Deletes the legacy 7-function hardcoded fragment** at lines 30-31. Replaces with auto-discovered importers per changed `_shared/` file.

### B-2.2 — Test path

- Modify `_shared/claudeReadSurface.ts` (no-op change like a comment)
- CI workflow detects 18 importers, adds them to SLUGS
- Verify pre-deploy log shows the 18 names
- After B-1 (PR #39) is merged: deploy step runs each, fails CI if any fail

### B-2.3 — Edge cases pre-flagged

- **Transitive imports:** if function X imports `_shared/Y.ts` which imports `_shared/Z.ts`, and `_shared/Z.ts` changes, X needs to be redeployed. Direct `from '../_shared/Z'` grep wouldn't catch X. Mitigation: also grep for indirect chains (Y importers that include `from '../_shared/Z'`). Adds complexity. **Recommendation:** start with direct-only; if it bites, add transitive.
- **`_shared/X.ts` deleted:** changed file no longer exists. Auto-discover finds no importers (because nothing in current code imports the deleted file). Result: no redeploys. This is correct (the deleted file's previous importers either updated to remove the import already or they're orphans).
- **New `_shared/X.ts` added:** changed file is new. Auto-discover finds whoever already imports it. New importers come in via the new file's PR + their own changed-function detection. Correct.

---

## Methodology audit (self-check)

- ✅ Empirically verified the brief's "11 missing" claim — found it under-counted by 7 (actual gap is 18, not 11). Sub-pattern of brief-author-premise-empirical-verification.
- ✅ Cross-checked the hardcoded list against actual import-graph — they don't overlap, suggesting hardcoded list is legacy from before brain consumers existed.
- ✅ Decision matrix (a/b/c) explicitly considered, with (a) rejected per same Option-B-class-kill discipline that closed PR #23 this morning.
- ✅ Edge cases pre-flagged for Phase B.
- ⚠️ Did NOT verify the hardcoded 7's actual purpose by reading their code — assumed they import `_shared/auth.ts` or similar via the shared chain. If wrong, the fix shape may need to keep a backfill list for them too. Pre-flag for Phase B verification.

---

## Methodology-errors-cascade — instance #17 candidate (brief-empirical-claim-undercount)

The brief claimed "11 missing of the 18." Phase A found "18 of 18 missing of the importers" — actual gap is 7 functions BIGGER than brief framed. Same shape as instance #10 (heatmap "5/8 missing" → 2 compounding filters + AAPL sign-flip), instance #12 ("4-ticker silent class" → 3 classes), instance #16 (deploy-mechanism-defects-uncovered).

**Sub-pattern: brief embeds empirical claim about a count; Phase A's empirical recount finds the count is off by N.** Same forcing function as PR #30's brief-author-premise-empirical-verification: every count-claim in a brief should be re-counted by Phase A before treating as load-bearing.

**Diagnostic question for Phase A:** *"Did the brief give me a count? Have I empirically re-counted? If not — re-count first, treat the brief's count as hypothesis."*

---

## Linked artifacts

- Phase A on B-3 + B-4 sibling: `docs/audit/2026-05-06-class-kill-b-post-deploy-probe-phase-a.md` (PR #37)
- Class kill A (build-time defense): PR #33
- Class kill B-1 (deploy failure propagation): PR #39 (in flight)
- Today's manual redeploy list: 18 consumers redeployed via `npx supabase functions deploy` post-PR-#25 + post-PR-#26
- Workflow file under audit: `.github/workflows/deploy-functions.yml:26-32`
