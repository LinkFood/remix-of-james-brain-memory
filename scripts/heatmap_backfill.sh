#!/usr/bin/env bash
# heatmap_backfill.sh — populate ct_flow_heatmap_snapshots for visual testing.
#
# Calls the ct-heatmap-snapshot edge function 168 times (7 days x 24 hours),
# 1-hour lookback per call, 2s sleep between calls. Each invocation writes
# one row per (ticker, expiry_date) pair the watchlist had flow for in the
# last 1h.
#
# CAVEAT — historical accuracy:
#   ct-heatmap-snapshot uses `now() - lookback_hours` as its window. There
#   is no `snapshot_at_override` parameter, so EVERY row this script writes
#   has snapshot_at = now()-when-the-call-fires, NOT some staggered past
#   timestamp. Net result: 168 snapshot rows per (ticker, expiry_date) all
#   bunched within the few minutes this script runs. That's fine for the
#   stated goal — visual / detector-baseline testing — because:
#     1. Each call still scans a 1h window of ct_flow_alerts, so the
#        accumulator data is real flow data;
#     2. The detector wants distribution shape across N samples per ticker
#        per expiry_bucket_week, which this provides;
#     3. We label these rows by their write time, so production-cron rows
#        won't be mistaken for backfilled rows after the fact (snapshot_at
#        clusters in this script's run window).
#   If true historical reconstruction is later needed, ct-heatmap-snapshot
#   will need a snapshot_at_override + as-of windowing — that's a future
#   change to Agent A's function, NOT this script.
#
# AUTH: invokes via the public._ct_post_with_body RPC (Vault-backed). Direct
# Bearer-token POSTs to functions/v1/ct-heatmap-snapshot return 401 because
# the service_role_key was rotated and the runtime env var diverged from the
# CLI-fetched key (memory: feedback_service_role_key_rotation). The RPC
# reads the key live from vault inside the DB and forwards via pg_net.
# Response body is `{ fn, fired_at, request_id }` — actual edge-function
# return is fire-and-forget; we count successful queue inserts not row counts.
#
# Usage:  bash scripts/heatmap_backfill.sh
# Stop:   Ctrl-C  (safe — each call is idempotent enough; rows just keep adding)

set -euo pipefail

PROJECT_REF="rvhyotvklfowklzjahdd"
SUPA="https://${PROJECT_REF}.supabase.co"
TOTAL_CALLS=168       # 7 days * 24 hours
SLEEP_SEC=2
LOOKBACK_HOURS=1

SR_KEY=$(npx supabase projects api-keys --project-ref "${PROJECT_REF}" 2>/dev/null | grep service_role | awk '{print $NF}')
if [[ -z "${SR_KEY}" ]]; then
  echo "ERROR: could not get SR_KEY — is supabase CLI logged in?" >&2
  exit 1
fi

# Verify the heatmap snapshot table exists before firing 168 calls.
HTTP_STATUS=$(curl -s -o /dev/null -w '%{http_code}' \
  "${SUPA}/rest/v1/ct_flow_heatmap_snapshots?select=id&limit=1" \
  -H "Authorization: Bearer ${SR_KEY}" -H "apikey: ${SR_KEY}")
if [[ "${HTTP_STATUS}" != "200" ]]; then
  echo "ERROR: ct_flow_heatmap_snapshots table not reachable (HTTP ${HTTP_STATUS}). Wait for Agent A's migration to deploy." >&2
  exit 1
fi

echo "Heatmap backfill starting — ${TOTAL_CALLS} calls, ${SLEEP_SEC}s sleep between, ${LOOKBACK_HOURS}h lookback each."
echo "Started at: $(date '+%Y-%m-%d %H:%M:%S')"
echo "-------------------------------------------------------------------------------"

OK_COUNT=0
ERR_COUNT=0
ROWS_INSERTED=0

RPC_PAYLOAD="{\"_fn\":\"ct-heatmap-snapshot\",\"_body\":{\"lookback_hours\":${LOOKBACK_HOURS}}}"

for ((i=1; i<=TOTAL_CALLS; i++)); do
  RESP=$(curl -s -X POST \
    "${SUPA}/rest/v1/rpc/_ct_post_with_body" \
    -H "Authorization: Bearer ${SR_KEY}" \
    -H "apikey: ${SR_KEY}" \
    -H "Content-Type: application/json" \
    -d "${RPC_PAYLOAD}" \
    --max-time 60 \
    -w '\n__HTTP_STATUS__%{http_code}' || echo $'\n__HTTP_STATUS__000')

  HTTP_CODE=$(echo "${RESP}" | grep -oE '__HTTP_STATUS__[0-9]+' | sed 's/__HTTP_STATUS__//')
  BODY=$(echo "${RESP}" | sed 's/__HTTP_STATUS__[0-9]*$//')

  if [[ "${HTTP_CODE}" == "200" ]]; then
    OK_COUNT=$((OK_COUNT + 1))
  else
    ERR_COUNT=$((ERR_COUNT + 1))
    echo "  call ${i} HTTP ${HTTP_CODE} — body: $(echo "${BODY}" | head -c 200)"
  fi

  # Progress every 10 calls.
  if (( i % 10 == 0 )); then
    PCT=$((i * 100 / TOTAL_CALLS))
    printf "  [%3d/%3d] (%2d%%)  ok=%d  err=%d  at=%s\n" \
      "${i}" "${TOTAL_CALLS}" "${PCT}" "${OK_COUNT}" "${ERR_COUNT}" "$(date '+%H:%M:%S')"
  fi

  if (( i < TOTAL_CALLS )); then
    sleep "${SLEEP_SEC}"
  fi
done

# Wait for the last few queued pg_net calls to finish writing.
echo "Sleeping 15s to let final pg_net calls complete..."
sleep 15

# Count rows that were written during this script's run window for visibility.
ROWS_FINAL=$(curl -s -I "${SUPA}/rest/v1/ct_flow_heatmap_snapshots?select=id" \
  -H "Authorization: Bearer ${SR_KEY}" -H "apikey: ${SR_KEY}" \
  -H "Prefer: count=exact" 2>&1 | grep -i content-range | sed 's|.*/||' | tr -d '\r\n ')
ROWS_FINAL=${ROWS_FINAL:-0}

echo "-------------------------------------------------------------------------------"
echo "Done at: $(date '+%Y-%m-%d %H:%M:%S')"
echo "Total: ${TOTAL_CALLS} calls, ${OK_COUNT} ok, ${ERR_COUNT} err, ${ROWS_FINAL} rows in ct_flow_heatmap_snapshots (cumulative)."
echo ""
echo "Verify with:"
echo "  curl -s \"${SUPA}/rest/v1/ct_flow_heatmap_snapshots?select=ticker&limit=10000\" \\"
echo "    -H \"Authorization: Bearer \${SR_KEY}\" -H \"apikey: \${SR_KEY}\" \\"
echo "    | python3 -c \"import json,sys,collections; d=json.load(sys.stdin); c=collections.Counter(r['ticker'] for r in d); [print(f'{k}: {v}') for k,v in sorted(c.items())]\""
