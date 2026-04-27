# Monday 2026-04-27 Open — Bug Punch List

Found during pre-open + first 15 min of trading. Ordered by impact. Fix after close (16:00 ET) unless P0 repeats before then.

---

## P0 — Fix today after close (could repeat tomorrow open)

### 00-bigint. ✅ FIXED LIVE 2026-04-27 — bigint type mismatch silently killing all 7 new detectors
**Root cause found:** All 7 new detectors (whale, unusual-oi, smart-money-repeat, weekly-atm-voi, zerodte-opening-call, zerodte-put-voi, small-cap-inverted-put) passed `source_flow_ids: [a.alert_id]`. `alert_id` is UUID but `ct_flags.source_flow_ids` is `BIGINT[]`. Every flag insert silently errored with `invalid input syntax for type bigint`. Same class of bug fixed in `20260423000035_v2_flags_source_flow_ids_bigint.sql` for v2 specialist flags but reintroduced.

**Patched live:** all 7 detectors now pass `source_flow_ids: null`. Confirmed by re-running over today's data — 136 flags fired (was 0). Code committed + deployed.

**TODO this weekend:** look up `ct_scored_flow.id` (bigint) from `alert_id` and pass that for proper attribution back to source flow. Defer because it requires understanding scored-flow lookup path.

---

### 00. ✅ RESOLVED 2026-04-27 ~15:00 ET — ALL today's winners now flagged
After force-redeploying both 0DTE detectors (parallel deploy script earlier had race), and re-running over today's data: **8 of 8 top winners flagged**. TSLA P 365 caught by unusual_oi + zerodte_put_voi_extreme. SPY C 714 by unusual_oi + zerodte_opening_call. Etc. The system was finding signal all along — bigint bug was hiding all the inserts.

**Remaining gap**: detector flags fire with `score=0` (raw alarms), below the slack_threshold of 80. They appear on /flags page but don't push to Slack. **Need scoring layer to grade detector alarms** before they can promote out of shadow. That's the next architectural work.

**Direction labeling nuance**: detector flags use `direction='bullish'` to mean "contract is being bought aggressively" — even on puts. So a TSLA put flagged "bullish" = bearish on TSLA. Confusing label; UI should say "flow direction: aggressive ask buy" not "bullish/bearish". Adding to UI cleanup list.

---

### 00b. Next gap — score the detector-portfolio alarms
**Symptom (now scoping 00b after fix):** All 7 new detectors now fire successfully and catch today's winners. But raw flags get `score=0`. With the slack_threshold at 80, they never push to Slack. So even though the system *sees* the signal, James doesn't get notified.

**Hypothesis:** Need a scoring layer that takes detector alarms + signature class match + cluster size + contract liquidity + Pulse regime context → produces a 0-100 score. Could re-use the signature_v1 scorer. Or add a separate `ct-detector-scorer` that runs after each detector sweep.

**Defer to weekend:** properly designing the scoring layer is bigger than a punch-list item. For now, the alarms exist on /flags and unblock manual review.

**Root cause (confirmed via manual detector invoke):**
- `zerodte_opening_call_v1` filters: `alarms_off_hour` rejects anything outside opening window. Today's winners hit later — system blind to mid-day 0DTE flow.
- `alarms_skipped_non_0dte`: detector's 0DTE classification is likely using `dte_class='0dte'` column (added Saturday) — but that column may not be populated correctly on incoming `ct_flow_alerts`, so real 0DTE prints get rejected as "non-0DTE".

**What we caught vs missed today:**
- Caught (7 high-score flags): META 515C / 710C / 680C swings, GOOGL 605C $350, MSFT 501C $437.50 — all longer-dated (11-39 DTE). Valid signals but not where the money was.
- Missed: 10 contracts at +50%+ peak, every one 0DTE. Plus the 12 LOSSES today which are also all 0DTE (volatility-not-direction reasserted).

**Fix path (in order):**
1. Verify `dte_class` column on today's `ct_flow_alerts` rows. If it's null/wrong on confirmed 0DTE prints, fix the trigger that populates it (or compute at detector-time from `expiry` vs trade-date).
2. Widen `zerodte_opening_call_v1` time-of-day filter. Either remove the "opening hour only" rule or make it a separate detector ("zerodte_intraday_call").
3. Lower predicate bars in shadow for one week to get sample data on what they WOULD have fired on.
4. Add a "missed-winners" report to Sunday calibration: "for any contract that peaked ≥+50% today, list which detectors saw the print and why they didn't fire."

**Don't promote zerodte_* detectors out of shadow until #1 + #2 fixed** — promoting them now means they'd Slack on the wrong stuff.

---

### 0. ct-print-grader cron too sparse for live RTH ✅ FIXED LIVE 2026-04-27
**Status:** Fixed mid-session via `20260427150000_grader_cron_faster_rth.sql`. Split single `*/30` cron into:
- `ct-print-grader-rth`: `*/10 13-20 * * 1-5` (every 10 min RTH+1h, weekdays)
- `ct-print-grader-offhours`: `0,30 0-12,21-23 * * *` (every 30 min off-hours, daily)

