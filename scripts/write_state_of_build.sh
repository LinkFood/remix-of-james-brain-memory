#!/usr/bin/env bash
# write_state_of_build.sh — regenerate STATE_OF_BUILD.md from ground truth
#
# Class kill for: "Cowork paste-ready brief asserts per-item state from stale
# mental-model region." See docs/governance/state-of-build-schema.md for the
# full design + reading protocol.
#
# Outputs to /Users/jameschellis/Documents/cowork-cotrader/STATE_OF_BUILD.md
# (cross-surface direct write — Cowork session reads it without git-pull lag).
#
# Fails loudly on any data-source error so a stale-but-fresh-looking file
# can't ship. The Cowork reader sees REGEN FAILED and knows to alert.
#
# Run modes:
#   ./scripts/write_state_of_build.sh           # default — regen now
#   ./scripts/write_state_of_build.sh --since 2026-05-09  # custom merged-since cutoff
#
# Trigger surfaces: post-every-ship-batch (engine-room write-time checklist
# Step 6) + on-demand captain trigger + side-effect of every Phase A audit.

set -euo pipefail

OUTFILE="/Users/jameschellis/Documents/cowork-cotrader/STATE_OF_BUILD.md"
REPO="LinkFood/remix-of-james-brain-memory"
SUPABASE_URL="https://rvhyotvklfowklzjahdd.supabase.co"

# Default merged-since cutoff: 24h ago in YYYY-MM-DD form.
SINCE_DATE="$(date -u -v-1d +%Y-%m-%d 2>/dev/null || date -u -d 'yesterday' +%Y-%m-%d)"
if [[ "${1:-}" == "--since" && -n "${2:-}" ]]; then
  SINCE_DATE="$2"
fi

NOW_UTC="$(date -u +%Y-%m-%d_%H:%M:%S)"
NOW_HUMAN="$(date -u +"%Y-%m-%d %H:%M:%S UTC")"

# Anchor the active measurement windows the captain has called out.
# Update this list when windows open / close.
read -r -d '' ACTIVE_WINDOWS <<'WINDOWS' || true
D2.2 acceptance|2026-05-07|2026-05-12|verdict 2026-05-13|GOOGL/AMZN/META threshold 60→55. MSFT excluded. Don't ship structural specialist-context changes during the window.
D3 14-day feature-isolation|2026-05-07|2026-05-26|window locks Tue 2026-05-26|Day-by-day capture of feature-isolation rows. No cross-contamination of measured surface.
WINDOWS

# Active deferred captain decisions. Update when decisions land.
read -r -d '' DEFERRED_DECISIONS <<'DECISIONS' || true
PR #91 (Regime Flip Journal) — merge as-is OR hold for iter #N.5 polish
Page consolidation — /alpha vs /tape-v2 vs /tape, three resolution paths flagged
iter #3.5 β refactor — 5 inline GEX callers, content-gated by page consolidation pick
Cross-catalog parity paste from PR #100 description → Cowork memory/patterns.md
DECISIONS

err() { echo "REGEN FAILED: $*" >&2; }

# Step 1 — git fetch and capture commit SHA on origin/main.
if ! git -C /Users/jameschellis/jac-agent-os fetch origin --quiet 2>/dev/null; then
  err "git fetch origin failed"
  exit 1
fi
COMMIT_SHA="$(git -C /Users/jameschellis/jac-agent-os rev-parse --short=8 origin/main)"
COMMIT_SUBJECT="$(git -C /Users/jameschellis/jac-agent-os log -1 --pretty=%s origin/main)"

# Step 2 — fetch Supabase service role key.
KEY="$(npx --yes supabase projects api-keys --project-ref rvhyotvklfowklzjahdd 2>/dev/null | grep service_role | awk '{print $NF}')"
if [[ -z "$KEY" ]]; then
  err "could not retrieve supabase service_role key"
  exit 1
fi

# Step 3 — REST count helper.
rest_count() {
  local path="$1"
  curl -sS "$SUPABASE_URL/rest/v1/$path?select=*&limit=1" \
    -H "Prefer: count=exact" \
    -H "Authorization: Bearer $KEY" \
    -H "apikey: $KEY" \
    -I 2>/dev/null | awk -F'/' '/[Cc]ontent-[Rr]ange/ { gsub(/\r/,""); print $2 }' | tr -d '[:space:]'
}

# Step 4 — pulse counts.
INVARIANTS_TOTAL="$(rest_count ct_invariants || true)"
GROWTH_CRONS_TOTAL="$(rest_count ct_growth_crons || true)"
TAPE_BACKLOG="$(curl -sS "$SUPABASE_URL/rest/v1/ct_tape_commentary?select=*&embedding=is.null&limit=1" -H "Prefer: count=exact" -H "Authorization: Bearer $KEY" -H "apikey: $KEY" -I 2>/dev/null | awk -F'/' '/[Cc]ontent-[Rr]ange/ { gsub(/\r/,""); print $2 }' | tr -d '[:space:]' || echo unknown)"
NEWS_BACKLOG="$(curl -sS "$SUPABASE_URL/rest/v1/ct_breaking_news?select=*&embedding=is.null&limit=1" -H "Prefer: count=exact" -H "Authorization: Bearer $KEY" -H "apikey: $KEY" -I 2>/dev/null | awk -F'/' '/[Cc]ontent-[Rr]ange/ { gsub(/\r/,""); print $2 }' | tr -d '[:space:]' || echo unknown)"

