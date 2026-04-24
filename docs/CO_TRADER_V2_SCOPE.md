# Co-Trader v2 — Scope Document

**Status:** Pre-build, awaiting James approval.
**Date:** 2026-04-23
**Author:** Claude (via conversation with James)

---

## The Product in One Sentence

> Co-Trader v2 is a personal options-flow intelligence system that delivers a Slack message when unusual flow on one of 10 tracked tickers is likely predictive of a meaningful price move — with specific contract, direction, horizon, conviction, graded by outcome, and backed by the specialist's accumulating track record.

Everything else in the system exists to make that Slack moment accurate. If it doesn't serve that moment, it gets killed.

---

## Role Shift — What This Is and Isn't

James is a sophisticated day trader with TrendSpider for charting/alerts and SpotGamma for gamma/levels. He trades Mag 7 and indexes, has a day job, checks the tape throughout the day.

**Co-Trader v2 IS:**
- A 24/7 options-flow watcher
- A sharp-vs-hedge classifier
- A prediction engine (flags, not trades)
- A pattern library that builds per-ticker over time
- A Slack push that gets better as it learns

**Co-Trader v2 IS NOT:**
- A paper trader (the v1 mistake)
- A chart tool (TrendSpider)
- A gamma tool (SpotGamma)
- An autonomous trading agent
- A general research assistant

---

## The Watchlist (Locked)

10 tickers with rich options flow:

`SPY · QQQ · IWM · AAPL · MSFT · GOOGL · AMZN · META · NVDA · TSLA`

**Dropped:** GLD, USO, ES (futures/commodities — insufficient options depth for this use case).

---

## The Specialist Model

Each of the 10 tickers has a dedicated Claude specialist. **Not a generalist rotating through 12 tickers** — 10 separate Claude contexts, each knowing one ticker deeply.

