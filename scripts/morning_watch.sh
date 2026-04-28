#!/bin/bash
# tuesday_watch.sh — live ops monitor for Co-Trader Tuesday open (2026-04-28).
# Polls every 5 min: per-detector flag counts, UW headroom, cost burn,
# cron failure count, watermark advancement, AND watchlist-purity check
# (new for 2026-04-28 — verifies the WATCHLIST filter at insertion).
#
# Usage:  bash /tmp/tuesday_watch.sh
# Stop:   Ctrl-C
#
# Tuesday-specific things to watch (post the 15 fixes shipped 2026-04-27):
#   - Watchlist purity should be 100% (was 23% Monday — off-watchlist noise)
#   - UW should track ~30% by close (was 100% Monday at 6:42 PM ET)
#   - All 7 new detectors should fire flags (was 0 pre-bigint-fix Monday)
#   - Slack pushes should NOT start with "null BULLISH..."

set -uo pipefail

PROJECT_REF="rvhyotvklfowklzjahdd"
SUPA="https://${PROJECT_REF}.supabase.co"
INTERVAL_SEC="${INTERVAL_SEC:-300}"  # 5 min default; override with INTERVAL_SEC=60

SR_KEY=$(npx supabase projects api-keys --project-ref ${PROJECT_REF} 2>/dev/null | grep service_role | awk '{print $NF}')
if [[ -z "$SR_KEY" ]]; then
  echo "ERROR: could not get SR_KEY — is supabase CLI logged in?"
  exit 1
fi

DETECTORS=(
  signature_v1
  cluster_default
  cluster_slow_stacker
  whale_v1
  unusual_oi_v1
  pair_qqq_iwm_v1
  smart_money_repeat_v1
  weekly_atm_voi_v1
  zerodte_opening_call_v1
  zerodte_put_voi_extreme_v1
  small_cap_inverted_put_v1
)

WATCHLIST="NVDA,AAPL,MSFT,GOOGL,AMZN,META,TSLA,QQQ,SPY,IWM"

count_flags_today() {
  local det=$1
  local today=$(date -u +%Y-%m-%d)
  curl -s -I "${SUPA}/rest/v1/ct_flags?detector_id=eq.${det}&created_at=gte.${today}T13:30:00Z&select=id" \
    -H "Authorization: Bearer ${SR_KEY}" -H "apikey: ${SR_KEY}" \
    -H "Prefer: count=exact" 2>&1 | grep -i content-range | sed 's|.*/||' | tr -d '\r\n '
}

clear_screen() { printf "\033c"; }

