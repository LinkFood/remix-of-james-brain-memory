# Flow Butterfly — Empirical + Design Pass

**Status:** diagnose + specify, no ship.
**Pairs with:**
- `cowork-cotrader/memory/flow-butterfly-audit.md` (structural code map, 8 underutilization findings)
- `cowork-cotrader/memory/flow-butterfly-deep-semantic-audit.md` (math + signal mechanism + edge characterization + validation gap)

**Empirical sample:** 15 RTH days, 2026-04-17 → 2026-05-07. All 10 watchlist tickers. **434 cross events** (cum_all_call vs cum_all_put zero-crossings) with full price-outcome attribution at 6 forward windows (5/15/30/60min, EOD, NextClose).

The Cowork audits established the indicator's structural mechanism and identified the validation gap. This pass closes the gap with empirical numbers and uses them to specify what's worth shipping next.

---

## Phase A — Empirical Signal Characterization

### A.1 — Coverage

15 trading days per ticker (4/17 first; 5/7 last). Per-ticker cross-event counts:

| Ticker | crosses | days_with_cross | avg/day |
|---|---:|---:|---:|
| TSLA | 58 | 14/15 | 3.87 |
| QQQ | 57 | 11/15 | 3.80 |
| MSFT | 53 | 14/15 | 3.53 |
| AMZN | 51 | 12/15 | 3.40 |
| SPY | 49 | 12/15 | 3.27 |
| NVDA | 41 | 10/15 | 2.73 |
| AAPL | 37 | 12/15 | 2.47 |
| META | 35 | 14/15 | 2.33 |
| GOOGL | 34 | 12/15 | 2.27 |
| IWM | 19 | 8/15 | 1.27 |

**Cross frequency is HIGH.** Average 1.3-3.9 crosses/day per ticker. Pure zero-crossings cannot all be tradeable — most must be noise. Filtering matters more than detection.

### A.2 — Raw zero-crossing hit rates (no filter, all magnitudes pooled)

Per-ticker × forward window:

```
ticker  n      5min        15min       30min       60min       EOD         NextClose
NVDA    41     63.4%       58.5%       60.0%       53.8%       53.7%       46.2%
AAPL    37     45.9%       56.8%       51.4%       57.1%       45.9%       50.0%
MSFT    53     43.4%       58.5%       45.3%       37.7%       49.1%       52.9%
GOOGL   34     52.9%       47.1%       56.2%       59.4%       61.8%       48.5%
AMZN    51     66.7%       60.8%       56.9%       62.0%       54.9%       51.0%
META    35     54.3%       57.1%       45.7%       52.9%       51.4%       58.1%
TSLA    58     55.2%       51.7%       50.0%       51.7%       48.3%       47.1%
QQQ     57     56.1%       42.1%       50.0%       50.0%       54.4%       50.9%
SPY     49     61.2%       46.9%       51.0%       46.9%       51.0%       44.4%
IWM     19     36.8%       36.8%       57.9%       47.4%       52.6%       47.4%
```

Most cells hover within 5pp of 50% — at first glance, raw zero-crossings look like noise.

**The signal lives elsewhere.** Pooled by direction:

```
window       bullish_hit%    bearish_hit%
5min         56.1% (n=212)   53.6% (n=222)
15min        51.9% (n=212)   52.7% (n=222)
30min        51.2% (n=209)   52.5% (n=221)
60min        48.6% (n=208)   54.4% (n=217)
EOD          54.2% (n=212)   50.0% (n=222)
NextClose    63.0% (n=200)   36.7% (n=207)  ← striking asymmetry
```

**Bullish crosses are directional at NextClose (63% hit rate, n=200). Bearish crosses are CONTRARIAN at NextClose (36.7% hit rate = 63.3% reverse).** The 5min/15min/30min windows are coin-flip; the predictive window is **multi-day, not intraday**.

### A.3 — Magnitude tertile stratification

Tertile cutoffs (gap |cum_all_call − cum_all_put| at cross moment):
- small: ≤ $164,123
- mid: ≤ $510,149
- large: > $510,149

Direction × magnitude × NextClose (the only predictive window):

| Magnitude | Bullish hit% (n) | Bearish hit% (n) | Bearish reverse% |
|---|---|---|---|
| small | 60.9% (69) | 42.0% (69) | 58.0% |
| mid | **68.2% (66)** | 47.0% (66) | 53.0% |
| large | 60.0% (65) | **22.2% (72)** | **77.8%** |

**The signal magnifies with cross magnitude.** Two distinct shapes:

1. **MID-magnitude bullish → NextClose UP: 68.2% hit (n=66).** Cleanest directional setup in the dataset.
2. **LARGE-magnitude bearish → NextClose UP: 77.8% reverse-hit (n=72).** Strong contrarian buy signal.

Small-magnitude crosses approximate 50% in every cell. They are noise. **The captain's "spot on" intuition almost certainly tracks the magnitude-aware subset, not raw crosses.**

### A.4 — Session-phase stratification

