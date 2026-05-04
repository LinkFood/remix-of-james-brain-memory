#!/bin/bash
# linkjac_cotrader_watch.sh — live ops monitor for Co-Trader RTH session.
#
# Companion to docs/LINKJAC_COTRADER_PLAYBOOK.md. Run during the trading
# session to track:
#   - Watchlist purity (100% expected — UW filter at insertion)
#   - UW budget % and minute remaining (tier-aware throttle should kick in
#     at 70/85/95% if poller is auto-throttling correctly)
#   - Per-detector flag counts (all detectors should fire today)
#   - Claude cost burn
#   - Unresolved cron failures (last 24h)
#   - ct_flow_alerts ingest count
#   - Slack push quality (no "null BULLISH..." prefix)
#   - New detector watermarks (should advance every 5 min RTH)
#   - Temporal validator warnings count today (post-2026-04-30 hardening)
#   - UW cache hit rate breadcrumbs (post-2026-04-30 dedup layer)
#
# Usage:  bash /Users/jameschellis/jac-agent-os/scripts/linkjac_cotrader_watch.sh
# Stop:   Ctrl-C
# Override interval:  INTERVAL_SEC=60 bash ...
#
# What changed 2026-04-30 → 2026-05-02 (current as-of):
#   - Synthesis Layer Phases 0-8 shipped (single buildClaudeContext, 9 organs, telemetry)
#   - System Warden live (27 invariants, 30-min cron, Slack on state-change)
#   - Specialist Recall property live (10th organ, 3-state outcome rendering)
#   - tickerCoherenceValidator kills data-fabrication hallucination class
#   - Budget views ET-bucketed (no more UTC-rollover zero-out)
#   - Pulse v2 regime classification + analog history (4 tables, HNSW, brain organ #11)
#     First RTH auto-fires Monday 2026-05-04 — every 5 min × 11 entities = ~132 rows/h
#   - Specialist Scoreboard v2 multi-axis grading (4 tables, K=4 lifecycle gate)
#   - V1 scoreboard NULL-specialist fix shipped 2026-05-02 — TONIGHT 23:00 UTC IS THE
#     FIRST WEEKDAY FIRE POST-FIX. If row lands fresh tomorrow → class-killed for real.
#   - Forensic post-op corpus: ct_flag_analysis_corpus (5,255 rows) + 3 helper RPCs
#     + ct_observed_patterns + warden invariant. 4 patterns captured (id 8-11).
#   - Captain Into The Storm governing image landed (build-time discipline only —
#     runtime preamble wire DEFERRED to 2026-05-15 per recall experiment design)
#
# KNOWN OPEN: ct-signature-watcher has a local copy of inferPredictedSource() that
# never got the 2026-04-28 RepeatedHits-put fix. Half of "puts -21pp" pattern is
# artifact. Structural fix is import inferDirection from _shared. Not blocking RTH.

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
  echo "  Co-Trader Live Watch — ${TS}  (${TS_UTC})"
  echo "  Synthesis Layer + Warden + Specialist Recall live since 2026-05-01"
  echo "==============================================================================="

  # --- PROBES (active health checks — silent-failure catchers, added 2026-05-04) ---
  # Why each probe exists: each maps to a real silent failure that bit us today.
  #   1. Flow Butterfly RPC  → catches PGRST overload conflicts (commit e0e9109)
  #   2. Regime capture freshness → catches cron registration drift (corpus class)
  #   3. Calendar coherence  → catches "pre_event_macro forever" misclass (2fde4fa)
  #   4. Pipeline ratio      → catches data starvation upstream of pulse (29a2e4a)
  echo ""
  echo "PROBES (active checks — these caught today's bugs in retrospect)"
  echo "-------------------------------------------------------------------------------"
  # Probe 1: Flow Butterfly RPC must return data when called with a recent window.
  PROBE_BB=$(curl -s -X POST "${SUPA}/rest/v1/rpc/ct_net_premium_series" \
    -H "Authorization: Bearer ${SR_KEY}" -H "apikey: ${SR_KEY}" -H "Content-Type: application/json" \
    -d "{\"p_ticker\":null,\"p_since\":\"$(date -u -v-30M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '30 minutes ago' +%Y-%m-%dT%H:%M:%SZ)\"}" 2>/dev/null \
    | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    if isinstance(d,list): print(f'OK {len(d)} pts' if len(d)>0 else 'WARN 0 points')
    else: print(f'FAIL {d.get(\"code\",\"?\")}: {d.get(\"message\",\"?\")[:50]}')
except Exception as e: print(f'FAIL {e}')")
  ICON_BB="✅"; [[ "$PROBE_BB" == FAIL* || "$PROBE_BB" == WARN* ]] && ICON_BB="⚠ "
  printf "  %s Flow Butterfly RPC          %s\n" "$ICON_BB" "$PROBE_BB"

  # Probe 2: ct-regime-capture cadence — bucket should be within last 10 min during RTH.
  PROBE_REGIME=$(curl -s "${SUPA}/rest/v1/ct_regime_history?select=bucket_ts&order=bucket_ts.desc&limit=1" \
    -H "Authorization: Bearer ${SR_KEY}" -H "apikey: ${SR_KEY}" 2>/dev/null \
    | python3 -c "
import json,sys
from datetime import datetime, timezone
try:
    d=json.load(sys.stdin)
    if not d: print('FAIL no rows')
    else:
        ts=datetime.fromisoformat(d[0]['bucket_ts'].replace('+00:00','+00:00'))
        age=int((datetime.now(timezone.utc)-ts).total_seconds()/60)
        # During RTH (13:30-20:00 UTC weekdays) expect <=10 min lag
        now=datetime.now(timezone.utc); is_rth = now.weekday()<5 and 13.5 <= now.hour + now.minute/60 <= 20
        thresh = 10 if is_rth else 70
        print(f'OK age={age}m' if age<=thresh else f'WARN age={age}m (>{thresh}m threshold)')
except Exception as e: print(f'FAIL {e}')")
  ICON_RG="✅"; [[ "$PROBE_REGIME" == FAIL* || "$PROBE_REGIME" == WARN* ]] && ICON_RG="⚠ "
  printf "  %s Regime capture cadence      %s\n" "$ICON_RG" "$PROBE_REGIME"

  # Probe 3: Calendar coherence — if MARKET regime is pre_event_macro, the
  # event MUST exist in ct_events within the proximity window. Today's FOMC
  # misclass came from past events being clamped to "today."
  PROBE_CAL=$(python3 -c "
import json, urllib.request, urllib.parse, datetime, ssl
ctx = ssl.create_default_context()
def fetch(url):
    req = urllib.request.Request(url, headers={'Authorization': 'Bearer ${SR_KEY}', 'apikey': '${SR_KEY}'})
    return json.loads(urllib.request.urlopen(req, context=ctx, timeout=10).read())
try:
    cls = fetch('${SUPA}/rest/v1/ct_regime_classifications?ticker=is.null&select=classification&order=last_updated.desc&limit=1')
    if not cls: print('SKIP no MARKET row'); exit()
    market_class = cls[0]['classification']
    if market_class != 'pre_event_macro':
        print(f'OK MARKET={market_class}')
    else:
        today=datetime.date.today().isoformat()
        h5=(datetime.date.today()+datetime.timedelta(days=5)).isoformat()
        evts = fetch(f'${SUPA}/rest/v1/ct_events?event_type=eq.econ&event_date=gte.{today}&event_date=lte.{h5}&select=title,event_date')
        keep = [e for e in evts if any(k in (e.get('title') or '').lower() for k in ['fomc','interest-rate decision','cpi','inflation','jobs report','unemployment rate','payroll','nfp'])]
        if keep:
            print(f'OK pre_event_macro + {len(keep)} real event(s) within 5d')
        else:
            print(f'WARN MARKET=pre_event_macro but NO matching FOMC/CPI/jobs in 5d')
except Exception as e: print(f'FAIL {e}')")
  ICON_CAL="✅"; [[ "$PROBE_CAL" == FAIL* || "$PROBE_CAL" == WARN* ]] && ICON_CAL="⚠ "
  printf "  %s Calendar coherence          %s\n" "$ICON_CAL" "$PROBE_CAL"

  # Probe 4: Pipeline cross-check — pulse_events should have meaningful sweep
  # share when flow_alerts is busy. Today's bug: flow_alerts:1289 / pulse_events
  # sweep:0 because the bridge migration hadn't shipped yet. Use HEAD requests
  # (count-only, no body) which are 5-10x faster on PostgREST than full counts.
  FA_COUNT=$(curl -s --max-time 12 -I "${SUPA}/rest/v1/ct_flow_alerts?ingested_at=gte.${TODAY}T13:30:00Z&select=id" \
    -H "Authorization: Bearer ${SR_KEY}" -H "apikey: ${SR_KEY}" -H "Prefer: count=exact" -H "Range: 0-0" 2>&1 | grep -i content-range | sed 's|.*/||' | tr -d '\r\n ')
  PE_COUNT=$(curl -s --max-time 12 -I "${SUPA}/rest/v1/ct_pulse_events?event_ts=gte.${TODAY}T13:30:00Z&signal_type=eq.sweep&select=id" \
    -H "Authorization: Bearer ${SR_KEY}" -H "apikey: ${SR_KEY}" -H "Prefer: count=exact" -H "Range: 0-0" 2>&1 | grep -i content-range | sed 's|.*/||' | tr -d '\r\n ')
  PROBE_PIPE=$(python3 -c "
fa=int('${FA_COUNT:-0}' or 0); pe=int('${PE_COUNT:-0}' or 0)
if fa < 50: print(f'SKIP flow_alerts={fa} (pre-volume)')
else:
    ratio = pe / fa
    if ratio < 0.05: print(f'WARN flow={fa} sweep={pe} ({ratio:.1%}) — bridge stalled?')
    else: print(f'OK flow={fa} sweep={pe} ({ratio:.1%})')")
  ICON_PIPE="✅"; [[ "$PROBE_PIPE" == FAIL* || "$PROBE_PIPE" == WARN* ]] && ICON_PIPE="⚠ "
  printf "  %s Pipeline ratio              %s\n" "$ICON_PIPE" "$PROBE_PIPE"

  # --- ANOMALIES (today vs 7-weekday median, ⚠ = >40% drop, added 2026-05-04) ---
  echo ""
  echo "ANOMALIES (today vs 7-weekday median — silent-failure tripwire)"
  echo "-------------------------------------------------------------------------------"
  python3 << PYEOF
import json, urllib.request, datetime, ssl
ctx = ssl.create_default_context()
SUPA='${SUPA}'; SR='${SR_KEY}'; TODAY='${TODAY}'

def fetch_count(table, qs):
    req = urllib.request.Request(f'{SUPA}/rest/v1/{table}?{qs}&select=id', headers={'Authorization': f'Bearer {SR}', 'apikey': SR, 'Prefer': 'count=exact', 'Range': '0-0'})
    r = urllib.request.urlopen(req, context=ctx, timeout=15)
    cr = r.headers.get('content-range','0/0')
    return int(cr.split('/')[-1]) if '/' in cr else 0

def fetch_cost(qs):
    req = urllib.request.Request(f'{SUPA}/rest/v1/ct_claude_usage?{qs}&select=cost_usd', headers={'Authorization': f'Bearer {SR}', 'apikey': SR})
    return sum((r.get('cost_usd') or 0) for r in json.loads(urllib.request.urlopen(req, context=ctx, timeout=20).read()))

def median(xs):
    s = sorted(xs); n = len(s)
    if n == 0: return 0
    return s[n//2] if n % 2 else (s[n//2-1] + s[n//2]) / 2

today_dt = datetime.date.fromisoformat(TODAY)
days = []
d = today_dt - datetime.timedelta(days=1)
while len(days) < 7:
    if d.weekday() < 5: days.append(d.isoformat())
    d -= datetime.timedelta(days=1)

def deviation(label, today_v, hist_vs, fmt='{:>8}'):
    m = median(hist_vs)
    if m == 0:
        pct_str, icon = 'n/a', ' '
    else:
        pct = (today_v - m) / m * 100
        pct_str = f'{pct:+.0f}%'
        icon = '⚠' if pct < -40 else ' '
    val_str = fmt.format(today_v)
    med_str = fmt.format(round(m))
    print(f'  {icon} {label:<28} {val_str}    (median {med_str})  {pct_str}')

try:
    fa_t = fetch_count('ct_flow_alerts', f'ingested_at=gte.{TODAY}T13:30:00Z')
    df_t = fetch_count('ct_flags', f'created_at=gte.{TODAY}T13:30:00Z')
    hy_t = fetch_count('ct_hypotheses', f'created_at=gte.{TODAY}T00:00:00Z')
    tig_t = fetch_count('ct_claude_usage', f'source=eq.ct-trade-idea-generator&created_at=gte.{TODAY}T00:00:00Z')
    cost_t = fetch_cost(f'created_at=gte.{TODAY}T00:00:00Z')

    fa_h, df_h, hy_h, tig_h, cost_h = [], [], [], [], []
    for ds in days:
        fa_h.append(fetch_count('ct_flow_alerts', f'ingested_at=gte.{ds}T13:30:00Z&ingested_at=lt.{ds}T20:30:00Z'))
        df_h.append(fetch_count('ct_flags', f'created_at=gte.{ds}T13:30:00Z&created_at=lt.{ds}T20:30:00Z'))
        hy_h.append(fetch_count('ct_hypotheses', f'created_at=gte.{ds}T00:00:00Z&created_at=lt.{ds}T23:59:59Z'))
        tig_h.append(fetch_count('ct_claude_usage', f'source=eq.ct-trade-idea-generator&created_at=gte.{ds}T00:00:00Z&created_at=lt.{ds}T23:59:59Z'))
        cost_h.append(fetch_cost(f'created_at=gte.{ds}T00:00:00Z&created_at=lt.{ds}T23:59:59Z'))

    deviation('flow_alerts (RTH)',         fa_t,  fa_h)
    deviation('detector fires (RTH)',      df_t,  df_h)
    deviation('hypotheses created',        hy_t,  hy_h)
    deviation('trade-idea-gen Claude',     tig_t, tig_h)

    cost_med = median(cost_h)
    cost_pct = ((cost_t - cost_med) / cost_med * 100) if cost_med > 0 else 0
    cost_icon = '⚠' if cost_med > 0 and cost_t < cost_med * 0.6 else ' '
    label = 'claude $ today'
    print(f'  {cost_icon} {label:<28} \${cost_t:>7.2f}    (median \${cost_med:>7.2f})  {cost_pct:+.0f}%')
except Exception as e:
    print(f'  err: {e}')
PYEOF


  echo ""
  echo "WARDEN — invariant-based self-supervision (Slack only on state-change)"
  echo "-------------------------------------------------------------------------------"
  curl -s -X POST "${SUPA}/rest/v1/rpc/get_warden_health" \
    -H "Authorization: Bearer ${SR_KEY}" -H "apikey: ${SR_KEY}" \
    -H "Content-Type: application/json" -d '{"window_hours":24}' 2>/dev/null \
    | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin); t=d['totals']
    icon='🟢' if t['failing']==0 and t['errored']==0 else ('🟡' if t['critical_failing']==0 else '🔴')
    print(f\"  {icon} {t['passing']}/{t['total_enabled']} passing  ·  failing={t['failing']}  errored={t['errored']}  critical={t['critical_failing']}\")
    for f in d.get('failures',[])[:6]:
        print(f\"     [{f.get('severity','?'):8}] {f.get('name','?'):50} v={f.get('last_value')}  → {f.get('runbook_path','')}\")
except Exception as e: print(f'  err: {e}')"

  # --- BRAIN HEALTH (synthesis layer telemetry) ---
  echo ""
  echo "BRAIN — buildClaudeContext orchestrator (9 organs, fire-and-forget telemetry)"
  echo "-------------------------------------------------------------------------------"
  curl -s -X POST "${SUPA}/rest/v1/rpc/get_brain_health" \
    -H "Authorization: Bearer ${SR_KEY}" -H "apikey: ${SR_KEY}" \
    -H "Content-Type: application/json" -d '{"window_hours":24}' 2>/dev/null \
    | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin); t=d['totals']
    print(f\"  invocations={t['total_invocations']}  helpers={t['distinct_helpers']}  consumers={t['distinct_consumers']}  errors={t['total_errors']}  warnings={t['total_warnings']}\")
except Exception as e: print(f'  err: {e}')"

  # --- PULSE V2 REGIME (new 2026-05-02 — first auto-fires Monday 2026-05-04) ---
  echo ""
  echo "PULSE V2 REGIME (off-hours hourly / RTH every 5 min — 11 entities/bucket)"
  echo "-------------------------------------------------------------------------------"
  REGIME_LATEST=$(curl -s "${SUPA}/rest/v1/ct_regime_history?select=bucket_ts&order=bucket_ts.desc&limit=1" \
    -H "Authorization: Bearer ${SR_KEY}" -H "apikey: ${SR_KEY}" 2>/dev/null \
    | python3 -c "import json,sys;d=json.load(sys.stdin);print(d[0]['bucket_ts'][:16] if d else 'none')")
  REGIME_24H=$(curl -s -I "${SUPA}/rest/v1/ct_regime_history?bucket_ts=gte.$(date -u -v-24H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)&select=id" \
    -H "Authorization: Bearer ${SR_KEY}" -H "apikey: ${SR_KEY}" -H "Prefer: count=exact" 2>&1 | grep -i content-range | sed 's|.*/||' | tr -d '\r\n ')
  [[ -z "$REGIME_24H" ]] && REGIME_24H=0
  printf "  latest bucket: %s  ·  rows last 24h: %s (RTH expects ≥600)\n" "$REGIME_LATEST" "$REGIME_24H"

  # ct_pulse_events — fed by ct-pulse-tick (every 5 min RTH) from 6 sources.
  # Post-2026-05-04 bridge: ct_flow_alerts is the canonical sweep source. If
  # signal_type='sweep' count drops to ~0 during RTH, the bridge is stalled.
  PULSE_TODAY=$(curl -s -I "${SUPA}/rest/v1/ct_pulse_events?event_ts=gte.${TODAY}T13:30:00Z&select=id" \
    -H "Authorization: Bearer ${SR_KEY}" -H "apikey: ${SR_KEY}" -H "Prefer: count=exact" 2>&1 | grep -i content-range | sed 's|.*/||' | tr -d '\r\n ')
  [[ -z "$PULSE_TODAY" ]] && PULSE_TODAY=0
  PULSE_BREAKDOWN=$(curl -s "${SUPA}/rest/v1/ct_pulse_events?event_ts=gte.${TODAY}T13:30:00Z&select=signal_type" \
    -H "Authorization: Bearer ${SR_KEY}" -H "apikey: ${SR_KEY}" 2>/dev/null \
    | python3 -c "
import json,sys
from collections import Counter
d=json.load(sys.stdin)
c=Counter(r['signal_type'] for r in d)
print(' / '.join(f'{k}:{v}' for k,v in c.most_common()) or 'empty')")
  printf "  pulse_events since bell: %s  (%s)\n" "$PULSE_TODAY" "$PULSE_BREAKDOWN"

  # Per-ticker regime classifications — `unknown` count >=8 means signals are
  # starved. Should be 4-6 unknown on a quiet tape, 0-2 on a directional day.
  REGIME_CLASS=$(curl -s "${SUPA}/rest/v1/ct_regime_classifications?select=ticker,classification&order=last_updated.desc&limit=11" \
    -H "Authorization: Bearer ${SR_KEY}" -H "apikey: ${SR_KEY}" 2>/dev/null \
    | python3 -c "
import json,sys
from collections import Counter
d=json.load(sys.stdin)
unknown_count = sum(1 for r in d if r['classification']=='unknown' and r.get('ticker'))
total_per_ticker = sum(1 for r in d if r.get('ticker'))
market = next((r for r in d if not r.get('ticker')), None)
mclass = market['classification'] if market else 'none'
print(f'MARKET={mclass}  ·  per-ticker unknown: {unknown_count}/{total_per_ticker}')")
  printf "  classifications: %s\n" "$REGIME_CLASS"

  # --- HYPOTHESIS PIPELINE (proposer → trade-idea-generator → book-writer) ---
  # When proposer Claude calls error, the whole downstream Claude pipeline
  # goes silent — no hypotheses → no trade ideas → no book entries → daily
  # Claude cost drops from ~$18 to ~$4. 2026-05-04 outage cause: prose-mode
  # JSON parse breaking 56% of fires (fixed via forced tool-use d0ce20f).
  echo ""
  echo "HYPOTHESIS PIPELINE (proposer fires 11/15/19 UTC weekdays — Sonnet)"
  echo "-------------------------------------------------------------------------------"
  PROP_OUTCOMES=$(curl -s "${SUPA}/rest/v1/ct_claude_decisions?decision_type=eq.propose_hypothesis&created_at=gte.$(date -u -v-24H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)&select=outcome" \
    -H "Authorization: Bearer ${SR_KEY}" -H "apikey: ${SR_KEY}" 2>/dev/null \
    | python3 -c "
import json,sys
from collections import Counter
d=json.load(sys.stdin)
c=Counter(r.get('outcome','?') for r in d)
errs=sum(v for k,v in c.items() if 'claude_error' in (k or ''))
total=sum(c.values())
print(f'last 24h: {total} fires  ·  errors: {errs}' + (' ⚠' if errs > 0 else ''))")
  printf "  %s\n" "$PROP_OUTCOMES"

  HYP_TODAY=$(curl -s -I "${SUPA}/rest/v1/ct_hypotheses?created_at=gte.${TODAY}T00:00:00Z&select=id" \
    -H "Authorization: Bearer ${SR_KEY}" -H "apikey: ${SR_KEY}" -H "Prefer: count=exact" 2>&1 | grep -i content-range | sed 's|.*/||' | tr -d '\r\n ')
  TIG_TODAY=$(curl -s -I "${SUPA}/rest/v1/ct_claude_usage?source=eq.ct-trade-idea-generator&created_at=gte.${TODAY}T00:00:00Z&select=id" \
    -H "Authorization: Bearer ${SR_KEY}" -H "apikey: ${SR_KEY}" -H "Prefer: count=exact" 2>&1 | grep -i content-range | sed 's|.*/||' | tr -d '\r\n ')
  printf "  hypotheses created today: %s  ·  trade-idea-generator calls today: %s\n" "${HYP_TODAY:-0}" "${TIG_TODAY:-0}"

  # --- SCOREBOARD FRESHNESS (v1 nightly 23 UTC M-F · v2 nightly 03 UTC) ---
  echo ""
  echo "SPECIALIST SCOREBOARDS (v1=23 UTC M-F · v2=03 UTC daily)"
  echo "-------------------------------------------------------------------------------"
  V1_LATEST=$(curl -s "${SUPA}/rest/v1/ct_specialist_scoreboard?select=computed_at&order=computed_at.desc&limit=1" \
    -H "Authorization: Bearer ${SR_KEY}" -H "apikey: ${SR_KEY}" 2>/dev/null \
    | python3 -c "import json,sys;d=json.load(sys.stdin);print(d[0]['computed_at'][:19] if d else 'none')")
  V2_LATEST=$(curl -s "${SUPA}/rest/v1/ct_specialist_scoreboard_v2?select=last_updated&order=last_updated.desc&limit=1" \
    -H "Authorization: Bearer ${SR_KEY}" -H "apikey: ${SR_KEY}" 2>/dev/null \
    | python3 -c "import json,sys;d=json.load(sys.stdin);print(d[0]['last_updated'][:19] if d else 'none')")
  GRADE_24H=$(curl -s -I "${SUPA}/rest/v1/ct_specialist_grade_axes?graded_at=gte.$(date -u -v-24H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)&select=flag_id" \
    -H "Authorization: Bearer ${SR_KEY}" -H "apikey: ${SR_KEY}" -H "Prefer: count=exact" 2>&1 | grep -i content-range | sed 's|.*/||' | tr -d '\r\n ')
  [[ -z "$GRADE_24H" ]] && GRADE_24H=0
  printf "  v1 latest:  %s  (next fire 23:00 UTC tonight — VALIDATION OF NULL-FIX)\n" "$V1_LATEST"
  printf "  v2 latest:  %s  (last nightly fire)\n" "$V2_LATEST"
  printf "  grade_axes rows last 24h: %s\n" "$GRADE_24H"

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

  # --- TEMPORAL VALIDATOR WARNINGS TODAY (post-2026-04-30) ---
  echo ""
  echo "TEMPORAL VALIDATOR WARNINGS — rows today across consumers"
  echo "-------------------------------------------------------------------------------"
  for src in ct_eod_summaries ct_eod_reports ct_tape_commentary; do
    NROWS=$(curl -s "${SUPA}/rest/v1/${src}?select=id&created_at=gte.${TODAY}T00:00:00Z" \
      -H "Authorization: Bearer ${SR_KEY}" -H "apikey: ${SR_KEY}" \
      -H "Prefer: count=exact" -I 2>&1 | grep -i content-range | sed 's|.*/||' | tr -d '\r\n ')
    [[ -z "$NROWS" ]] && NROWS=0
    printf "  %-26s rows today: %s\n" "$src" "$NROWS"
  done

  # --- UW CACHE / UNKNOWN CALLER VISIBILITY ---
  echo ""
  echo "UW UNKNOWN-CALLER CHECK (Saturday LB8 audit target — should drop with cache)"
  echo "-------------------------------------------------------------------------------"
  UNK=$(curl -s "${SUPA}/rest/v1/ct_uw_usage?observed_at=gte.${TODAY}T13:00:00Z&caller=eq.unknown&select=id" \
    -H "Authorization: Bearer ${SR_KEY}" -H "apikey: ${SR_KEY}" -H "Prefer: count=exact" -I 2>&1 \
    | grep -i content-range | sed 's|.*/||' | tr -d '\r\n ')
  [[ -z "$UNK" ]] && UNK=0
  printf "  unknown-caller calls today: %s\n" "$UNK"

  # --- POST-CLOSE LANDED FIRES (only when past 21:00 UTC) ---
  HOUR_NUM=$(date -u +%H)
  if [[ $HOUR_NUM -ge 21 ]]; then
    echo ""
    echo "POST-CLOSE LANDED FIRES"
    echo "-------------------------------------------------------------------------------"
    EODSUM=$(curl -s "${SUPA}/rest/v1/ct_eod_summaries?session_date=eq.${TODAY}&select=session_date,regime_tag,snapshot_hit_rate" \
      -H "Authorization: Bearer ${SR_KEY}" -H "apikey: ${SR_KEY}" 2>/dev/null \
      | python3 -c "import json,sys
d=json.load(sys.stdin);r=d[0] if d else None
print(f'regime={r[\"regime_tag\"]} hit_rate={r[\"snapshot_hit_rate\"]}%' if r else 'NOT YET')")
    echo "  ct-eod-summary:  $EODSUM"
    EODREP=$(curl -s "${SUPA}/rest/v1/ct_eod_reports?session_date=eq.${TODAY}&select=session_date,scorecard_summary" \
      -H "Authorization: Bearer ${SR_KEY}" -H "apikey: ${SR_KEY}" 2>/dev/null \
      | python3 -c "import json,sys
d=json.load(sys.stdin);r=d[0] if d else None
s=r['scorecard_summary'] if r else None
print(f'wins={s.get(\"wins\")} loss={s.get(\"losses\")} score={s.get(\"score_pct\")}%' if s else 'NOT YET')")
    echo "  ct-eod-report:   $EODREP"
  fi

  echo ""
  echo "Next refresh in ${INTERVAL_SEC}s — Ctrl-C to stop"
  sleep "${INTERVAL_SEC}"
done