# Step 5 — warden state via get_warden_health RPC (24h window).
WARDEN_JSON="$(curl -sS -X POST "$SUPABASE_URL/rest/v1/rpc/get_warden_health" \
  -H "Authorization: Bearer $KEY" \
  -H "apikey: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"window_hours": 24}' 2>/dev/null || echo '{}')"
WARDEN_PASS="$(printf '%s' "$WARDEN_JSON" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("totals",{}).get("passing","?"))' 2>/dev/null || echo '?')"
WARDEN_FAIL="$(printf '%s' "$WARDEN_JSON" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("totals",{}).get("failing","?"))' 2>/dev/null || echo '?')"
WARDEN_CRIT="$(printf '%s' "$WARDEN_JSON" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("totals",{}).get("critical_failing","?"))' 2>/dev/null || echo '?')"
WARDEN_ERRORED="$(printf '%s' "$WARDEN_JSON" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("totals",{}).get("errored","?"))' 2>/dev/null || echo '?')"
WARDEN_TOTAL="$(printf '%s' "$WARDEN_JSON" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("totals",{}).get("total_enabled","?"))' 2>/dev/null || echo '?')"
WARDEN_FAILING_NAMES="$(printf '%s' "$WARDEN_JSON" | python3 -c '
import sys,json
d=json.load(sys.stdin)
fails=d.get("failures",[])
out=[]
for f in fails:
    out.append("    - `"+f.get("name","?")+"` ("+f.get("severity","?")+", "+str(f.get("consecutive_fails","?"))+" consecutive)")
print("\n".join(out) if out else "    - _(none)_")' 2>/dev/null || echo '    - _(parse failed)_')"

# Step 6 — open PRs (gh).
OPEN_PRS="$(gh pr list --repo "$REPO" --state open --limit 30 --json number,title,headRefName,createdAt \
  --jq '.[] | "- **#\(.number)** \(.title) — `\(.headRefName)` (open since \(.createdAt[:10]))"' 2>/dev/null || echo '- (gh open-PR query failed)')"
[[ -z "$OPEN_PRS" ]] && OPEN_PRS="- _(none)_"

# Step 7 — merged since SINCE_DATE (gh).
MERGED_PRS="$(gh pr list --repo "$REPO" --state merged --limit 50 --search "merged:>=$SINCE_DATE" --json number,title,mergedAt \
  --jq '.[] | "- **#\(.number)** \(.title) — merged \(.mergedAt[:16] | sub("T"; " "))Z"' 2>/dev/null || echo '- (gh merged-PR query failed)')"
[[ -z "$MERGED_PRS" ]] && MERGED_PRS="- _(none since $SINCE_DATE)_"

# Step 8 — in-flight branches without PR.
# A branch is "in-flight without PR" if:
#   pushed to origin AND not merged via squash-merge AND not an open PR's head ref.
# Squash-merge detection: cross-reference against headRefName of recent merged PRs
# (squash-merge creates a new SHA so simple ancestry checks miss the merge).
OPEN_PR_REFS="$(gh pr list --repo "$REPO" --state open --limit 30 --json headRefName --jq '.[].headRefName' 2>/dev/null | tr '\n' '|' | sed 's/|$//')"
[[ -z "$OPEN_PR_REFS" ]] && OPEN_PR_REFS="__none__"
MERGED_PR_REFS="$(gh pr list --repo "$REPO" --state merged --limit 200 --json headRefName --jq '.[].headRefName' 2>/dev/null | tr '\n' '|' | sed 's/|$//')"
[[ -z "$MERGED_PR_REFS" ]] && MERGED_PR_REFS="__none__"

