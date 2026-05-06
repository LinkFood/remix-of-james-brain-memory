#!/bin/bash
# check_supabase_table_refs.sh — B4 class-kill from 2026-05-05 distill-principles
# silent no-op audit.
#
# Greps every `.from('<TABLE>')` reference in supabase/functions/, cross-checks
# against the live PostgREST schema (requires SUPABASE_SERVICE_ROLE_KEY env var),
# fails the build on any orphan. Catches the
# `function-writes-to-nonexistent-table` class permanently.
#
# Why this exists:
#   distill-principles wrote to brain_principles for ~10 weeks since 2026-02-28.
#   PostgREST returned PGRST205 silently. Caller caught + console.warn'd. Cron
#   saw HTTP 200. No warden invariant existed on principles-row growth. Result:
#   every JAC dispatch shipped without operating-principles for 10 weeks.
#
# Skipped tables (allowlist for false positives — table created by migration
# but not yet visible to PostgREST cache, or uses templated names):
#   - none currently
#
# Usage:
#   SUPABASE_URL=https://rvhyotvklfowklzjahdd.supabase.co \
#   SUPABASE_SERVICE_ROLE_KEY=$(...) \
#   bash scripts/check_supabase_table_refs.sh
#
# CI:
#   .github/workflows/ci.yml — runs on push/PR to main.
#   Requires the SUPABASE_SERVICE_ROLE_KEY repo secret to be configured.

set -uo pipefail

PROJECT_REF="${SUPABASE_PROJECT_REF:-rvhyotvklfowklzjahdd}"
SUPABASE_URL="${SUPABASE_URL:-https://${PROJECT_REF}.supabase.co}"

# Resolve service-role key. Env var primary; npx CLI fallback if not set.
if [[ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]]; then
  echo "[check_supabase_table_refs] SUPABASE_SERVICE_ROLE_KEY not set; trying npx supabase CLI fallback..." >&2
  SUPABASE_SERVICE_ROLE_KEY=$(npx supabase projects api-keys --project-ref "${PROJECT_REF}" 2>/dev/null | grep service_role | awk '{print $NF}')
  if [[ -z "${SUPABASE_SERVICE_ROLE_KEY}" ]]; then
    echo "ERROR: cannot resolve service-role key (env var unset, npx CLI fallback failed)" >&2
    echo "  Skip mode: pass SKIP_TABLE_REF_CHECK=1 to bypass (CI should NOT skip in production)" >&2
    if [[ "${SKIP_TABLE_REF_CHECK:-0}" == "1" ]]; then exit 0; fi
    exit 1
  fi
fi

# Fetch live table list from PostgREST root (returns OpenAPI spec). The "definitions"
# key enumerates every table+view exposed.
LIVE_TABLES_FILE=$(mktemp)
trap 'rm -f "${LIVE_TABLES_FILE}"' EXIT

curl -s "${SUPABASE_URL}/rest/v1/" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  | python3 -c "
import json, sys
spec = json.load(sys.stdin)
tables = sorted((spec.get('definitions') or {}).keys())
for t in tables:
    print(t)
" > "${LIVE_TABLES_FILE}"

LIVE_COUNT=$(wc -l < "${LIVE_TABLES_FILE}" | tr -d ' ')
if [[ "${LIVE_COUNT}" -lt 10 ]]; then
  echo "ERROR: PostgREST schema query returned only ${LIVE_COUNT} tables — likely an auth or network failure. Aborting check (don't false-fail)." >&2
  exit 1
fi

# Extract every .from('<table>') reference in supabase/functions/.
# v1.1 (2026-05-05) — filter out `.storage.from('<bucket>')` calls. Storage
# bucket references are not Postgres tables; the original regex over-matched
# and produced false-positives (the `dumps` orphan that triggered this Phase
# B). The filter handles both shapes:
#   1. Same-line:        `supabase.storage.from('bucket')`
#   2. Multi-line chain: `serviceClient.storage\n        .from('bucket')`
# The awk tracks the previous line per-file (reset on FNR==1) and skips the
# current .from(...) if the previous line ends with `.storage`.
REFS_FILE=$(mktemp)
trap 'rm -f "${LIVE_TABLES_FILE}" "${REFS_FILE}"' EXIT

AWK_SCRIPT="$(dirname "$0")/_extract_table_refs.awk"
if [[ ! -f "${AWK_SCRIPT}" ]]; then
  echo "ERROR: missing companion ${AWK_SCRIPT}" >&2
  exit 1
fi

find supabase/functions -name '*.ts' -print0 \
  | xargs -0 awk -f "${AWK_SCRIPT}" \
  | sort -u \
  > "${REFS_FILE}"

REF_COUNT=$(wc -l < "${REFS_FILE}" | tr -d ' ')

# Find orphans: tables referenced in code but absent from PostgREST schema.
# Apply allowlist (filter out known false-positives from raw orphans).
ALLOWLIST="$(dirname "$0")/check_supabase_table_refs.allowlist"
ALLOWED_FILE=$(mktemp)
trap 'rm -f "${LIVE_TABLES_FILE}" "${REFS_FILE}" "${ALLOWED_FILE}"' EXIT
if [[ -f "${ALLOWLIST}" ]]; then
  grep -v '^#' "${ALLOWLIST}" | grep -v '^[[:space:]]*$' | sort -u > "${ALLOWED_FILE}"
  ALLOWED_COUNT=$(wc -l < "${ALLOWED_FILE}" | tr -d ' ')
else
  ALLOWED_COUNT=0
fi

RAW_ORPHANS=$(comm -23 "${REFS_FILE}" "${LIVE_TABLES_FILE}")
RAW_ORPHANS_FILE=$(mktemp)
echo "${RAW_ORPHANS}" | grep -v '^[[:space:]]*$' | sort -u > "${RAW_ORPHANS_FILE}"

ORPHANS=$(comm -23 "${RAW_ORPHANS_FILE}" "${ALLOWED_FILE}")
rm -f "${RAW_ORPHANS_FILE}"

ORPHAN_COUNT=0
if [[ -n "${ORPHANS}" ]]; then
  ORPHAN_COUNT=$(echo "${ORPHANS}" | grep -c .)
fi

echo "[check_supabase_table_refs]"
echo "  PostgREST schema: ${LIVE_COUNT} tables/views"
echo "  References found: ${REF_COUNT} distinct .from('<name>') in supabase/functions/"
echo "  Allowlisted:      ${ALLOWED_COUNT} known false-positives"
echo "  Orphans:          ${ORPHAN_COUNT}"

if [[ "${ORPHAN_COUNT}" -gt 0 ]]; then
  echo
  echo "ORPHAN TABLE REFERENCES (function writes/reads tables that don't exist in PostgREST):"
  echo "${ORPHANS}" | sed 's/^/  - /'
  echo
  echo "For each orphan, find the call site:"
  for o in ${ORPHANS}; do
    echo "  --- ${o} ---"
    grep -rn "\.from(['\"]${o}['\"])" supabase/functions/ | head -5 | sed 's/^/    /'
  done
  echo
  echo "FAIL: orphan table references detected. Either rename to the correct table or add the missing migration."
  exit 1
fi

echo "PASS: every .from('<name>') in supabase/functions/ resolves to a live PostgREST table."
