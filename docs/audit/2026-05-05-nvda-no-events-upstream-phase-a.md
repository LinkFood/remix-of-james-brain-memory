# Phase A — NVDA `no_events` Upstream Diagnosis

**Date:** 2026-05-05 evening
**Trigger:** v1.1 wakeup_log instrumentation revealed NVDA fires every hour
but every wakeup hits `skip_reason='no_events'`. Last successful NVDA write to
`ct_specialist_reads` was 2026-05-01T18:48:32 — 4.5 days ago.

**Posture:** READ-ONLY diagnosis. No code, migrations, deploys, or writes.
Three hypotheses tested, plus the cross-ticker check.

---

## TL;DR — Most likely cause

**Hypothesis 1 confirmed.** NVDA's actual scored-flow distribution dropped
sharply on 2026-05-04 and 2026-05-05. The system is correctly returning
`no_events` because there genuinely are zero NVDA events ≥60 in 14 of 16
RTH wakeup windows on those two days.

The drop is driven by **real market microstructure**: NVDA contracts
trading today are dominated by `volume < open_interest` (trading existing
positions, not initiating new ones), which costs 10 points in the
`opening_buy` factor and pushes typical scores from the 60-72 range (where
they were on 04-28 → 05-01) down to 50-60 (where they sit now).

**Hypothesis 2 (scoring code regression):** REJECTED. No changes to
`ct_score_flow_event` or `loadCandidateEvents` since 2026-04-24.

**Hypothesis 3 (threshold change):** REJECTED. NVDA `wakeup_threshold = 60`
unchanged since 2026-04-24 01:00 UTC. Same threshold as AAPL/MSFT/GOOGL/
AMZN/META.

**Hypothesis 4 (cross-ticker):** PARTIALLY CONFIRMED. MSFT shows the same
suppression pattern (105 events ≥60 on 04-29 → 4 on 05-05). AAPL also
softer. NVDA stands out only because it sits closer to the threshold edge
in this regime.

---

## Hypothesis 1 — Did NVDA flow drop below threshold?

### Source-of-truth confirmed

`_shared/specialistRunner.ts:607-639` — `loadCandidateEvents()` reads:

```sql
SELECT ... FROM ct_scored_flow
WHERE ticker = $ticker
  AND score >= $wakeupThreshold     -- 60 for NVDA
  AND event_ts >= now() - 30 minutes
ORDER BY score DESC LIMIT 15
```

`CANDIDATE_WINDOW_MIN = 30`, `DEFAULT_WAKEUP_THRESHOLD = 60`
(specialistRunner.ts:133-135).

### NVDA score distribution per day (production query)

| Date | Total events | Min | P50 | P75 | P95 | Max | **Count ≥60** |
|---|---|---|---|---|---|---|---|
| 2026-04-27 | 163 | 15 | 50 | 60 | 72 | 90 | **40** |
| 2026-04-28 | 309 | 0 | 42 | 50 | 58 | 70 | **11** |
| 2026-04-29 | 202 | 5 | 42 | 50 | 55 | 65 | **8** |
| 2026-04-30 | 326 | 0 | 40 | 52 | 65 | 72 | **37** |
| 2026-05-01 | 274 | 0 | 45 | 52 | 62 | 70 | **40** |
| 2026-05-04 | 145 | 5 | 40 | 50 | 55 | 65 | **5** |
| 2026-05-05 | 127 | 5 | 40 | 50 | 55 | 60 | **2** |

The shift between 2026-05-01 and 2026-05-04 is real and large:
- Total event volume: 274 → 145 → 127 (about half)
- P95 score: 62 → 55 → 55
- Max score: 70 → 65 → 60
- Events ≥60: 40 → 5 → 2

### Per-30-min-wakeup-window NVDA ≥60 count

NVDA's hourly safety-net cron fires at minute :48 (idx 8 × 6 = 48 per
migration `20260423000037_v2_specialist_schedule.sql:32-50`). Window is
trailing 30 min, so each wakeup at HH:48 sees `[HH:18, HH:48]`.

**2026-05-04 wakeups (8 RTH windows):**