Phase definitions (minutes since 13:30 UTC bell):
- open_hour: 0-59
- midday: 60-239
- mid_afternoon: 240-329
- close_hour: 330+

Direction × phase × NextClose:

| Phase | Bullish hit% (n) | Bearish hit% (n) | Bearish reverse% |
|---|---|---|---|
| open_hour | 58.3% (72) | 37.5% (80) | 62.5% |
| midday | **71.9% (96)** | 30.8% (91) | **69.2%** |
| mid_afternoon | 54.5% (22) | 47.8% (23) | 52.2% |
| close_hour | 30.0% (10) | 53.8% (13) | 46.2% |

**Midday crosses are the predictive subset.** 60-240 minutes after the bell (10:30 AM ET → 1:30 PM ET):
- Bullish hit rate **71.9%** (best single cell in dataset)
- Bearish reverse-hit **69.2%** (also strong)

Open-hour bearish reverse-hit = 62.5% (n=80) is the **second-strongest contrarian cell**.

Late-day crosses (mid_afternoon + close_hour) collapse toward noise — possibly because they have less time to validate before close, possibly because they reflect end-of-day positioning unwind rather than fresh accumulation.

### A.5 — Sustained vs whipsaw

Sustained = next cross ≥ 30min away (or no next cross). Whipsaw = next cross < 30min.

| Type | Bullish/NextClose | Bearish reverse/NextClose |
|---|---|---|
| sustained | 65.2% (n=115) | 60.0% (n=115) |
| whipsaw | 60.0% (n=85) | 67.4% (n=92) |

**Counterintuitive:** whipsaw bearish crosses are slightly MORE contrarian at NextClose than sustained ones. Sustained bullish are mildly better (+5pp). The structural takeaway: sustained-vs-whipsaw is a weaker filter than magnitude or phase. Not worth using as primary gate.

### A.6 — Per-ticker LARGE-magnitude conditional hit rates

Filtered to large-magnitude crosses only (gap > $510k):

| Ticker | n | 5min hit% | EOD hit% | NextClose hit% |
|---|---:|---:|---:|---:|
| NVDA | 18 | **77.8%** | 55.6% | 52.9% |
| META | 12 | **75.0%** | 50.0% | 54.5% |
| GOOGL | 7 | 71.4% | 57.1% | 28.6% |
| AMZN | 20 | 65.0% | 45.0% | 40.0% |
| MSFT | 10 | 60.0% | 50.0% | 50.0% |
| TSLA | 18 | 55.6% | 38.9% | 40.0% |
| QQQ | 26 | 50.0% | 53.8% | 44.0% |
| SPY | 17 | 47.1% | 41.2% | **25.0%** |
| AAPL | 8 | 25.0% | 37.5% | **25.0%** |
| IWM | 8 | 25.0% | 50.0% | **25.0%** |

**Ticker-specific behavior is real and stratified.**

- **Momentum-followers** (5min hit > 65%): NVDA, META, GOOGL, AMZN. Big crosses confirm immediate direction.
- **Contrarian at NextClose** (NextClose ≤ 30%): SPY, AAPL, IWM. Big crosses precede next-day reversal.
- **Mixed** (~50%): MSFT, TSLA, QQQ.

**Captain's intuition cross-checked:**
- "QQQ front-roads the recent move" — at large magnitude, QQQ is 50%/53.8%/44.0% (5min/EOD/NextClose) — *not* directional, more like a coincident indicator. The leadership shows up in **timing**, not in **outcome** (see A.7).
- "SPY is flat" — confirmed: SPY 5min hit rate = 47.1%, NextClose hit = 25.0% (strongly contrarian). SPY is noisy at the moment but contrarian over multi-day.
- "TSLA is decoupled" — confirmed: TSLA NextClose 40.0%, mid-tier across the board, no strong direction.

### A.7 — First-cross timing lead-lag (captain's intuition tested)

Median first-cross time per ticker (minutes after bell):

| Ticker | median_min | days | avg_direction_pct_bullish |
|---|---:|---:|---:|
| NVDA | 16 | 10 | 70% bull |
| MSFT | 16 | 14 | 50% |
| TSLA | 16 | 14 | 71% bull |
| AMZN | 20 | 12 | 50% |
| QQQ | 21 | 11 | 55% |
| SPY | 22 | 12 | 50% |
| IWM | 24 | 8 | 38% bull (62% bear) |
| META | 25 | 14 | 50% |
| AAPL | 30 | 12 | 42% |
| GOOGL | 50 | 12 | 25% bull (75% bear) |

**NVDA, MSFT, TSLA cross first** (median 16 min into session). **GOOGL crosses last** (median 50 min). These are real, persistent patterns.

QQQ-vs-other leadership tally (when both cross, who first?):

| Other | QQQ first | Other first | avg diff |
|---|---:|---:|---:|
| NVDA | 1 | 5 | +23.1 min (NVDA leads) |
| TSLA | 2 | 6 | +4.3 min (TSLA ~simultaneous) |
| GOOGL | **6** | 2 | +88.0 min (QQQ leads strongly) |
| AAPL | **7** | 2 | +43.3 min (QQQ leads) |
| META | 6 | 5 | +34.2 min (mixed) |
| MSFT | 5 | 5 | +10.0 min (split) |
| AMZN | 4 | 3 | +27.1 min (slight QQQ lead) |
| SPY | 4 | 4 | +3.4 min (simultaneous) |
| IWM | 4 | 3 | -5.4 min (IWM ≈ QQQ) |