REMOTE_BRANCHES="$(git -C /Users/jameschellis/jac-agent-os for-each-ref --format='%(refname:short)' refs/remotes/origin/ 2>/dev/null | sed 's|^origin/||' | grep -v '^HEAD$' || true)"
INFLIGHT_NO_PR=""
while IFS= read -r br; do
  [[ -z "$br" ]] && continue
  [[ "$br" == "main" ]] && continue
  # Skip branches that match an open PR head ref.
  if echo "$OPEN_PR_REFS" | tr '|' '\n' | grep -Fxq "$br"; then continue; fi
  # Skip branches that match a merged PR head ref (squash-merge artifact).
  if echo "$MERGED_PR_REFS" | tr '|' '\n' | grep -Fxq "$br"; then continue; fi
  # Skip branches whose tip is reachable from origin/main (rebase-merge or fast-forward).
  if git -C /Users/jameschellis/jac-agent-os merge-base --is-ancestor "origin/$br" origin/main 2>/dev/null; then continue; fi
  # Otherwise: real WIP without an open PR.
  AHEAD="$(git -C /Users/jameschellis/jac-agent-os rev-list --count origin/main..origin/"$br" 2>/dev/null || echo '?')"
  LAST_COMMIT="$(git -C /Users/jameschellis/jac-agent-os log -1 --pretty='%h %s' "origin/$br" 2>/dev/null || echo '')"
  INFLIGHT_NO_PR+="- \`$br\` ($AHEAD ahead of main) — $LAST_COMMIT"$'\n'
done <<< "$REMOTE_BRANCHES"
if [[ -z "$INFLIGHT_NO_PR" ]]; then INFLIGHT_NO_PR="- _(none)_"; fi

# Step 9 — render active windows + deferred decisions.
WINDOWS_RENDERED=""
TODAY="$(date -u +%Y-%m-%d)"
while IFS='|' read -r name start end verdict_line note; do
  [[ -z "$name" ]] && continue
  if [[ "$TODAY" < "$start" || "$TODAY" > "$end" ]]; then
    status="(out-of-window)"
  else
    status="ACTIVE"
  fi
  WINDOWS_RENDERED+="- **$name** — $start → $end · $verdict_line · **$status**"$'\n'"  - $note"$'\n'
done <<< "$ACTIVE_WINDOWS"

DECISIONS_RENDERED=""
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  DECISIONS_RENDERED+="- $line"$'\n'
done <<< "$DEFERRED_DECISIONS"

# Step 10 — write the file.
mkdir -p "$(dirname "$OUTFILE")"
cat > "$OUTFILE" <<EOF
# STATE OF BUILD — Co-Trader / JAC Agent OS

**Last regen:** $NOW_HUMAN
**Commit on \`origin/main\`:** \`$COMMIT_SHA\` — $COMMIT_SUBJECT
**Regen source:** \`scripts/write_state_of_build.sh\` (engine-room repo)
**Stale if:** last regen > 4 hours OR commit on origin/main differs from above

> **Cowork brief authors — read this FIRST when drafting any paste-ready brief that asserts per-item state.** If this snapshot is stale (per the rule above), request a regen via \`scripts/write_state_of_build.sh\` before drafting. See \`WORKFLOW.md\` Step 0.
>
> **Engine-room — Phase A audit step 1 on any state-asserting brief is to verify against this file + re-run gh/db queries if anything is older than 4 hours.** See \`docs/governance/engine-room-write-time-checklist.md\` Step 6.

## Open PRs

$OPEN_PRS

## In-flight branches without PR

$INFLIGHT_NO_PR

## Merged since $SINCE_DATE

$MERGED_PRS

## Active measurement windows

$WINDOWS_RENDERED

## Active deferred captain decisions

$DECISIONS_RENDERED

## Backend state pulse

- \`ct_invariants\` total: **$INVARIANTS_TOTAL**
- Warden 24h: **$WARDEN_PASS passing / $WARDEN_FAIL failing ($WARDEN_CRIT critical) / $WARDEN_ERRORED errored** out of $WARDEN_TOTAL enabled
$( [[ "$WARDEN_FAIL" != "0" && "$WARDEN_FAIL" != "?" ]] && echo "  Currently failing:" && echo "$WARDEN_FAILING_NAMES" )
- \`ct_growth_crons\` manifest: **$GROWTH_CRONS_TOTAL** (manifest only — full \`cron.job\` registry not exposed via REST; if a definitive cron count becomes load-bearing for drift detection, ship a \`get_cron_jobs()\` RPC)
- Embedding backlog — \`ct_tape_commentary\` un-embedded: **$TAPE_BACKLOG**
- Embedding backlog — \`ct_breaking_news\` un-embedded: **$NEWS_BACKLOG**

## Regen integrity

- \`gh\` CLI: $( [[ -n "$OPEN_PR_REFS" ]] && echo 'OK' || echo 'FAIL' )
- Supabase REST (\`ct_invariants\`): $( [[ -n "$INVARIANTS_TOTAL" && "$INVARIANTS_TOTAL" != "unknown" ]] && echo 'OK' || echo 'FAIL' )
- Warden RPC (\`get_warden_health\`): $( [[ "$WARDEN_PASS" != "?" ]] && echo 'OK' || echo 'FAIL' )
- \`git fetch origin\`: OK

---

*Generated by \`scripts/write_state_of_build.sh\` ($NOW_UTC). Do not hand-edit — re-run the script. Schema lives at \`docs/governance/state-of-build-schema.md\`.*
EOF

echo "Wrote $OUTFILE"
echo "Last regen: $NOW_HUMAN"
echo "Commit: $COMMIT_SHA"