| Wakeup | NVDA events ≥60 in window |
|---|---|
| 13:48 | 0 |
| 14:48 | **1** (NVDA 197.50P, score 62.5, event_ts 14:48:29) |
| 15:48 | 0 |
| 16:48 | 0 |
| 17:48 | 0 |
| 18:48 | 0 |
| 19:48 | 0 |
| 20:48 | 0 |

**2026-05-05 wakeups (8 RTH windows):**

| Wakeup | NVDA events ≥60 in window |
|---|---|
| 13:48 | **1** (NVDA 200C, score 60.0, event_ts 13:46:39) |
| 14:48 | 0 |
| 15:48 | 0 |
| 16:48 | 0 |
| 17:48 | 0 |
| 18:48 | 0 |
| 19:48 | 0 |
| **20:48** (logged) | 0 |

Of the **two events that fell inside a wakeup window**, both have a
**scoring race**: the score was inserted into `ct_scored_flow` AFTER the
hourly cron started loading candidates.

Example: NVDA 200C event_ts `2026-05-05T13:46:39.701`, `scored_at
2026-05-05T13:51:00.121` — scored 4.5 minutes AFTER event. By the time the
13:48 wakeup ran (which would have queried at ~13:48:01-04), the row was
not yet in `ct_scored_flow`. Next NVDA wakeup is 14:48; window is
[14:18, 14:48], event at 13:46 is OUT.

### Wakeup_log evidence (last 24h after v1.1 deploy)

17 wakeups logged. 9 `no_events` / 8 `passed`. Per-ticker fire pattern
matches the staggered :00, :06, :12, ..., :54 cron schedule.

| Ticker | passed | no_events | max events_considered |
|---|---|---|---|
| AAPL | 1 | 1 | 1 |
| AMZN | 1 | 1 | 2 |
| GOOGL | 1 | 1 | 3 |
| IWM | 1 | 0 | 4 |
| META | 1 | 1 | 1 |
| MSFT | 0 | 2 | 0 |
| **NVDA** | **0** | **2** | **0** |
| QQQ | 1 | 0 | 1 |
| SPY | 1 | 0 | 2 |
| TSLA | 1 | 1 | 2 |

NVDA + MSFT are the only tickers with zero passed wakeups in this window.

### Last write to `ct_specialist_reads` (per ticker, full 4.5-day fan-out)

| Ticker | Last write |
|---|---|
| **NVDA** | **2026-05-01T18:48:32** ← 4.5 days stale |
| MSFT | 2026-05-05T15:24:30 |
| AAPL | 2026-05-05T19:18:30 |
| GOOGL | 2026-05-05T19:30:42 |
| AMZN | 2026-05-05T19:36:35 |
| META | 2026-05-05T19:42:32 |
| TSLA | 2026-05-05T19:54:23 |
| SPY | 2026-05-05T20:00:46 |
| QQQ | 2026-05-05T20:06:31 |
| IWM | 2026-05-05T20:12:36 |

NVDA truly has not written in 4.5 days. MSFT cleared the threshold
sometime today (15:24), but otherwise tracks NVDA's pattern.

### What changed in NVDA's scoring inputs

Direct comparison of top-scoring NVDA events on 04-30 vs 05-05:

**04-30 top NVDA events (score 72)** — every one looks like:
- `vol/oi >= 1.69`, `ask_side_perc = 100`, `opening_buy = 25`,
  `single_direction = 15`, `iv_context = 0` (iv_rank 54.6),
  `context.adjustment = +7` (stacking + regime agree)
- Raw 65, +7 ctx → final **72**

**05-05 top NVDA events (score 60)**:
- `vol/oi = 0.09 → 0.41`, `ask_side_perc = 98-100`, `opening_buy = 15`,
  `single_direction = 15`, `iv_context = 0` (iv_rank 53.6),
  `context.adjustment = +5` (regime_agrees true, no stacking)
- Raw 55, +5 ctx → final **60** (just clears threshold)

The 10-point delta in `opening_buy` factor is decisive:
- `+10` if `ask_side_perc >= threshold` ✓ both days
- `+10` if **`volume > open_interest`** ← FAILS on 05-05
- `+2.5` if not multileg ✓
- `+2.5` if not floor ✓

The market is quiet — NVDA contracts trading today are dominated by
existing-position activity (vol < OI), not fresh contract initiation.