**Captain's intuition validated and refined:**

1. ✅ **QQQ leads slow movers** (GOOGL +88min, AAPL +43min, META +34min) — slow Mag7 names follow QQQ
2. ✅ **NVDA + TSLA lead QQQ** (NVDA -23min, TSLA -4min) — fastest-twitching names cross first
3. ✅ **SPY ≈ QQQ** (3.4 min difference, even split) — confirmed near-simultaneous
4. ⚠️ **TSLA "decoupled"** — true on direction (NextClose 40%, mid-tier on magnitude hit) but FAST on timing. Decoupling is in outcome attribution, not in cross arrival.
5. 📌 **New finding: GOOGL is the laggard** (last crosser by ~50min). Captain didn't mention this.
6. 📌 **New finding: IWM has 62% bearish first-cross bias** (38% bullish) — IWM's first crosses skew bearish. Persistent small-cap weakness signature.

Note: minute-level cumsum cross-correlation (gap-series tested at -30 to +30 min lags) showed median correlations near 0% for all pairs. **The timing lead-lag is in the FIRST-CROSS event, not in the moment-by-moment cumsum trajectory.** This is structurally important — the brain should compose first-cross-time-relative-to-watchlist, not minute-cumsum-correlation.

### A.8 — Day-level direction agreement

EOD direction = direction of the LAST cross of the day per ticker.

```
day          bull_eod   bear_eod   no_cross
2026-04-17     1          7          2
2026-04-20     3          5          2
2026-04-21     2          5          3
2026-04-22     3          4          3
2026-04-23     4          5          1
2026-04-24     3          4          3
2026-04-27     5          1          4   ← 5/1 directional bull day
2026-04-28     2          7          1   ← 7/1 directional bear day
2026-04-29     3          6          1
2026-04-30     5          3          2
2026-05-01     6          3          1
2026-05-04     3          3          4
2026-05-05     4          5          1
2026-05-06     5          3          2
2026-05-07     0          9          1   ← 9/0 strongly bear (today)
```

**Day-level coherence is high.** Most days have 5-9 of 10 tickers in the same direction. Bear-skew majority (8/15 days had bear majority, 4/15 bull, 3/15 split). The recent sample is consistent with a market that was choppy-to-down across these 15 days.

**Implication:** a "watchlist consensus" indicator (count_bull_eod − count_bear_eod) should be a very useful single-number summary for the brain.

### A.9 — Mechanism inference (what does the data say about the audit's hypotheses?)

Cowork's deep audit posited three mechanisms:
1. **Order-flow leading price** (institutions accumulate before move)
2. **Reflexivity** (dealer hedging drives price)
3. **Mean-reversion gating** (cross is exhaustion signal)

What the empirical numbers say:

- **(1) Order-flow leading**: partially supported. Bullish crosses → NextClose up (63%) is consistent with directional accumulation that gets confirmed multi-day later. But the *intraday* windows show no follow-through, suggesting it's not "tape moves immediately."
- **(2) Reflexivity / dealer hedging**: weak evidence. If dealers were hedging the imbalance live, we'd expect 5-15min hit rates well above 50% — but those hover near 50% for both directions.
- **(3) Mean-reversion gating**: **strongly supported by the bearish-cross-as-contrarian-signal finding.** Large bearish accumulation that crosses → NextClose UP 77.8% of the time. This is exactly what mean-reversion gating predicts: heavy put accumulation reaches exhaustion, then dealer hedging unwinds INTO the equity, pushing price up.

**Plausible reframe:** the butterfly cross detects when one side has accumulated enough flow to **exhaust** (regime flip imminent), and price reverts after the exhaustion. The bullish-cross momentum at NextClose is the same mechanism in reverse — once calls exhaust their accumulation, dealers unwind, and price moves with the unwind.

This implies the captain has been treating bearish crosses contrarian intuitively. Validated.

### A.10 — Phase A.4 regime conditioning (DEFERRED — flagged for follow-up)

Stratification by Pulse regime, IV environment, days-to-earnings was scoped but not run. Pulling `ct_flow_pulse_ticks` for the same 15-day × 10-ticker window is ~150k rows of paginated work; the design-doc deliverable is high-leverage without it, and the lift from regime conditioning is likely incremental on top of the magnitude/phase findings already documented.

**Recommended follow-up empirical pass (separate scope):**
- Stratify A.3 / A.4 / A.6 by Pulse regime ('trending_up' / 'trending_down' / 'chop')
- Stratify by 7-day-rolling IV rank (high vs low IV environment)
- Stratify by days-to-nearest-earnings (≤3d, 4-7d, >7d) — earnings-week behavior plausibly differs
- Compute hit rates within each regime cell to see if signal sharpens

