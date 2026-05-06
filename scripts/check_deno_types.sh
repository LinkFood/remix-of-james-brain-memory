#!/bin/bash
# check_deno_types.sh — class-kill A from 2026-05-06 PR #27 incident retro.
#
# Runs `deno check` on every TypeScript file under supabase/functions/
# (except jac-watch-scheduler — has npm: imports requiring nodeModulesDir).
# Fails CI if any new error appears in a clean file OR if an existing
# allowlisted file's error count grows above its baseline.
#
# Why this exists:
#   PR #25 (2026-05-06 morning) introduced a `ReferenceError` on
#   `consumerName` at supabase/functions/_shared/claudeReadSurface.ts:1983
#   — variable referenced before declaration. CI's `npx tsc --noEmit` step
#   only checks src/ frontend code; supabase/functions/ is outside the
#   tsconfig graph. The bug deployed and broke 18 redeployed edge functions
#   from 12:14Z to ~15:00Z. PR #26's one-line fix landed only after the
#   captain caught the production failure via the /tape page.
#
#   Empirical verification: reverting PR #26's fix locally and running
#   `deno check` produces TS2304 "Cannot find name 'consumerName'" — exactly
#   the error class that should have failed CI before merge. This gate
#   structurally prevents that class going forward.
#
# Allowlist semantics:
#   scripts/check_deno_types.allowlist contains lines of form
#   "<relative_path> <baseline_error_count>". A file's deno check error
#   count must equal baseline_error_count. NEW files with errors fail.
#   Existing allowlisted files cannot REGRESS (errors > baseline). Files
#   that drop below baseline trigger a warning to update the allowlist.
#
# Skip mode:
#   SKIP_DENO_TYPE_CHECK=1 to bypass (CI should NOT skip in production).
#
# Usage:
#   bash scripts/check_deno_types.sh
#
# CI:
#   .github/workflows/ci.yml — runs on push/PR to main.
#   Requires deno installed in the runner (denoland/setup-deno@v2 step).

set -u

if [[ "${SKIP_DENO_TYPE_CHECK:-0}" == "1" ]]; then
  echo "[check_deno_types] SKIP_DENO_TYPE_CHECK=1, bypassing." >&2
  exit 0
fi

if ! command -v deno >/dev/null 2>&1; then
  echo "ERROR: deno not installed. Add denoland/setup-deno@v2 step in CI." >&2
  exit 1
fi

ALLOWLIST_FILE="${ALLOWLIST_FILE:-scripts/check_deno_types.allowlist}"

# Lookup baseline count for a file. Portable to bash 3.2 (no associative array).
# Returns "" if file not in allowlist; otherwise the integer count.
lookup_baseline() {
  local target="$1"
  if [[ ! -f "$ALLOWLIST_FILE" ]]; then return; fi
  awk -v t="$target" '
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*$/ { next }
    $1 == t { print $2; exit }
  ' "$ALLOWLIST_FILE"
}

ALLOWLIST_COUNT=0
if [[ -f "$ALLOWLIST_FILE" ]]; then
  ALLOWLIST_COUNT=$(grep -cv '^[[:space:]]*\(#\|$\)' "$ALLOWLIST_FILE" 2>/dev/null || echo 0)
fi
echo "[check_deno_types] Allowlist entries: $ALLOWLIST_COUNT"

# Iterate every file, run deno check, compare error count
EXIT_CODE=0
NEW_ERRORS=0
REGRESSIONS=0
IMPROVEMENTS=()

while IFS= read -r f; do
  # deno check returns non-zero on type errors; OK — we read its output and
  # decide based on the "Found N error(s)" line.
  out=$(deno check "$f" 2>&1 || true)

  # Extract error count from "Found N errors." line (if any). grep returns 1
  # when the line is absent (clean file); piped through, count becomes empty
  # and is defaulted to 0 below.
  count=$(echo "$out" | grep -E '^Found .* error' | tail -1 | awk '{print $2}' || true)
  count="${count:-0}"

  baseline=$(lookup_baseline "$f")

  if [[ "$count" == "0" ]]; then
    # File is clean
    if [[ -n "$baseline" ]]; then
      IMPROVEMENTS+=("$f (was $baseline, now 0 — REMOVE from allowlist)")
    fi
    continue
  fi

  # File has errors
  if [[ -z "$baseline" ]]; then
    # New file with errors — FAIL
    echo ""
    echo "::error file=$f::deno check found $count error(s) in non-allowlisted file"
    echo "$out" | grep -E '^\[.*?\]?TS|^\s+at file://'
    NEW_ERRORS=$((NEW_ERRORS + 1))
    EXIT_CODE=1
  elif [[ "$count" -gt "$baseline" ]]; then
    # Regression — file's error count grew
    echo ""
    echo "::error file=$f::deno check found $count error(s), allowlist baseline is $baseline"
    echo "$out" | grep -E '^\[.*?\]?TS|^\s+at file://'
    REGRESSIONS=$((REGRESSIONS + 1))
    EXIT_CODE=1
  elif [[ "$count" -lt "$baseline" ]]; then
    # Improvement — should update allowlist
    IMPROVEMENTS+=("$f (was $baseline, now $count — UPDATE allowlist)")
  fi
  # Equal count: silently OK
done < <(find supabase/functions -name '*.ts' -not -path '*/jac-watch-scheduler/*')

echo ""
echo "[check_deno_types] Summary:"
echo "  New errors in non-allowlisted files: $NEW_ERRORS"
echo "  Regressions in allowlisted files:    $REGRESSIONS"
echo "  Improvements (update allowlist):     ${#IMPROVEMENTS[@]}"

if [[ ${#IMPROVEMENTS[@]} -gt 0 ]]; then
  echo ""
  echo "[check_deno_types] Improvements detected — please update $ALLOWLIST_FILE:"
  for line in "${IMPROVEMENTS[@]}"; do
    echo "  $line"
  done
fi

if [[ "$EXIT_CODE" -ne 0 ]]; then
  echo ""
  echo "[check_deno_types] FAIL — fix the new errors or amend allowlist with reason."
fi

exit "$EXIT_CODE"