while true; do
  clear_screen
  TS=$(date '+%Y-%m-%d %H:%M:%S')
  TS_UTC=$(date -u '+%H:%M UTC')
  TODAY=$(date -u +%Y-%m-%d)
  echo "==============================================================================="
  echo "  Co-Trader Tuesday Watch — ${TS}  (${TS_UTC})"
  echo "  Tracking 15 fixes shipped Mon 2026-04-27 evening"
  echo "==============================================================================="

  # --- WATCHLIST PURITY (new for Tuesday) ---
  echo ""
  echo "WATCHLIST PURITY (must be 100% — confirms ct-flow-ingester filter is live)"
  echo "-------------------------------------------------------------------------------"
  ALL=$(curl -s -I "${SUPA}/rest/v1/ct_flow_alerts?ingested_at=gte.${TODAY}T13:30:00Z&select=alert_id" \
    -H "Authorization: Bearer ${SR_KEY}" -H "apikey: ${SR_KEY}" -H "Prefer: count=exact" 2>&1 | grep -i content-range | sed 's|.*/||' | tr -d '\r\n ')
  WL=$(curl -s -I "${SUPA}/rest/v1/ct_flow_alerts?ingested_at=gte.${TODAY}T13:30:00Z&ticker=in.(${WATCHLIST})&select=alert_id" \
    -H "Authorization: Bearer ${SR_KEY}" -H "apikey: ${SR_KEY}" -H "Prefer: count=exact" 2>&1 | grep -i content-range | sed 's|.*/||' | tr -d '\r\n ')
  ALL=${ALL:-0}; WL=${WL:-0}
  if [[ $ALL -gt 0 ]]; then
    PCT=$(python3 -c "print(f'{$WL/$ALL*100:.0f}')")
    OFF=$((ALL - WL))
    FLAG="✅"
    [[ $PCT -lt 100 ]] && FLAG="⚠️ "
    printf "  %s  watchlist=%d / total=%d (%s%%)  off-watchlist=%d %s\n" "$FLAG" "$WL" "$ALL" "$PCT" "$OFF" "$([ $OFF -gt 0 ] && echo '← FILTER NOT WORKING')"
  else
    echo "  (no alerts ingested yet today — wait for first cron fire)"
  fi

  # --- DETECTOR FIRES TODAY ---
  echo ""
  echo "DETECTOR FIRES TODAY (post-bigint-fix all 11 should be alive)"
  echo "-------------------------------------------------------------------------------"
  printf "  %-32s %-10s\n" "detector" "today"
  for det in "${DETECTORS[@]}"; do
    cur=$(count_flags_today "$det")
    [[ -z "$cur" ]] && cur=0
    flag=" ·"
    [[ $cur -gt 0 ]] && flag=" 🟢"
    printf "  %-32s %-10s%s\n" "$det" "$cur" "$flag"
  done

  # --- BUDGETS ---
  echo ""
  echo "BUDGETS (target: UW ≤30% by close, was 100% Monday)"
  echo "-------------------------------------------------------------------------------"

  UW=$(curl -s "${SUPA}/rest/v1/ct_uw_usage_latest?session_date=eq.${TODAY}&select=daily_count,daily_limit,pct" \
    -H "Authorization: Bearer ${SR_KEY}" -H "apikey: ${SR_KEY}" 2>/dev/null | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    if d: r=d[0]; print(f\"{r.get('daily_count')}/{r.get('daily_limit')} ({r.get('pct')}%)\")
    else: print('--')
except: print('err')")
  printf "  %-32s %s\n" "UW today" "$UW"

  COST_TODAY=$(curl -s "${SUPA}/rest/v1/ct_claude_usage?created_at=gte.${TODAY}T00:00:00Z&select=cost_usd" \
    -H "Authorization: Bearer ${SR_KEY}" -H "apikey: ${SR_KEY}" 2>/dev/null | python3 -c "
import json,sys
try: d=json.load(sys.stdin); t=sum((r.get('cost_usd') or 0) for r in d); print(f\"\${t:.4f} ({len(d)} calls)\")
except: print('err')")
  printf "  %-32s %s\n" "CT Claude cost today" "$COST_TODAY"

  CRON_FAILS=$(curl -s -I "${SUPA}/rest/v1/ct_cron_failures?detected_at=gte.$(date -u -v-24H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)&resolved_at=is.null&select=id" \
    -H "Authorization: Bearer ${SR_KEY}" -H "apikey: ${SR_KEY}" -H "Prefer: count=exact" 2>&1 | grep -i content-range | sed 's|.*/||' | tr -d '\r\n ')
  [[ -z "$CRON_FAILS" ]] && CRON_FAILS=0
  printf "  %-32s %s\n" "Unresolved cron failures (24h)" "$CRON_FAILS"

  ALERTS_TODAY=$(curl -s -I "${SUPA}/rest/v1/ct_flow_alerts?ingested_at=gte.${TODAY}T00:00:00Z&select=alert_id" \
    -H "Authorization: Bearer ${SR_KEY}" -H "apikey: ${SR_KEY}" -H "Prefer: count=exact" 2>&1 | grep -i content-range | sed 's|.*/||' | tr -d '\r\n ')
  [[ -z "$ALERTS_TODAY" ]] && ALERTS_TODAY=0
  printf "  %-32s %s\n" "ct_flow_alerts ingested today" "$ALERTS_TODAY"

  # --- SLACK QUALITY (new — verify "null" prefix bug stays fixed) ---
  echo ""
  echo "SLACK QUALITY (no 'null BULLISH...' prefix should appear)"
  echo "-------------------------------------------------------------------------------"
  curl -s "${SUPA}/rest/v1/ct_slack_log?source=eq.flag&created_at=gte.${TODAY}T13:30:00Z&select=created_at,summary&order=created_at.desc&limit=3" \
    -H "Authorization: Bearer ${SR_KEY}" -H "apikey: ${SR_KEY}" 2>/dev/null | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    if not d: print('  (no flag pushes today yet)')
    else:
      for r in d:
        s=(r.get('summary') or '').replace(chr(10),' | ')[:80]
        prefix='⚠️  NULL' if s.startswith('null') else '✅      '
        print(f\"  {prefix}  {r['created_at'][11:19]}  {s}\")
except Exception as e: print(f'  err: {e}')"

  # --- NEW DETECTOR WATERMARKS ---
  echo ""
  echo "NEW DETECTOR WATERMARKS (should advance every 5 min RTH)"
  echo "-------------------------------------------------------------------------------"
  curl -s "${SUPA}/rest/v1/ct_detector_state?detector_id=in.(smart_money_repeat_v1,weekly_atm_voi_v1,zerodte_opening_call_v1,zerodte_put_voi_extreme_v1,small_cap_inverted_put_v1)&select=detector_id,last_processed_at,last_run_at" \
    -H "Authorization: Bearer ${SR_KEY}" -H "apikey: ${SR_KEY}" 2>/dev/null | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    for r in d:
        wm=(r.get('last_processed_at','?') or '?')[:19]
        lr=(r.get('last_run_at','?') or '?')[:19]
        print(f\"  {r['detector_id']:32}  watermark={wm}  last_run={lr}\")
except Exception as e: print('parse err:',e)
"

  echo ""
  echo "Next refresh in ${INTERVAL_SEC}s — Ctrl-C to stop"
  sleep "${INTERVAL_SEC}"
done