### Each specialist has its own:
- System prompt tuned to that ticker's flow patterns
- Memory of its own graded flags (only its flags, only its grades)
- Bias calibration (tends to over-call bullish? correct per ticker)
- Pattern library (historical flow signatures that preceded moves on THIS ticker)
- Wakeup thresholds (based on THIS ticker's baseline)
- Confidence calibration (conviction vs measured hit rate)

### Specialists share:
- Central UW ingestion (one pipe, no per-specialist multiplier)
- Sharp-vs-hedge classifier (heuristic layer)
- Grader (deterministic, price-based at horizon)
- Price-bar store
- Slack push infrastructure

### Why specialists beat a generalist

A single Claude watching 12 tickers:
- Cannot maintain 12 separate bias calibrations
- Pattern memory gets noisy (AMZN patterns contaminating SPY reasoning)
- Conviction drifts toward the average ticker's baseline, not any specific ticker's

10 specialists:
- Each calibrates independently
- Pattern memory stays clean per instrument
- A ticker with ticker-specific edge doesn't get diluted

---

## The Self-Learning Loop (Core — this is the whole point)

This is the system's reason to exist. Every flag is a graded prediction. Every grade writes back to the issuing specialist's memory. The specialist improves over time.

```
┌─────────────────────────────────────────────────────┐
│ FLAG ISSUED                                         │
│   ticker, contract, direction, horizon, conviction, │
│   thesis, invalidation → ct_flags                   │
└─────────────────┬───────────────────────────────────┘
                  ▼
┌─────────────────────────────────────────────────────┐
│ HORIZON REACHED                                     │
│   Grader checks price vs prediction                 │
│   Result: win / partial / loss / self-killed       │
│   Written to ct_flag_grades                         │
└─────────────────┬───────────────────────────────────┘
                  ▼
┌─────────────────────────────────────────────────────┐
│ MEMORY UPDATE                                       │
│   Flag + grade stored in specialist's embedded      │
│   memory. Pattern signature extracted. Signature +  │
│   outcome stored in ct_flag_patterns.               │
└─────────────────┬───────────────────────────────────┘
                  ▼
┌─────────────────────────────────────────────────────┐
│ NEXT SPECIALIST WAKEUP                              │
│   System prompt receives injected priors:           │
│   - Last 10 graded flags for this specialist        │
│   - Hit rate by flag type                           │
│   - Similar prior signatures with outcomes          │
│   - Active biases (flag types with poor track rec) │
│   Specialist decides whether to flag, WITH priors.  │
└─────────────────┬───────────────────────────────────┘
                  ▼
┌─────────────────────────────────────────────────────┐
│ SLACK GATING                                        │
│   v1: push if conviction = 5 (no track record yet) │
│   v2+: push if specialist hit rate on this flag    │
│        type ≥ threshold                             │
│   Low-accuracy flag types silently suppressed from  │
│   Slack, still written to DB for learning.          │
└─────────────────────────────────────────────────────┘
```

**Nothing in this loop requires a human.** Grader is automatic. Memory updates are automatic. Slack gating is automatic. James reads Slack, makes his own trade decisions.

---

## The Scoring Framework (0-100 Conviction Score)

**Research-driven update 2026-04-23:** After deep-dive on UW / BullFlow / academic literature, switched from "9 flag types" to a single **0-100 conviction score** per flag with explicit feature weights. Flag types become descriptive tags, not categories.

Why: academic research (Pan-Poteshman 2006, Augustin et al. 2019, Hu 2014, Lakonishok et al. 2007) identifies specific factors that predict price moves — opening-buy intent + OI confirmation dominate. Also: no competitor ships a transparent composite score. Our lane.

### Positive factors (sum to 100)

| Factor | Weight | Computation |
|---|---:|---|
| **Opening buy intent** | 25 | Ask-side ≥60% + size > OI + not multi-leg + not floor. Full points if all; partial credit per component. |
| **T+1 OI confirmation** | 20 | Does OI at this strike rise ≥ volume next morning? Upgrades flag → "conviction flag." |
| **Single-direction (not spread)** | 15 | No offsetting put/call activity on same name same day at similar size. |
| **DTE 15-45 days** | 10 | Soft band: full in-band, half credit 7-14 or 46-60, zero outside. |
| **Delta 20-70** | 10 | Not lottery (<20), not delta-1 (>80). |
| **IV context** | 10 | IV rank < 30 at time of flow → full. IV rank > 70 → zero (flow into pumped IV is often seller). |
| **Size vs ticker ADV** | 10 | Flow in top decile of ticker's 30d options ADV. Per-ticker baseline. |

### Penalty overlays (subtract)

| Penalty | Max deduct | Trigger |
|---|---:|---|
| Hedge probability | -30 | ETF + ITM + DTE>60 + paired opposite-side activity |
| Earnings within 5 days | -20 | Calendar check; IV plays dominate this window |
| Expiration week | -15 | Monthly / quarterly noise |
| Dealer gamma hedging signature | -15 | Flow appears after large underlying move, aggressor side follows tape |

### Threshold bands

- **80-100** — "conviction flag" — core Slack push candidate
- **60-79** — "flag" — tracked + graded, Slack only once specialist has track record (v2)
- **40-59** — "watching" — logged, not flagged
- **< 40** — ignored

### All parameters live in `ct_config`

No hardcoded thresholds. James can tune any weight or penalty via the config UI. Examples:
- `score.opening_buy_ask_threshold` = 0.60 (tunable — James flagged wanting lower than 70%)
- `score.dte_band_lo` = 15
- `score.dte_band_hi` = 45
- `score.slack_threshold` = 80 (initially)
- `penalty.hedge_max` = 30

### T+1 OI confirmation — two tracks

- **Multi-day flags (horizon > 1d):** wait for T+1 OI read before Slack push. Slack fires on conviction upgrade, not initial flag. Dramatically higher hit rate per Lakonishok et al.
- **Same-day / intraday flags (horizon ≤ 1d):** use fast-lane — continued ask-side pressure >10min + no reversal as same-day proxy for confirmation. Slack fires same session.

This preserves speed for intraday while applying academic rigor to multi-day conviction.

---

## What Gets Killed

### Tables (archive schemas, preserve data for learning)
- `ct_book` (paper P&L)
- `ct_trade_actions` (position management)
- `ct_claude_generations` (generation framework)
- `ct_claude_circuit_breakers`
- `ct_claude_heartbeat` (paper-trader health)
- `ct_trade_audit`

### Edge functions (delete)
- `ct-claude-trade-open`, `ct-claude-trade-reopen`, `ct-claude-book-exit-watcher`
- `ct-book-manager`, `ct-book-eod-close`, `ct-claude-book-writer`
- `ct-claude-open-trade-journal`, `ct-claude-cash-decay`
- `ct-claude-circuit-breaker`, `ct-claude-generation-manager`
- `ct-claude-health-monitor`, `ct-claude-cio-review`
- `ct-morning-brief`, `ct-midday-recap`, `ct-eod-recap`
- `ct-pre-bell-alert`, `ct-pre-bell-gauntlet`, `ct-pre-bell-grader`
- `ct-dream`, `ct-weekly-reflection`, `ct-bias-booth`
- `ct-event-watcher` (generalist, replaced by per-specialist wakeup)
- `ct-watcher` (generalist, replaced by 10 specialists)
- `ct-flag-book-commit` (no book to commit to)

### Pages (hide or delete)
- `/book`, `/commit`, `/preflight`, `/debates`, `/playbooks`, `/stress`
- Morning brief / midday recap / EOD recap UI
- `/ticker/:symbol` in current form (replaced by per-specialist view)
- GEX Radar, GEX Heatmap, LinkGex Deep (SpotGamma)

### Crons (unschedule)
- All paper-trader crons (trade-open, book-manager, eod-close, cash-decay, etc.)
- Generation manager cron
- CIO review cron
- Pre-bell crons
- Morning/midday/EOD recap crons
- DP cluster cron (already done earlier 2026-04-23)

### Tickers (stop ingesting)
- GLD, USO, ES — remove from watchlist everywhere. Stop ingesting. Purge from pulse.

---

## What Gets Repurposed

| Old | New | Notes |
|---|---|---|
| `ct_hypotheses` | `ct_flag_theses` | Per-specialist, narrower scope |
| `ct_trade_ideas` | `ct_flags` | direction, horizon, conviction, invalidation, thesis — schema mostly fits |
| `ct_grades` | Stays | Now graded against price at horizon, not P&L |
| `ct-watcher` (generalist) | 10 `ct-specialist-{TICKER}` functions | Same wakeup pattern, specialist-scoped |
| `ct_alerts` | Replaced by `ct_flags` | Direction, strike, expiry, horizon |
| `ct_pulse_events` / `/pulse` | Stays, flow-only | DP already retired; specialist flags overlay |
| `/edge` | Stays, recast | Attribution by specialist × flag type |

---

## What Gets Built (New)

### 1. Flow scoring engine
- New function `ct_score_flow_event(event_row) RETURNS JSONB` computes the 0-100 composite + tags + penalty breakdown
- Called from `ct-flow-ingester` on every new sweep/flow alert
- Writes to new `ct_scored_flow` table: `(source_id, ticker, score, tags[], factor_breakdown jsonb, classification)`
- All weights + thresholds read from `ct_config` (tunable without redeploy)
- Also classifies: `opening_buy | opening_sell | closing | hedge | ambiguous` based on ask-side + OI heuristics

### 2. Per-ticker baselines
- Nightly rollup: 30-day median premium, volume, sweep count, unusual-activity count per ticker
- `ct_ticker_baselines` table: one row per (ticker, date)
- Used by specialists to normalize "unusual FOR ME"

### 3. OI change tracker
- `ct-oi-snapshot` cron: 3×/day per ticker (open, midday, close)
- UW endpoint: `get_option_chain` or `get_oi_changes`
- Captures top 20 contracts by OI + biggest OI changes
- `ct_oi_snapshots` table with `(ticker, date, timeslot, option_symbol, oi, oi_delta_1d, oi_delta_5d)`
- Morning 8am ET Slack summary: biggest overnight OI builds across 10 tickers

### 4. Specialist framework
- Pattern: `ct-specialist-{TICKER}` edge function per ticker
- Shared `_shared/specialistRunner.ts` — common wakeup logic, memory loading, flag writing
- Per-ticker `ct_specialist_memory` — embedded reflections per specialist
- Per-ticker `ct_specialist_principles` — learned heuristics per specialist
- Per-ticker prompt stored in `ct_config` — tunable without redeploy

### 5. Flag grader
- `ct-flag-grader` cron runs every 30 min
- For each flag whose horizon has passed, check price movement vs prediction
- Write grade to `ct_flag_grades`
- Trigger memory update for originating specialist (fires `ct-specialist-memorize`)

### 6. Slack pusher
- `ct-slack-push-flag` edge function
- Triggered on flag write (webhook or trigger)
- Gating logic:
  - **v1 (launch → first 100 graded per specialist):** push if conviction = 5
  - **v2 (post-100 graded):** push if `specialist_hit_rate(flag_type) ≥ 55%` AND conviction ≥ 4
- Message format:

```
🎯 NVDA 180C 5/2  — sharp flow, conviction 4

$3.2M premium, size 3,200 vs OI 800, ask-side 62%
Thesis: call accumulation building pre-GTC, 3rd day of OI growth
Horizon: Friday close
Invalidation: NVDA closes below 175 today

📊 Specialist track record on unusual_flow:
  NVDA: 12/18 hit (67%) over last 30d
  Similar setups: 2/3 hit (AMZN 5/1, MSFT 4/29)
```

### 7. `/flags` page (new)
- Live stream of active specialist flags
- Countdown to horizon
- Live grade prediction (what's the current price vs target)
- Filter by specialist, flag type, conviction
- Archive view for graded flags

### 8. `/specialists` page (new)
- Dashboard: 10 tiles, one per specialist
- Per tile: current active flags, hit rate by flag type, last 10 graded outcomes, active biases
- Click → detailed specialist view

### 9. `/patterns` page (new)
- Mined flow signatures that preceded moves
- "When unusual_flow + oi_build_overnight occur on same ticker within 1 day, historical outcome: 67% hit"
- Click → list of prior matches with dates + outcomes

### 10. `/pulse` rework
- Stays, but flow-only (no DP — already done)
- Overlay specialist flags as markers on sparklines
- Show current flag count per ticker
- Remove/simplify generalist alert overlay

---

## Execution Order (≈16-20 hrs total)

### Phase 0 — Scrub (2-3 hrs)
- Kill everything in the kill list
- Archive tables (don't drop data, just stop writing)
- Unschedule crons
- Delete edge functions
- Hide pages from nav
- Remove GLD/USO/ES from watchlist everywhere

### Phase 1 — Foundation (4-5 hrs)
- Sharp-vs-hedge classifier (heuristic, in `ct-flow-ingester`)
- Per-ticker baselines (nightly rollup cron)
- OI snapshot tracker (3×/day cron)
- `ct_flags` schema (repurpose from `ct_trade_ideas`)
- `ct_flag_grades`, `ct_flag_patterns`, `ct_specialist_memory`, `ct_specialist_principles` tables

### Phase 2 — First specialist prototype (NVDA, 4 hrs)
- `ct-specialist-nvda` edge function
- `_shared/specialistRunner.ts` — wakeup logic, memory loading, flag writing
- Specialist memory table writes
- Flag writing + deterministic grader
- End-to-end test: NVDA has unusual flow → specialist wakes → flag written → horizon grader closes it

### Phase 3 — Replicate to 10 (3-4 hrs)
- Copy NVDA pattern → 9 more specialists
- Tune each prompt to ticker characteristics (index vs single-name, high-IV vs low-IV, etc.)
- Configure per-ticker wakeup thresholds from baselines
- Schedule specialist crons (event-driven wakeup + safety-net hourly check)

### Phase 4 — Slack + UI (3-4 hrs)
- Slack push integration with v1 gating
- `/flags` page
- `/specialists` page
- `/patterns` page (v1 — simple signature match)
- Update `/pulse` to overlay specialist flags
- Nav cleanup

### Phase 5 — Launch + observe (1 week, ongoing)
- Run system, watch flags fire, grade, self-tune
- Daily review of noisiest specialists / worst-performing flag types
- Adjust prompts based on early failures
- Start tracking: which specialist shows edge fastest?

---

## Honest Expectations Timeline

### Week 1 post-launch
- System live, flags firing, grades accumulating
- Slack pings are **noisy** — most interesting, not reliable
- James needs patience; this is the price of data collection
- Daily tuning on worst-performing flag types

### Weeks 2-3
- First 100+ graded flags per specialist accumulating
- Clear winners and losers emerge in flag types
- Slack gating upgrades to v2 rules per-specialist as threshold crossed
- Specialist prompts tuned from early failures

### Weeks 4-6
- Self-tuning stabilizes
- Slack pings **reduce in frequency, increase in quality**
- **Goal:** first Slack message James acknowledges as "interesting, I'd check that"

### Months 2-3
- Pattern library matures
- Specialists cite historical precedent on new flags
- Flag conviction calibrated to measured hit rates
- Slack messages include priors ("similar setup 2/3 hit last 3 months")
- **Goal:** first Slack message James takes to broker

### Months 4-6
- Co-Trader v2 is a legitimate edge source
- Used as one input alongside own read + charts + TrendSpider
- Compound learning from 500+ graded flags per specialist

---

## Success Metrics

### v1 success (Day 14)
- System live, 10 specialists firing, grades accumulating
- At least one Slack ping lands that James acknowledges as interesting

### v2 success (Day 60)
- At least one specialist shows ≥60% hit rate on ≥1 flag type with n≥20
- James takes a Slack message and acts on it (broker trade)

### v3 success (Day 180)
- Multiple specialists with proven edge across multiple flag types
- Slack pings averaging 2-5 per day, aggregate ≥60% accuracy
- James tracks material alpha from Co-Trader-informed trades

---

## Budget

### UW API
After DP scrub, system uses ~35k/day. v2 adds:
- OI snapshots (3×/day × 10 tickers) = ~30 calls/day
- Specialist on-demand UW probes = ~500/day
- Freed DP budget reallocates to more frequent net-premium-ticks + greek-flow coverage for all 10 tickers = +1,500 calls/day

**Total estimated: ~37k/day. Well under 50k limit.**

### Claude API
Specialists use Haiku for classification (cheap), Sonnet only for flag writing.
- 10 specialists × ~20 wakeups/day during RTH × ~1 Haiku call each = 200/day @ ~$0.01 = $2/day
- ~30 flag writes/day × Sonnet = $5/day
- Memory reflections + pattern extraction = $2/day

**Total estimated: ~$9-12/day = $300-400/month.** Similar to current spend.

---

## James's Answers (2026-04-23)

1. **Slack channel** — single channel (same as current)
2. **Initial Slack gating** — "done right" — using score ≥ 80 + T+1 confirmation for multi-day, same-day proxy for intraday
3. **Macro + news sidebar** — nice-to-have, not required. V2.1 candidate.
4. **Specialist priors** — yes, inject per-specialist track record
5. **Hide vs rip-out** — **surgically delete**. Dead code goes.
6. **Ask-side threshold** — 60% (not 70%) — tunable via `ct_config`
7. **Framing** — "build it great like a hedge fund would for a side project" — serious infra, transparent methodology, tunable params, not precious

---

## Memory

Save this scope to memory: `project_co_trader_v2_specialist_scope_2026_04_23`. Future sessions need to know v2 is the target, v1 is the relic.