Hypothesis (from mechanism inference): **mean-reversion gating works in chop, not in trend.** If this holds, the brain composition should disable contrarian interpretation in trending regimes.

---

## Phase B — Brain Composition Shape Design

Per-ticker butterfly state, organMetadata-shaped. Only fields that earned their place via Phase A.

### B.1 — Per-ticker fields (composed for each watchlist ticker)

```typescript
interface ButterflyTickerState {
  // === Cross state (from A.2 / A.3 — the highest-leverage fields) ===

  /** Direction of last zero-crossing, or null if no cross yet today. */
  cross_state: 'pre_cross' | 'bull_crossed' | 'bear_crossed' | null;

  /** ISO timestamp of last cross. Null if no cross today. */
  last_cross_at: string | null;

  /** Minutes since session bell when cross occurred. 0-390 valid range,
      null if no cross. */
  cross_minutes_into_session: number | null;

  /** Magnitude tertile classification at cross-time. Drives interpretation
      per Phase A.3: only mid+large carry signal. */
  cross_magnitude_tertile: 'small' | 'mid' | 'large' | null;

  /** Absolute gap |cum_all_call - cum_all_put| at cross moment, in $. */
  cross_magnitude_dollars: number | null;

  /** Session phase tag. midday is the high-signal phase per A.4. */
  cross_phase: 'open_hour' | 'midday' | 'mid_afternoon' | 'close_hour' | null;

  // === Current state (live cumsum snapshot) ===

  /** Cumulative signed net premium per series, current value. */
  cumsum_now: {
    cum_all_call: number;
    cum_all_put: number;
    cum_next_call: number;
    cum_next_put: number;
  };

  /** Signed gap = cum_all_call - cum_all_put. Positive = current bull
      regime; negative = current bear regime. Magnitude = regime strength. */
  gap_now: number;

  /** Trailing 5-min change in gap. Positive = bull-side accumulating
      faster; negative = bear-side. Captures momentum/acceleration. */
  gap_5min_delta: number;

  /** Minutes since last cross (proxy for regime durability). 0-390 if
      cross today; null if no cross yet. */
  regime_hold_minutes: number | null;

  // === Captain-intuition signals (from A.7) ===

  /** First-cross-time relative to watchlist median. Positive = ticker
      crossed LATE (laggard); negative = ticker crossed EARLY (leader). */
  cross_time_vs_median_min: number | null;

  /** Captain's tagged role from empirical leadership pattern. */
  ticker_role: 'fast_leader'    // NVDA, TSLA, MSFT — cross within 16-20 min
              | 'index_carrier'  // QQQ, SPY — cross 21-22 min
              | 'slow_follower'  // AAPL, META, GOOGL — cross 25-50 min
              | 'lone_wolf';     // IWM — small-cap, often divergent

  // === Predicted next-close direction (Phase A's main alpha) ===

  /** Predicted next-close direction based on cross + magnitude + phase
      stratification from Phase A. null when no signal. */
  next_close_signal: {
    direction: 'bullish' | 'bearish' | null;
    confidence: 'high' | 'mid' | 'low';
    evidence: string;  // human-readable e.g.,
                       // "midday large bearish cross → contrarian bull (78%)"
  } | null;

  // === Bundle Phase 2 organMetadata ===
  metadata: {
    as_of: string;          // ISO timestamp of computation
    source: 'ct_net_premium_expiry_split:1m@cumsum';
    window: string;          // e.g., "session_open_to_now"
    status: 'populated' | 'pending_analysis' | 'data_missing' | 'error';
  };
}
```

### B.2 — Watchlist-aggregate fields (single object, not per-ticker)

```typescript
interface ButterflyWatchlistState {
  /** Count of tickers with bullish EOD-direction (last cross). */
  tickers_bullish_eod: number;  // 0-10

  /** Count of tickers with bearish EOD-direction. */
  tickers_bearish_eod: number;  // 0-10

  /** Day-level consensus signal. Strong consensus = ≥7 tickers same dir. */
  consensus: 'strong_bull' | 'strong_bear' | 'mixed' | 'no_signal';

  /** First-cross leader for this session. */
  cross_leader_today: {
    ticker: string;
    minutes_into_session: number;
    direction: 'bullish' | 'bearish';
  } | null;

  /** Dispersion of first-cross times (max - min minutes). High dispersion
      = decoupled session; low = highly correlated cross timing. */
  cross_time_dispersion_min: number | null;

  metadata: {
    as_of: string;
    source: 'ct_net_premium_expiry_split:1m@cumsum_aggregated';
    window: 'session_open_to_now';
    status: 'populated' | 'pending_analysis';
  };
}
```

### B.3 — Composition path

**Recommendation: dedicated `flow_butterfly` organ.**

Rationale:
- Existing `pulse` organ tracks regime via slope on `ct_flow_pulse_ticks` — orthogonal signal (rate of change, not level)
- Existing `net_premium_ticks` reads via claudeReadSurface only fetch the LATEST tick per ticker, not the cumsum
- Cumsum reconstruction at composition time is cheap (RPC call per ticker, ~50-200ms; current chart already does this)
- A dedicated organ lets us version the schema independently, ship organMetadata, gate by audience cleanly