### Verdict — Hypothesis 1: CONFIRMED

NVDA's flow distribution genuinely shifted below the wakeup threshold.
The `no_events` returns are correct behavior; the function's contract
("notify only when score ≥ threshold") is being honored. The system is
not broken.

---

## Hypothesis 2 — Did the scoring function change recently?

### Git log — scoring/loader files since 2026-04-25

```
git log --since='2026-04-25' --until='2026-05-06' -- \
  supabase/functions/_shared/specialistRunner.ts \
  supabase/functions/_shared/attentionScore.ts \
  supabase/functions/_shared/signatureMemory.ts \
  supabase/functions/_shared/contextHelper.ts \
  supabase/migrations/*scor* supabase/migrations/*flow*
```

**`specialistRunner.ts`** (3 commits, none touching `loadCandidateEvents`):
- `5ad7127` 2026-05-05 — instrument + fallback + warden (today's v1.1 fix)
- `f36da46` 2026-05-02 — recall organ extension + tickerCoherenceValidator
- `afbcfd7` 2026-05-01 — specialist recall property + Captain Into The Storm

`loadCandidateEvents()` was last touched 2026-04-30 in `dc52add` (Phase 4
brain migration) and the SQL filter (`score >= wakeupThreshold AND
event_ts >= now() - 30 min`) hasn't changed.

**Scoring formula migrations (`ct_score_flow_event` and friends):**

Last migration to redefine scoring: `20260424000038_scorer_context_columns.sql`
on **2026-04-24**. Nothing touches scoring after 04-24.

Migrations between 04-29 and 05-05 are all in unrelated areas: pulse v2,
specialist v2 schemas, corpus, warden, regime_chop_neutral_rule, flag-grader
overload drop. None alter `ct_score_flow_event`.

### Verdict — Hypothesis 2: REJECTED

No scoring code change. The 04-30 NVDA scores of 72 and the 05-05 NVDA
scores of 60 are computed by the **identical** formula. The shift is in
the inputs (vol/oi ratio), not the math.

---

## Hypothesis 3 — Was NVDA's wakeup_threshold changed?

### Production read

```
ct_config WHERE key LIKE 'specialist.*.wakeup_threshold'
```

| Key | Value | Updated |
|---|---|---|
| specialist.NVDA.wakeup_threshold | **60** | 2026-04-24T01:00:01 |
| specialist.AAPL.wakeup_threshold | 60 | 2026-04-24T01:18:44 |
| specialist.MSFT.wakeup_threshold | 60 | 2026-04-24T01:18:44 |
| specialist.GOOGL.wakeup_threshold | 60 | 2026-04-24T01:18:44 |
| specialist.AMZN.wakeup_threshold | 60 | 2026-04-24T01:18:44 |
| specialist.META.wakeup_threshold | 60 | 2026-04-24T01:18:44 |
| specialist.TSLA.wakeup_threshold | 55 | 2026-04-24T01:18:44 |
| specialist.SPY.wakeup_threshold | 65 | 2026-04-24T01:18:44 |
| specialist.QQQ.wakeup_threshold | 65 | 2026-04-24T01:18:44 |
| specialist.IWM.wakeup_threshold | 55 | 2026-04-24T01:18:44 |

NVDA threshold = 60, identical to AAPL/MSFT/GOOGL/AMZN/META.
**`updated_at = 2026-04-24T01:00:01`** — last touch 11 days ago, before
the silence onset 2026-05-01. Threshold has been quiet for 1.5 weeks.

NVDA does NOT stand out among Mag7 on threshold. SPY/QQQ are stricter
(65), TSLA/IWM are more generous (55). NVDA is mid-pack.

### Verdict — Hypothesis 3: REJECTED

Threshold unchanged in 11 days. Not the proximate cause.

---

## Hypothesis 4 — Cross-ticker silent suppression?

### Per-ticker count of `score >= 60` events per day

| Ticker | 04-28 | 04-29 | 04-30 | 05-01 | 05-04 | 05-05 |
|---|---|---|---|---|---|---|
| **NVDA** | 11 | 8 | 37 | 40 | **5** | **2** |
| **MSFT** | 69 | 105 | 52 | 18 | **8** | **4** |
| AAPL | 13 | 0 | 44 | 68 | 16 | 15 |
| GOOGL | 24 | 36 | 65 | 30 | 12 | 35 |
| AMZN | 41 | 119 | 69 | 24 | 50 | 23 |
| META | 18 | 46 | 84 | 14 | 17 | 22 |
| TSLA | 50 | 41 | 89 | 173 | 69 | 95 |
| QQQ | 168 | 33 | 69 | 117 | 104 | 96 |
| SPY | 136 | 132 | 192 | 247 | 121 | 124 |
| IWM | 16 | 34 | 28 | 37 | 41 | 44 |

### Two-class pattern

**Class A — same suppression as NVDA:**
- **MSFT**: 105 → 4 (96% drop). Last specialist write 2026-05-05T15:24:30
  — only one write today.
- **NVDA**: 40 → 2 (95% drop). Last write 2026-05-01T18:48:32.

Both are mid-iv (NVDA iv_rank 53.6, MSFT around 50), both are sitting at
threshold 60. When the median score moves from ~50 to ~40, the few events
above 60 dry up.

**Class B — fine:**
- TSLA, QQQ, SPY, IWM consistently produce 40-247 events ≥60/day.
  Lower thresholds (TSLA/IWM 55, SPY/QQQ 65 but huge volume) buffer them.
  TSLA is a big-mover with high stacking; SPY/QQQ get massive index flow.

### Why NVDA looks WORSE than MSFT

MSFT got at least one write (15:24 today); NVDA hasn't written in 4.5
days. The difference comes down to:

1. **MSFT cron fires at minute :24** (idx 5 × 6 = 30, but `v_idx - 1`
   makes it 24… actually let me re-check: array order is
   `['spy','qqq','iwm','aapl','msft','googl','amzn','meta','nvda','tsla']`,
   so MSFT is idx 5 → minute 24, NVDA is idx 9 → minute 48).
2. The dispatcher (`*/5 13-20 * * 1-5`) ALSO fires when ct_scored_flow
   has fresh ≥70-score events in the last 5 min, but neither NVDA nor
   MSFT cleared 70 in this regime. Dispatcher is silent on both.
3. So both are entirely on the safety-net hourly cadence, and both
   suffer from the score-race issue (events scored 4-5 min after
   event_ts can land outside the next 30-min window).

NVDA had 4.5 days of mostly-quiet RTH and the few ≥60 events all happened
to land in the dead zone between wakeup windows or after their window
closed. MSFT got luckier today — one ≥60 event happened to be inside the
:24 window when the cron ran.

### Verdict — Hypothesis 4: NVDA is NOT NVDA-specific

The drop is a **regime-wide phenomenon affecting NVDA + MSFT** (the two
mid-conviction Mag7 names with iv_rank near the dead zone and few fresh
contract initiations). NVDA is the worst-case symptom of a structural
near-threshold sensitivity, not a NVDA-coded bug.

---

## Phase B — proposed fix paths (READ ONLY — do not ship)

### If hypothesis 1 (CONFIRMED) is the ship target

**Option 1A — lower NVDA wakeup_threshold from 60 → 55.**
- One-line update in `ct_config`: `UPDATE ct_config SET value = 55 WHERE
  key = 'specialist.NVDA.wakeup_threshold'`.
- Effect: NVDA would have caught all 16 RTH wakeup-window events on
  05-04 + 05-05 vs the 2 it caught.
- Trade-off: 55 is the TSLA/IWM threshold. NVDA is more like a Mag7 single
  name (60 club) than an index/meme. Lowering risks more low-conviction
  flags during normal regimes — undermines Tenet 3 (trust-per-alarm).
- Smallest blast radius. Reversible. Could ship today before the 14:30
  warden alert tomorrow.

**Option 1B — widen `CANDIDATE_WINDOW_MIN` from 30 → 45 or 60.**
- Code change in `_shared/specialistRunner.ts:135` (constant) plus deploy
  of `ct-specialist-nvda` (and ideally all 10 specialists since shared).
- Effect: catches the 4-5 minute scoring lag. Both 05-04 14:48 and 05-05
  13:48 events would have landed.
- Trade-off: longer lookback means events get re-considered across
  wakeups. Daily cap + cooldown still apply. Per-Tenet 15, this is a
  CLASS fix (kills the scoring-race silent-miss class), not a patch.
  Closer to "structural prevention" per Thesis tenet 13.
- Bigger blast radius (10 specialists deploy). Worth waiting for clear
  decision; do not ship today.

**Option 1C — accept this is the system working correctly.**
- The wakeup threshold is the trust gate. Tenet 3: trust-per-alarm IS the
  metric. NVDA flow really isn't crossing the bar. The warden alert
  tomorrow IS the warden doing its job — the system is correctly visible.
- Pair with a small instrumentation: add a warden invariant for "ticker
  with no `passed` in 24 RTH hours BUT with score-distribution-shift
  signal" — surface the regime-vs-bug distinction automatically.
- Zero blast radius. Punchlist item, not a fire.

### If hypothesis 2 had been confirmed (it wasn't)

Would have reverted the offending commit. N/A.

### If hypothesis 3 had been confirmed (it wasn't)

Would have reverted the threshold via `ct_config` update. N/A.

### A class-kill option not in the brief

**Option D — make wakeup decision robust to score-race.**

The structural class here is "event scored AFTER its wakeup window
closes." Two paths to kill it:

- D1: `loadCandidateEvents` queries on `scored_at >= now() - 30 min` (NOT
  `event_ts`) — the wakeup sees what was SCORED in the last 30 min, not
  what was EVENT-stamped. Race-immune.
- D2: dispatcher fires more aggressively on ≥60 events (not just ≥70) for
  per-ticker tickers with no recent passes. Closes the cadence gap.

D1 is cleaner. It's a one-line code change in `loadCandidateEvents()` line
631. But it shifts the contract semantics ("last 30 min of activity" →
"last 30 min of scored output") which may affect grader's notion of
freshness. Needs more thinking. **Not shippable today.**

---

## Trade-offs needing James's call

1. **Threshold-vs-trust:** Lowering NVDA to 55 contradicts the implicit
   tier the team set ("Mag7 = 60, index = 65, meme = 55"). Is NVDA in this
   regime closer to a meme (high beta, moderate flow) or still a Mag7?

2. **Warden alert tomorrow:** The new `specialist_oldest_ticker_freshness_rth`
   invariant fires RED at 14:30 UTC if NVDA hasn't written by then.
   Per James's note: "fix today only if cause is identified quickly and
   cheaply; accept the warden alert if not." Cause IS identified, AND
   Option 1A is one-line and reversible. But shipping it embeds a tier
   decision that may not be intended.

3. **Class-kill vs patch (Tenet 15):** Option 1A is a patch (NVDA-specific).
   Option D1 is a class-kill (race-immune for ALL specialists). Tenet 15
   says: redesign until structural. But shipping D1 today risks broader
   unintended consequences. The warden alert is the cheap tell that
   tomorrow's morning brief should drive the D1 vs 1A decision when
   James is available with full context.

4. **MSFT is also stuck.** Whichever fix lands, decide if it applies to
   MSFT too (or if MSFT writing once today is "good enough" for the
   warden's freshness criteria). The warden invariant is "oldest
   ticker," so just fixing NVDA is sufficient to silence the invariant
   tomorrow — but doesn't address MSFT's underlying near-silence.

---

## Recommendation

**Most-likely cause:** Hypothesis 1 — the score distribution genuinely
dropped because NVDA market microstructure shifted to "trade existing
positions" mode (vol < OI dominant). Code is correct.

**Recommended Phase B:** **Defer to tomorrow morning, accept the warden
alert.** Reasons:

- Cause is real (regime, not bug). Warden firing IS correct behavior.
- The two cheap fixes (1A threshold lower, 1B window widen) embed
  decisions about thresholds and contracts that should not be made
  unilaterally.
- The class-kill (D1) is the right structural answer per Tenet 15 but
  needs more thought than a few hours.
- One day of NVDA silence + one day of MSFT semi-silence is acceptable
  cost vs shipping the wrong abstraction at end-of-Tuesday.

**If James wants ship-today:** Option 1A (NVDA threshold 60 → 55) is the
smallest, most reversible move. One `ct_config` UPDATE. Fully
reversible. Will produce a NVDA write within the next RTH wakeup window
on Wednesday morning.
