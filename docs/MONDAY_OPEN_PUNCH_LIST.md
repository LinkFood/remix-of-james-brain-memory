# Monday 2026-04-27 Open — Bug Punch List

Found during pre-open + first 15 min of trading. Ordered by impact. Fix after close (16:00 ET) unless P0 repeats before then.

---

## P0 — Fix today after close (could repeat tomorrow open)

### 0. ct-print-grader cron too sparse for live RTH ✅ FIXED LIVE 2026-04-27
**Status:** Fixed mid-session via `20260427150000_grader_cron_faster_rth.sql`. Split single `*/30` cron into:
- `ct-print-grader-rth`: `*/10 13-20 * * 1-5` (every 10 min RTH+1h, weekdays)
- `ct-print-grader-offhours`: `0,30 0-12,21-23 * * *` (every 30 min off-hours, daily)

**Watch for tomorrow:** P/L coverage should stay ≥90% throughout RTH instead of sawtooth-ing 75%↔97% every 30 min.

---

### 0b. ~~Single-name 0DTE investigation~~ — RESOLVED, NOT A BUG
**Resolution (2026-04-27 mid-session):** Nasdaq added Mon/Wed expirations for AAPL, META, AMZN, GOOGL, TSLA, MSFT, NVDA, IBIT, AVGO effective 2026-01-26. First Monday expiry was Feb 2. Today's single-name 0DTE prints are legitimate — UW data is correct, pipeline is correct, `zerodte_*` detectors were correctly designed. See memory `reference_options_expiry_calendar.md` so future sessions don't re-question this.

---

### 1. FlowPulse "Today" window starts too narrow
**Symptom:** First 0-15 min of every session, the per-ticker FlowPulse table shows all zeros even when data is flowing. Caused real "is it broken?" panic this morning.

**Cause:** `computeTodayWindowMin()` returns `minutes-since-13:30-UTC`. At 9:31 ET that's 1 minute. RPC has nothing to aggregate.

**Files:**
- `src/hooks/useFlowPulse.ts:436` (`computeTodayWindowMin`)

**Fix options:**
- Floor at 15 min: `return Math.max(15, diffMin)`
- Or compute against earliest data point in `ct_flow_pulse_ticks` for today
- Or change the label from "Today" to something honest about the rolling window

---

### 2. Flag data quality — null specialist_ticker + bullish-on-puts
**Symptom:** All 319 backlog flags drained Slack as `null BULLISH flag score 85 — SPY260501P00709000` (PUT options labeled BULLISH). If new detectors fire today with the same upstream bug, real signals will spam.

**Cause:**
- `specialist_ticker` written as NULL on every flag in `ct_flags` from the Friday-Saturday batch
- `direction='bullish'` on every flag regardless of put/call symbol (the documented bullish-bias from `project_co_trader_specialist_bias_weekend.md`)

**Fix:**
- Add NOT NULL constraint on `ct_flags.specialist_ticker` (after backfilling existing NULLs from `option_symbol` parse)
- Either auto-derive direction from contract side at insert (PUT → bearish unless explicitly overridden by specialist) OR validate direction matches contract type and reject mismatches with a logged warning

**Watch for repeat today:** if any flag fires after open with `specialist_ticker IS NULL` or PUT+bullish mismatch, this is P0-now, not P0-after-close.

---

## P1 — Fix this week

### 2a. Glow/highlight box on contract drill goes away after ~1 sec
**Symptom:** Click an alarm → opens contract drill → highlight pulse fades in <1 second. Want it persistent until user clicks elsewhere.

**Likely fix:** CSS animation on `ContractDrillSheet` or the row highlight — currently a one-shot animation, change to sticky-on-mount until close/reselect.

**Files to check:**
- `src/components/co-trader/ContractDrillSheet.tsx`
- whichever parent component dispatches `setOpenAlertId`

---

### 2b. Ticker sparklines render only for some tickers (3/10)
**Symptom:** /tape top-bar ticker chips — sparklines show only on AAPL, GOOGL, AMZN. SPY, QQQ, IWM, MSFT, META, NVDA, TSLA blank. (Screenshot 10:21 ET 2026-04-27.)