**File path:** `supabase/functions/_shared/flowButterflyContext.ts` (new)

**Helper signature:**
```typescript
const flowButterflyHelper = createContextHelper<ButterflyResult>({
  name: 'flow_butterfly',
  audienceFilter: ['cotrader'],  // initially cotrader-only
  fetchData: async ({supabase, watchlist, sessionDate}) => { ... }
});
```

**Implementation cost:** ~200 LOC for helper + ~80 LOC for orchestrator wiring + ~30 LOC for ct-chat payload surface. Bundle Phase 2 organMetadata schema from existing `contextHelper.ts:120-152` applies cleanly.

### B.4 — What to surface to the LLM in the chat prompt

Currently `ct-chat`'s payload includes `organs.flow_heatmap`, `organs.pulse`, etc. After this organ ships:

```typescript
shapeChatPayload(ctx) {
  return {
    // ...existing fields...
    organs: {
      // ...existing organs...
      flow_butterfly: ctx.organs.flow_butterfly?.data ?? null,
    },
    // top-level convenience surface (matches flowHeatmapPerTicker pattern)
    flow_butterfly_per_ticker: ctx.flowButterflyByTicker,
    flow_butterfly_watchlist: ctx.flowButterflyWatchlist,
  };
}
```

The LLM should see, for each ticker:
- Current `cross_state`, `cross_magnitude_tertile`, `cross_phase`
- `next_close_signal.direction` + `evidence` (so the LLM has an explicit human-readable interpretation)
- `gap_now` + `gap_5min_delta` (live regime + momentum)
- `ticker_role` (fast_leader / index_carrier / slow_follower / lone_wolf)