**Watch for tomorrow:** P/L coverage should stay ≥90% throughout RTH instead of sawtooth-ing 75%↔97% every 30 min.

---

### 0b. ~~Single-name 0DTE investigation~~ — RESOLVED, NOT A BUG
**Resolution (2026-04-27 mid-session):** Nasdaq added Mon/Wed expirations for AAPL, META, AMZN, GOOGL, TSLA, MSFT, NVDA, IBIT, AVGO effective 2026-01-26. First Monday expiry was Feb 2. Today's single-name 0DTE prints are legitimate — UW data is correct, pipeline is correct, `zerodte_*` detectors were correctly designed. See memory `reference_options_expiry_calendar.md` so future sessions don't re-question this.

---

### 1. ✅ FIXED LIVE 2026-04-27 — FlowPulse "Today" window floor
**Symptom:** First 0-15 min of every session, the per-ticker FlowPulse table shows all zeros even when data is flowing. Caused real "is it broken?" panic this morning.

**Cause:** `computeTodayWindowMin()` returns `minutes-since-13:30-UTC`. At 9:31 ET that's 1 minute. RPC has nothing to aggregate.

**Files:**
- `src/hooks/useFlowPulse.ts:436` (`computeTodayWindowMin`)

**Fix options:**
- Floor at 15 min: `return Math.max(15, diffMin)`
- Or compute against earliest data point in `ct_flow_pulse_ticks` for today
- Or change the label from "Today" to something honest about the rolling window

---

### 2. ✅ FIXED LIVE 2026-04-27 — null specialist_ticker on REAL signals

Slack template now uses `resolveTicker()` helper that prefers `specialist_ticker` → `instrument` → derive from OCC option_symbol. No more "null BULLISH flag score X — META260515C00675000" — will read "META BULLISH..." instead.

---

### 2-OLD-DETAILS. Flag data quality — null specialist_ticker on REAL signals (CONFIRMED LIVE)
**Status update 2026-04-27 ~13:00 ET:** Confirmed firing on real signals, not just backlog. **4 of 7 high-score Slack pushes today read `null BULLISH flag score X — SYMBOL`.** Specifically: META 515C $675 at 13:32, GOOGL 605C $350 at 14:58 (twice), MSFT 501C $437.50 at 15:11. The signature_v1 + cluster detectors are NOT writing `specialist_ticker` at all — only specialist-direct flags populate it.

**Root cause (confirmed):** `signature_v1` and the cluster detectors don't have a `specialist_ticker` to attach (they fire from raw flow patterns, not from a per-ticker specialist). The Slack template was written assuming all flags came from a specialist. When the field is null, the template renders the literal string "null".

**Fix options:**
- Update Slack template: fall back to `flag.ticker` (extracted from `option_symbol`) when `specialist_ticker IS NULL`
- Or backfill `specialist_ticker` from option_symbol parse at insert time (cheaper than touching template)
- Or rename the column to `attribution_ticker` and ALWAYS populate it with `ticker || specialist_ticker` semantics

**Don't add NOT NULL constraint yet** — would break the signature/cluster detectors which legitimately have no specialist.

---

### 2-bias. Severe bullish bias — multi-day pattern (CONFIRMED LIVE)
**Status:** James confirms bullish bias has been present "the last few days." Today: **7 of 7 high-score (≥80) flags fired bullish. Zero bearish.** Despite a mixed-to-green tape, that's structurally suspicious. Quick-patch from Fri morning (added bearish few-shot example to 7 prompts) is not holding.

**Risk:** A bullish-only system in a green tape looks fine. On the next red day, it'll be either silent or wrong. The system appears smart but isn't actually multi-directional.

**Hypotheses to test this weekend:**
- (a) Specialist prompts still framing "find the conviction signal" in a way that biases toward continuation/momentum (which is more often bullish on Mag7)
- (b) Signature classes themselves are imbalanced — "aggressive_ask_call" patterns far outnumber "aggressive_bid_put" in our corpus, so high-confidence matches skew bullish
- (c) Scorer weighting favors call-side flow inputs
- (d) Direction-inference (`inferDirection` helper) may misclassify ambiguous flow as bullish by default

**Fix path:**
1. Run a corpus query: high-score flags last 5 trading days, group by direction. Quantify the bias.
2. Audit signature class table — `select direction, count(*) from ct_signature_classes group by direction`
3. Bullish-bias-audit on each specialist prompt (proper rewrite was already parked for this weekend per `project_co_trader_specialist_bias_weekend.md`)
4. Add a direction-balance health metric to ct-cron-health-check — if 5-day rolling high-score-flag bullish ratio >85%, alarm.

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

### 2c. ✅ FIXED LIVE 2026-04-27 — /flags page date filter
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

### 4. ✅ FIXED LIVE 2026-04-27 — ct-cron-health-check now schedule-aware (3x cadence on weekday-daily)
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