**Cause:** Likely sparkline data source (`ct_flow_pulse_ticks` series via `useFlowPulseSeries`) thresholds — needs N>X data points to render, or specific tickers missing rows. Same screenshot showed numbers populated for all 10, just no sparkline.

**Files to check:**
- `src/components/command/FlowPulseSparkline.tsx`
- `src/hooks/useFlowPulse.ts:164` (`useFlowPulseSeries`)

---

### 2c. /flags page has no "today" filter
**Symptom:** All flags ever fired pile onto the page in one list. No way to filter by date — can't see just today's signals.

**Fix:** Add date chip filter (Today / 7d / 30d / All) to /flags top bar, mirror what /alarms or /tape does.

**Files:**
- `src/pages/Flags.tsx` (or wherever /flags page lives)

---

### 3. Slack pusher silent dead-zone went 3 days unnoticed
**Symptom:** `ct-slack-push-flag` had ZERO writes to `ct_slack_log` from Fri 2026-04-24 16:11 ET → Mon 2026-04-27 09:22 ET. Then suddenly woke up and drained 125 backlog flags at 10/min cap. No alarm during the dead window.

**Fix:**
- Cron health check should alarm when a cron-scheduled function has zero invocations during its expected window
- Right now it only catches "function ran but failed" — not "function never ran at all"
- Need: for each cron in `cron.job`, query `ct_slack_log` (or function-specific log) for last invocation; alarm if older than `2 × cron interval`

---

### 4. ct-cron-health-check not schedule-aware
**Symptom:** 1152 unresolved cron failures in 24h again — same Sunday-only crons re-flagging since the bulk-resolve last night.

**Cause:** Already documented in playbook bug pattern #6. Health check treats `>24h since last run` as stale, but Sunday-only crons (cron `0 22 * * 0`) legitimately don't run Mon-Sat.

**Fix:** Read `cron.job.schedule`, parse cron expression, only flag stale if "should have run within X hours" is true given that pattern.

---

### 5. Vault RPC `get_backtest_response` returns body:null on long functions
**Symptom:** `ct-flow-ingester` invoke returned `body:null, status_code:null` even though the function ran successfully and wrote 42 rows. Misleading during the live debugging — looked like the function was broken when it wasn't.

**Fix options:**
- Polling helper that waits up to N seconds for non-null body
- Or document in playbook: "null body ≠ failure, check the target table for side effects"

---

## P2 — Defer to weekend / next session

### 6. 0DTE separate-stream model scoping
Parked from Saturday session. Need to scope a separate detector model for SPY/QQQ/IWM 0DTE that treats it as fundamentally different than non-0DTE flow.

### 7. Watch for cron-pool saturation today
The 5 new detectors are staggered :00-:04 but the existing 3 detectors + flow-pulse-capture all still fire :00. If Monday shows pool issues, stagger those Tuesday morning before open.

### 8. Specialist prompt bullish-bias rewrite
Quick-patched with bearish few-shot examples (commit from Fri morning). Proper rewrite from scratch with bias-audit section parked. See `project_co_trader_specialist_bias_weekend.md`.

---

## Already fixed this session

- ✅ Slack flag spam stopped — 319 backlog flags marked `slacked_at=now()` at 13:23 UTC
- ✅ Confirmed all 5 new detector crons fire on schedule (:00-:04 lanes)
- ✅ Confirmed flow ingest is healthy (was named `ct-flow-ingester`, not `ct-uw-flow-ingest` as I initially queried)
- ✅ UW budget on track (~22% by 9:36 ET, well under 30% baseline)
- ✅ ct-print-grader manually invoked at 14:29 UTC — tracks 149→297 (97.7% of watchlist alerts now have a track row, P/L chips populate on refresh)

---

## Watch list for the rest of session today

- First fire from any of the 5 new shadow detectors (smart_money_repeat, weekly_atm_voi, zerodte_opening_call, zerodte_put_voi_extreme, small_cap_inverted_put)
- Whether new flags inherit the `specialist_ticker=null` / direction-mismatch bugs (decides whether #2 is P0-now or P0-after-close)
- UW burn rate — current ~50 calls/min during open. If sustained, EOD ~70-80% of budget
- Slack stays quiet on noise, fires only on real flags ≥80 score