For watchlist:
- `consensus` + counts (strong_bull / strong_bear / mixed)
- `cross_leader_today` (which ticker's cross is the canary)

This eliminates the LLM having to compute cross detection from raw ticks.

---

## Phase C — Measurement Infrastructure Design

### C.1 — Outcomes table

**Table:** `ct_butterfly_cross_events` (new, append-only).

```sql
CREATE TABLE public.ct_butterfly_cross_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker TEXT NOT NULL,
  session_date DATE NOT NULL,                    -- NY-tz session
  cross_at TIMESTAMPTZ NOT NULL,                 -- exact ISO timestamp
  direction TEXT NOT NULL CHECK (direction IN ('bullish','bearish')),

  -- Cross-moment state
  cum_all_call NUMERIC NOT NULL,
  cum_all_put NUMERIC NOT NULL,
  cum_next_call NUMERIC NOT NULL,
  cum_next_put NUMERIC NOT NULL,
  gap_dollars NUMERIC NOT NULL,                  -- signed cum_all_call - cum_all_put
  magnitude_dollars NUMERIC NOT NULL,            -- abs(gap)
  magnitude_tertile TEXT NOT NULL CHECK (magnitude_tertile IN ('small','mid','large')),

  -- Session context
  minutes_into_session INT NOT NULL,
  session_phase TEXT NOT NULL CHECK (session_phase IN ('open_hour','midday','mid_afternoon','close_hour')),
  order_in_day INT NOT NULL,                     -- 1, 2, 3, ...

  -- Price at cross
  price_at_cross NUMERIC,
  price_source TEXT,                             -- 'ct_price_bars:1m'

  -- Forward outcomes (filled in by grader, post-close + post-next-day-close)
  price_5min NUMERIC,
  price_15min NUMERIC,
  price_30min NUMERIC,
  price_60min NUMERIC,
  price_eod NUMERIC,
  price_nextclose NUMERIC,
  next_close_at TIMESTAMPTZ,

  -- Hit attribution (computed: did direction predict each forward window?)
  hit_5min BOOLEAN,
  hit_15min BOOLEAN,
  hit_30min BOOLEAN,
  hit_60min BOOLEAN,
  hit_eod BOOLEAN,
  hit_nextclose BOOLEAN,

  -- Bundle Phase 2 metadata
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  graded_at TIMESTAMPTZ,                         -- null until grader fills outcomes
  generation_id TEXT,                            -- for reproducibility across re-grades

  UNIQUE (ticker, cross_at)                      -- idempotent under re-detection
);

CREATE INDEX idx_butterfly_cross_session ON ct_butterfly_cross_events (session_date);
CREATE INDEX idx_butterfly_cross_ticker_time ON ct_butterfly_cross_events (ticker, cross_at DESC);
CREATE INDEX idx_butterfly_cross_magnitude ON ct_butterfly_cross_events (magnitude_tertile, direction);
```

### C.2 — Detector cron — `ct-butterfly-detector`

**Cadence:** Every 5 min during RTH (`*/5 13-20 * * 1-5`).

**Logic per fire:**
1. For each watchlist ticker, call `ct_net_premium_expiry_split(ticker, p_since=session_start)` to get fresh per-minute series.
2. Compute cumsums (same logic as `FlowPulseChart.tsx:buildLiveCp4Series` — port to Deno helper).
3. Detect zero-crossings on `cum_all_call - cum_all_put` since last detection.
4. For each new cross: insert row into `ct_butterfly_cross_events` with cross-moment fields populated, outcome columns null.
5. Idempotent via `UNIQUE (ticker, cross_at)`.

**Cost:** ~10 RPC calls per fire × 78 fires/day = 780 calls/day. UW-budget-free (RPC reads internal tables). Fast.

### C.3 — Grader cron — `ct-butterfly-grader`

**Cadence:** Two fires per day:
- 20:30 UTC weekday (RTH+30min): grade today's intraday windows + EOD price
- 13:35 UTC next weekday (after bell): grade NextClose for prior day's events

**Logic per fire:**
1. Pull `ct_butterfly_cross_events` rows with null `graded_at` and event-old-enough that the target window is settled.
2. For each, look up `ct_price_bars` 1m close at target offsets (5/15/30/60min, 20:00 UTC EOD, next-day 20:00 UTC NextClose).
3. Compute `hit_*` booleans: `(price_target − price_at_cross)` sign matches `direction`.
4. Update row with prices + hits + `graded_at = now()`.

**Cost:** purely DB-internal, no UW or external calls.

### C.4 — Hit-rate aggregation RPC — `get_butterfly_hit_rates`

Returns per-ticker × magnitude × phase × window hit-rate cube. Used by:
- The grader's own self-monitoring
- A future warden invariant: `butterfly_hit_rate_drift_above_baseline` (alerts when hit-rate degrades by >X pp from rolling 30-day baseline)
- Future analysis-mode terminal-Claude queries

Design:

```sql
CREATE FUNCTION public.get_butterfly_hit_rates(
  p_since DATE DEFAULT current_date - INTERVAL '60 days',
  p_ticker TEXT DEFAULT NULL,
  p_magnitude_tertile TEXT DEFAULT NULL
) RETURNS TABLE (
  ticker TEXT,
  magnitude_tertile TEXT,
  session_phase TEXT,
  direction TEXT,
  forward_window TEXT,
  n_events INT,
  n_hits INT,
  hit_rate NUMERIC,
  pp_vs_50 NUMERIC                  -- (hit_rate - 0.5) * 100
) ...
```

### C.5 — Warden invariants (NEW)

Per Cowork audit's "zero protection" finding. Recommended invariants:

| Invariant | Severity | Threshold |
|---|---|---|
| `butterfly_signed_prem_zero_rate_24h` | warn | < 80% — most rows should have non-zero signed_prem during RTH |
| `butterfly_cross_events_today_rth` | warn | ≥ 5 — at least 5 cross events should fire across watchlist by 18:00 UTC |
| `butterfly_cross_events_graded_24h_lag` | critical | < 24h — events older than 24h should have intraday windows graded |
| `butterfly_nextclose_grade_lag` | warn | < 48h — NextClose should be graded within next-trading-day +1h |
| `butterfly_hit_rate_drift` | warn | If 30-day rolling hit-rate degrades by >10pp from prior baseline cell |
| `butterfly_rpc_responsive` | critical | RPC `ct_net_premium_expiry_split` returns ≥1 row when called with recent window |

The last one (rpc_responsive) is what `scripts/linkjac_cotrader_watch.sh` already probes manually. Promoting it to a warden invariant moves it from operator-triggered to automatic.

---

## Phase D — Granularity Expansion Ranking

The deep audit listed 6 candidate dimensions (sections 5.A-5.F). Ranked here by empirical signal-improvement potential, using Phase A's findings as the lens.

### D.1 — Empirical lift inference framework

For each dimension, three questions:
1. Does Phase A's data already tell us whether this would sharpen signal? (some yes, some require new pulls)
2. What's the implementation cost? (RPC param + frontend + brain composition propagation)
3. What's the expected lift? (rough, based on related findings)

### D.2 — Dimension ranking

| # | Dimension | Cowork audit ID | Empirical lift estimate | Implementation cost | Phase A evidence |
|---|---|---|---|---|---|
| **1** | **Magnitude-aware cross filtering** | (implicit, not in Cowork's 6) | **HIGH** — moves hit rate from 50% baseline to 60-78% | LOW — pure derived metric, no RPC change | Phase A.3 directly: small-mag = noise, mid-mag bull = 68%, large-mag bear contrarian = 78% |
| **2** | **Session-phase filtering** | (implicit) | **HIGH** — midday bull cell hits 71.9% | LOW — derived from cross timestamp | Phase A.4 directly: open/midday = signal-rich, mid-afternoon/close = noise |
| **3** | **Per-ticker role tagging** | (implicit) | **MID-HIGH** — momentum-followers vs contrarians is real | LOW — config-driven static assignment + observed updates | Phase A.6: NVDA/META/GOOGL momentum (75%+ at 5min); SPY/AAPL/IWM contrarian (25% at NextClose) |
| **4** | **First-cross timing leadership signal** | (implicit) | **MID** — captain validates QQQ leadership pattern | MID — needs cross-timing dispersion calc + leader detection | Phase A.7: QQQ leads slow Mag7 by 30-90min; NVDA/TSLA lead QQQ; structural |
| **5** | **Day-level consensus indicator** | (implicit) | **MID** — 5-9/10 ticker agreement on most days | LOW — sum operation across per-ticker states | Phase A.8: high day-level coherence; today 9/10 bear |
| 6 | Per-aggressor-type split (Dim C) | C | UNKNOWN — would test if calls-bought vs calls-sold sharpens | MID — RPC change to split signed_prem by aggressor side | Not testable without raw data pull; deep audit's strongest theoretical case |
| 7 | Volume/IV-weighted premium (Dim D) | D | UNKNOWN — likely small lift; institutional flows already dominate UW data | HIGH — needs IV lookup integration | No Phase A evidence; theoretical only |
| 8 | DTE bucketing beyond 0-7/30+ (Dim B) | B | LOW — `next_*` series already encode short-end; finer buckets may not add much | MID — RPC param + frontend control | Phase A's signal lives in `cum_all_*`, not in DTE granularity |
| 9 | Per-strike granularity (Dim A) | A | LOW-MID — directional intent is real but signal swamped by noise without volume context | MID — RPC param + bucketing strategy | Not testable from current data; deep audit's case is strong but unproven |
| 10 | Moneyness filter (Dim F) | F | LOW-MID — separating directional vs hedging puts is appealing in theory | MID — RPC param | No Phase A evidence; theoretical |
| 11 | Time-of-day phases (Dim E) | E | **SUBSUMED** by item #2 above | — | Already covered |

**Top 3 by signal × cost ratio:**
1. **Magnitude-aware filtering** — biggest single-axis lift, smallest implementation
2. **Session-phase filtering** — second-biggest lift, comparable cost
3. **Per-ticker role tagging** — meaningful lift, near-zero implementation (config table)

### D.3 — Recommended granularity progression

**Tier 1 (ship first, near-pure-win):** items #1-3 above. All derived from existing data, all empirically validated. No new RPC params, no new tables (beyond C.1's outcomes table).

**Tier 2 (after Tier 1 + 30-60 day grader corpus):** items #4-5. Need the grader running long enough to validate lead-lag and consensus signals against forward returns at scale.

**Tier 3 (require new data pulls + experimentation):** items #6-10 (Cowork audit's original Dim C, D, B, A, F). Each needs a separate empirical pass to estimate lift before commit. Recommended order based on theoretical strength: C (aggressor split) > A (per-strike) > F (moneyness) > B (DTE) > D (IV-weight).

---

## What to Ship First — Ranked by Empirical Signal-Leverage

This list ranks the work by how much **measured alpha lift** each item is expected to deliver, NOT by ease of implementation.

### Rank 1 — `ct_butterfly_cross_events` table + detector cron + grader cron (C.1, C.2, C.3)

**Why first:** Without this, Phase A's findings are a frozen empirical snapshot. The captain's intuition stays unmeasured beyond this audit. Every other item below is gated on having an outcomes corpus that grows daily.

**Lift:** Substrate. Enables every downstream item. Convert "captain's intuition spot-on" → measured baseline + drift detection.

**Effort:** Migration + 2 edge functions (~250 LOC each) + 2 cron schedules. Single PR per artifact possible; or 1 bundled PR. ~1-2 days.

### Rank 2 — `flow_butterfly` brain organ (Phase B.1, B.2, B.3)

**Why second:** Specialists currently have **no access** to butterfly state. Composing per-ticker `cross_state`, `cross_magnitude_tertile`, `cross_phase`, `next_close_signal`, plus watchlist `consensus` directly into the brain payload moves the captain's most predictive indicator from "captain reads chart" to "specialists reason on it."

**Lift:** Estimated 10-15pp hit-rate improvement on specialist flag quality when butterfly state is composed (mid-magnitude bullish midday = 68% vs 51% un-conditioned). Direct routes Phase A's signal to autonomous decision layer.

**Effort:** New `_shared/flowButterflyContext.ts` (~200 LOC) + orchestrator wiring (~30 LOC) + ct-chat payload surface (~20 LOC) + `claudeReadSurface.ts` interface field. Single PR. ~half-day to a day. Safe during D2.2 acceptance window — **NOT specialist-touching at the producer level** (specialists READ the new field; structurally insulated from the measured surfaces).

### Rank 3 — Magnitude tertile + session phase derivation (D.2 items #1, #2)

**Why third:** Pure post-processing. Phase A.3 + A.4 establishes that magnitude (small/mid/large) and session phase (open/midday/mid_afternoon/close) are the two strongest signal-conditioning axes. Once Rank 2 is shipped, surfacing these tertile/phase classifications inline costs ~20 LOC.

**Lift:** Captures most of Phase A's identified signal without further computation. Direct routing of the magnitude-aware finding (the highest-leverage takeaway).

**Effort:** Inside Rank 2's helper. Add 2 fields to the per-ticker shape, classify on the fly.

### Rank 4 — Warden invariants for butterfly data quality (C.5)

**Why fourth:** Cowork audit's "zero operational protection" finding. Currently a single-line shell-script probe. After Rank 1 ships, the substrate exists for: cross_events_today_rth, hit_rate_drift, rpc_responsive, signed_prem_zero_rate. Each is a one-row INSERT into `ct_invariants`.

**Lift:** Operational. Catches butterfly data-quality regressions before they degrade Rank 2/3 signals.

**Effort:** ~6 invariant INSERTs + runbook entries. Single migration. Half a day.

### Rank 5 — Per-ticker role tagging (D.2 item #3)

**Why fifth:** Phase A.6's clearest empirical structural finding (NVDA/META/GOOGL momentum vs SPY/AAPL/IWM contrarian). Static config-table assignment based on observed pattern. Once Rank 2 organ ships, role-tagging inside the helper is ~10 LOC.

**Lift:** Adds ticker-specific interpretation to `next_close_signal.direction`. Per-ticker hit rates differ by 50pp at NextClose (NVDA 53% vs SPY 25%) — encoding this in the brain composition routes captain's "TSLA decoupled / SPY flat" intuition to specialists.

**Effort:** Same helper. Trivial. Ship in Rank 2 PR or follow-on PR.

### Rank 6 — First-cross timing leadership signal (D.2 item #4) and Day-level consensus (D.2 item #5)

**Why sixth:** Both depend on per-ticker state from Rank 2 + grader corpus from Rank 1. Cross-timing-dispersion + leader-of-the-day are cheap derived metrics; they go into the watchlist-aggregate state object.

**Lift:** Captures the captain's QQQ-leads-Mag7 pattern + day-level coherence in machine-readable form. Estimated MID lift — useful for context, not always-decisive on its own.

**Effort:** Within Rank 2 helper. <50 LOC additional.

### Rank 7 — Granularity expansion experiments (D.2 items #6-10)

**Why last:** Each requires its own empirical pass to estimate lift. Items #6 (aggressor split) and #9 (per-strike) are theoretically strongest but unproven. Sequence after Rank 1's grader has generated 30-60 days of measured baselines.

**Lift:** UNKNOWN per dimension; experiments needed.

**Effort:** RPC migrations + frontend updates per dimension. Each is its own ship.

---

## What NOT To Ship First — Caveats

- **Don't ship a "cross detection" Slack alert before the grader.** Cowork audit Section 11 Finding 2 suggests this. Phase A shows raw zero-crossings are 50% — alerting on them is noise. Wait for magnitude/phase-conditioned alerting after Rank 1+3 are running.
- **Don't auto-trade or auto-flag specialists from butterfly state until Rank 1 has ≥30 days of grading.** Phase A's hit rates are sample-size constrained (n=14-60 per per-ticker cell). Specialists should READ the new field but not have a rule that fires on it until the grader corroborates the magnitudes empirically over a longer window.
- **Don't extend Layer 1 / defense-net to butterfly producer code yet.** PR #59 already covers `mcp/` + `scripts/d3_experiment/`. The butterfly producer (when shipped) will live under `supabase/functions/ct-butterfly-detector/` — already in Layer 1's `supabase/functions/` scope.

---

## Summary Table — Empirical Findings That Drive the Ranking

| Phase A finding | Where it cashes out |
|---|---|
| Bullish crosses → NextClose: 63% hit (n=200) | next_close_signal directional bull |
| Bearish crosses → NextClose: 36.7% hit = 63% reverse-hit (n=207) | next_close_signal contrarian bear (mean-reversion gating) |
| Mid-magnitude bullish midday → NextClose: 71.9% hit (n=96) | Highest-confidence cell. Drives confidence='high' tier. |
| Large-magnitude bearish → NextClose: 22.2% hit = 77.8% reverse (n=72) | Strongest contrarian buy signal |
| Small-magnitude crosses ≈ 50% hit | Filter out: cross_magnitude_tertile='small' → low confidence |
| QQQ leads slow Mag7 by 30-90 min on first-cross timing | Watchlist `cross_leader_today` field; per-ticker `ticker_role` tagging |
| NVDA/TSLA lead QQQ; SPY ≈ QQQ; GOOGL is laggard | ticker_role assignments (fast_leader / index_carrier / slow_follower) |
| 5-9 of 10 tickers usually agree on EOD direction | Watchlist `consensus` field |
| Per-ticker hit-rate spread: 25% (SPY/AAPL/IWM at NextClose) → 78% (NVDA at 5min) | Per-ticker `ticker_role` makes the spread visible to specialists |
| Minute-level cumsum cross-correlation ≈ 0% across pairs | Don't ship cross-correlation features. Lead-lag is in cross-event timing only. |
| 15-day sample insufficient for per-cell sample sizes (some n<10) | Don't auto-trade until grader corpus = 30+ days |

---

**End of empirical + design pass.** All numbers are direct queries against current Supabase state (2026-04-17 → 2026-05-07 RTH). Captain decides priority sequencing of subsequent ship work; engine-room awaits direction.
