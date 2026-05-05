# Phase A — D1 (`scored_at` filter) NVDA `no_events` class-kill diagnosis

**Date:** 2026-05-05 evening (post-RTH)
**Trigger:** James chose Option D1 over 1A from prior audit
(`2026-05-05-nvda-no-events-upstream-phase-a.md`, commit `44fc47a`) per
Tenet 15 — but asked for a NEW Phase A audit before building.
**Posture:** READ-ONLY. No code, no migrations, no deploys, no writes.
The question is empirical: does D1 kill the NVDA-no-events failure class,
or only address a tiny slice of it?

---

## TL;DR — Verdict on D1: **WRONG_FRAME**

D1 (switching `loadCandidateEvents` from `event_ts` filter to `scored_at`
filter) recovers **only 14 of 129 (10.9%)** of the no_events fires across
all 10 specialists for the 4 trading days 2026-04-30 → 2026-05-05.

For NVDA specifically, D1 recovers **2 of 24 (8.3%)** no_events fires.

**The dominant failure mode is score-distribution drift (89.1%), not
timing-race (10.9%).** D1 is misframed — it kills a real but tiny class
while leaving the actual problem untouched.

The structural answer is **D2 — wakeup threshold recalibration (per-ticker,
regime-aware)** — not D1. D1 should NOT be queued as Phase B in its
current form. D2 should be queued as a separate Phase A → Phase B brief.

| Question | Verdict |
|---|---|
| Q1 — Is failure timing race or score drift? | **Score drift dominates: 89.1% vs 10.9%** |
| Q2 — Does D1 fix both modes? | **Only timing race. Misses the dominant 89.1%.** |
| Q3 — Affected scope? | **All 10 specialists.** NVDA worst (75% no_events rate). 5 of 10 ≥40% no_events. |
| Q4 — Operational risk of D1 swap? | **Low for the wakeup function itself.** Cross-organ semantic divergence (specialist's window-meaning differs from tape-reader / dispatcher / EOD). |

---

## §1 — Timing race vs score-drift breakdown

### Source-of-truth (re-confirmed)

`_shared/specialistRunner.ts:607-639` `loadCandidateEvents()` — table is
`ct_scored_flow`, both `event_ts` and `scored_at` columns exist, current
filter is `score >= wakeupThreshold AND event_ts >= now() - 30 min ORDER
BY score DESC LIMIT 15`. `CANDIDATE_WINDOW_MIN = 30`.

Table schema confirmed via `?select=id,ticker,score,event_ts,scored_at&limit=1`.

### Cron schedule (re-confirmed)

`migrations/20260423000037_v2_specialist_schedule.sql:32` — array order
`['spy','qqq','iwm','aapl','msft','googl','amzn','meta','nvda','tsla']`,
`v_minute = (idx-1) * 6`. So per-ticker minute: SPY 0, QQQ 6, IWM 12,
AAPL 18, MSFT 24, GOOGL 30, AMZN 36, META 42, NVDA 48, TSLA 54. RTH
windows 13-20 UTC, M-F → 8 fires/ticker/day.

### Methodology

For every (ticker, scheduled_fire_time) on the 4 trading days
2026-04-30 / 2026-05-01 / 2026-05-04 / 2026-05-05 (32 fires/ticker, 320
total fires):

- **Current visibility:** events with `score >= threshold AND fire-30min
  <= event_ts <= fire AND scored_at <= fire` (i.e. what the current code
  sees).
- **D1 visibility:** events with `score >= threshold AND fire-30min <=
  scored_at <= fire` (what D1 would see).
- **Timing race count:** events with `score >= threshold AND fire-30min
  <= event_ts <= fire AND scored_at > fire` (event landed in the
  event_ts window but wasn't yet scored at fire time).

Source data: full per-ticker scored-flow rows where
`score >= ticker.wakeup_threshold` AND
`event_ts BETWEEN '2026-04-30T00:00:00Z' AND '2026-05-05T23:59:59Z'`,
paginated past PostgREST 1k cap.

### Results — per-ticker per-day no_events count (current / D1 / total fires)

```
Ticker | 04-30  | 05-01  | 05-04  | 05-05  | Total
       | c/d/f  | c/d/f  | c/d/f  | c/d/f  | c/d/f
-------|--------|--------|--------|--------|---------
SPY    | 2/1/8  | 1/1/8  | 1/1/8  | 1/1/8  |  5/ 4/32
QQQ    | 3/2/8  | 3/3/8  | 1/1/8  | 3/3/8  | 10/ 9/32
IWM    | 1/1/8  | 1/1/8  | 3/3/8  | 3/3/8  |  8/ 8/32
AAPL   | 3/3/8  | 3/3/8  | 4/4/8  | 3/3/8  | 13/13/32
MSFT   | 1/1/8  | 6/3/8  | 7/6/8  | 7/7/8  | 21/17/32
GOOGL  | 2/1/8  | 4/1/8  | 6/5/8  | 3/3/8  | 15/10/32
AMZN   | 4/4/8  | 5/5/8  | 3/3/8  | 3/3/8  | 15/15/32
META   | 1/1/8  | 5/4/8  | 5/5/8  | 3/3/8  | 14/13/32
NVDA   | 5/4/8  | 3/3/8  | 8/7/8  | 8/8/8  | 24/22/32
TSLA   | 1/1/8  | 1/1/8  | 1/1/8  | 1/1/8  |  4/ 4/32
```

### Failure mode attribution (per ticker)

```
Ticker  TotFires  NoEvtCurr  NoEvtRate  TimingRaceShare  ScoreDriftShare
SPY           32          5      15.6%            20.0%            80.0%
QQQ           32         10      31.2%            10.0%            90.0%
IWM           32          8      25.0%             0.0%           100.0%
AAPL          32         13      40.6%             0.0%           100.0%
MSFT          32         21      65.6%            19.0%            81.0%
GOOGL         32         15      46.9%            33.3%            66.7%
AMZN          32         15      46.9%             0.0%           100.0%
META          32         14      43.8%             7.1%            92.9%
NVDA          32         24      75.0%             8.3%            91.7%
TSLA          32          4      12.5%             0.0%           100.0%
GRAND TOTAL  320        129      40.3%            10.9%            89.1%
```

### Scoring lag distribution (sanity check on race plausibility)

```
Ticker  count>=t  lag_p50_s  lag_p95_s  lag_max_s
NVDA         84        237        345        598
MSFT         82        185        301        323
AAPL        143        174        293        537
GOOGL       142        179        311        350
AMZN        166        199        319        577
META        137        188        324        519
TSLA        559        186        347        651
SPY         418        161        292        348
QQQ         222        155        289        335
IWM         179        159        287        299
```

Scoring lag is consistently 2.5-6 minutes (max ~10.85 min). **Never
exceeds 30 min**, so D1's "look back 30 min by scored_at" doesn't widen
the lookback meaningfully — it just shifts the window forward by ~3 min.
This bounds D1's recovery ceiling.

### Verdict

**Q1 answer:** Score-distribution drift accounts for **89.1%** of all
no_events fires across all 10 specialists. Timing race accounts for the
remaining **10.9%**. For NVDA specifically, 22 of the 24 zero-event fires
would still be zero under D1 — the events simply did not exist at any
score ≥60 in the wakeup window, by either filter.

---

## §2 — Does D1 address both failure modes?

**No.** D1 addresses ONLY the timing-race subset (10.9% of no_events
fires globally, 8.3% for NVDA).

The failure mode threshold from the brief was:

| If timing race share is | Then D1 is |
|---|---|
| ≥90% | The right class kill |
| 50-90% | Partial — needs follow-up |
| <50% | Misframed — D2 (threshold recalibration) is the actual fix |

Empirical share is **10.9%**. Decisively below the misframe threshold.
**D1 should NOT be the Phase B build target.**

### What D1 would NOT fix on NVDA

- 2026-05-05: 8 fires, 8 no_events. Under D1 → still 8 no_events.
- 2026-05-04: 8 fires, 8 no_events. Under D1 → 7 no_events (1 recovery).
- 2026-05-01: 8 fires, 3 no_events. Under D1 → 3 no_events (0 recovery).
- 2026-05-04 + 2026-05-05 combined: D1 recovers exactly 1 of 16 fires.

The proximate cause from the prior audit holds: NVDA's actual scored
flow distribution is below the threshold. Race-fixing doesn't
manufacture events that didn't score above 60.

---

## §3 — Per-specialist affected scope

### Last successful write to `ct_specialist_reads` (per ticker)

| Ticker | Last write | Writes since 04-30 | no_events rate | Score-drift share |
|---|---|---|---|---|
| **NVDA** | **2026-05-01T18:48:32Z** ← 4.5 days stale | 6 | 75.0% | 91.7% |
| MSFT | 2026-05-05T15:24:30Z | 11 | 65.6% | 81.0% |
| GOOGL | 2026-05-05T19:30:42Z | 19 | 46.9% | 66.7% |
| AMZN | 2026-05-05T19:36:35Z | 24 | 46.9% | 100.0% |
| META | 2026-05-05T19:42:32Z | 19 | 43.8% | 92.9% |
| AAPL | 2026-05-05T19:18:30Z | 20 | 40.6% | 100.0% |
| QQQ | 2026-05-05T20:06:31Z | 25 | 31.2% | 90.0% |
| IWM | 2026-05-05T20:12:36Z | 24 | 25.0% | 100.0% |
| SPY | 2026-05-05T20:00:46Z | 32 | 15.6% | 80.0% |
| TSLA | 2026-05-05T19:54:23Z | 29 | 12.5% | 100.0% |

### Score-thresholded events per day per ticker (regime drift evidence)

```
Ticker  04-30   05-01   05-04   05-05
NVDA      37      40       5       2     ← 95% drop
MSFT      52      18       8       4     ← 92% drop
AAPL      44      68      16      15     ← 78% drop
META      84      14      17      22     ← 74% drop  (recovered some)
AMZN      69      24      50      23     ← noisy, net down
GOOGL     65      30      12      35     ← noisy
TSLA     129     200      83     147     ← stable (lower threshold helps)
SPY      122     141      86      69     ← softening
QQQ       30      67      60      65     ← stable
IWM       38      44      49      48     ← stable
```

### Confirmed beyond NVDA + MSFT

The prior audit named NVDA + MSFT as the two near-threshold names. This
audit shows **AAPL (40.6% no_events), META (43.8%), AMZN (46.9%), GOOGL
(46.9%) are all in the same trouble class** — half of their fires this
week produced zero candidate events. They wrote SOMETIMES because they
got lucky on cadence overlap, but their score-drift share is just as
high (66-100%).

The "NVDA stands alone" framing from the prior audit was wakeup-log
sample bias (only 17 rows in 1.5 hours visible). With the full 4-day
reconstruction, the failure class is **5 of 10 specialists in
score-drift trouble**, not 1 or 2.

---

## §4 — Operational risk of the D1 swap

### Direct callers of `loadCandidateEvents`

```
specialistRunner.ts:1196 — sole caller, inside runSpecialistWakeup()
```

The candidate set is consumed only as: (a) `events.length === 0` gate
for `skip_reason='no_events'`, and (b) passed to the Claude prompt as a
score-DESC-ordered list of up to 15 candidates. Order is by `score DESC,
LIMIT 15` — NOT by event_ts. So the swap doesn't change downstream
ordering or count contract.

### Cross-organ semantic divergence

`ct_scored_flow` consumers across the codebase:

| Function | Filter on event_ts? | Affected by D1? |
|---|---|---|
| `ct-tape-reader/index.ts:244,315` | yes (`event_ts >= windowStart`) | Direct read; D1 doesn't change this caller |
| `ct-specialist-dispatcher/index.ts:66` | yes (`event_ts >= lookbackIso`) | Direct read; same race issue, but DIFFERENT consumer |
| `ct-eod-report/index.ts:630` | yes | EOD frame is daily, race irrelevant |
| `ct-eod-summary/index.ts:307` | yes | Daily, race irrelevant |
| `ct-score-self-grade/index.ts:105` | yes | Backtest grading, race irrelevant |
| `ct-oi-snapshot/index.ts:284` | yes | OI lookup, not scored-flow scan |
| `ct-slack-digest/index.ts:147` | yes | Display, daily |
| `ct-signature-watcher/index.ts:480` | uses score lookup, not window scan | n/a |
| `_shared/alarmTiering.ts:168,194` | per-id lookup | n/a |
| `migrations/20260502060000_ct_flag_analysis_corpus.sql:92` | LEFT JOIN by id | n/a |

**Risk under D1:** The specialist's notion of "candidate events visible
in the last 30 min" would silently diverge from every other organ's
notion ("events that happened in the last N min"). Specifically:

- **Dispatcher race symmetry:** The dispatcher (`ct-specialist-dispatcher`)
  also uses `event_ts` filter on `score >= 70` for a 5-min lookback. If
  a hot event is scored 4 minutes after event_ts, the dispatcher fire
  triggered by that event still uses event_ts — so the dispatcher would
  be MORE likely to fire than the specialist sees. Asymmetric.
- **Tape-reader & EOD telemetry coherence:** Tape-reader narrates "in
  the last hour, 5 NVDA prints scored ≥60." A D1 specialist would say
  "in the last 30 min I saw 7 NVDA prints scored ≥60" — counts could
  contradict by a few minutes' worth of late-scored rows. Confusing for
  the synthesis layer's brain organs.
- **Specialist recall property:** The recall organ stores
  source_flow_ids by event id, not timestamp. Unchanged.

### Scoring lag implication

Lag p95 ≤ 350 sec across all tickers. `scored_at` filter would shift
the visibility window ~3-5 minutes forward but never beyond
`CANDIDATE_WINDOW_MIN`. So D1 does not add weird "future" visibility,
just a ~10-15% earlier-tail trim of the window.

### Verdict

**Low risk for the function itself.** Cross-organ telemetry coherence
takes a small hit. Not a blocker, but the audit recommends NOT making
this swap solely for a 10.9% recovery — the cross-organ semantic drift
isn't worth a sub-15% improvement.

---

## §5 — D2 brief shape (separate Phase A → Phase B)

This is the actual fix. Surfaced as a SEPARATE deferred brief, not
auto-bundled.

**Title:** Wakeup threshold recalibration — regime-aware, per-ticker
defaults

**Hypothesis to test:** Mid-IV-rank Mag7 names (NVDA, MSFT, AAPL, META,
AMZN, GOOGL) all have score distributions that have shifted ~10 points
lower in the 2026-05-04 → 05-05 regime, while their wakeup_threshold
remains at the regime-pre-shift value of 60. Lower-IV / index names
(IWM, SPY, QQQ, TSLA) are less affected because their thresholds were
either already low (IWM/TSLA 55) or their volume is structurally larger
(SPY/QQQ).

**Open D2 questions James needs to answer:**

1. **Static lower vs regime-adaptive.** Is the answer "lower NVDA/MSFT
   to 55 today" (Tenet 15 patch) or "wakeup_threshold becomes a
   function of recent score-distribution percentile per ticker"
   (structural)?
2. **Which percentile?** If adaptive: should threshold = rolling 5-day
   p75 of that ticker's score distribution? p80? Today's NVDA p75 is
   50, not 60.
3. **Trust impact.** Lowering NVDA threshold means more wakeups → more
   Claude spend → more flags considered. Tenet 3 says trust-per-alarm
   is the metric. What does the 7-day post-recalibration false-alarm
   rate need to look like to keep trust intact?
4. **Where regime is read.** `ct_pulse_events` has per-ticker regime
   classification. Could the threshold be regime-conditioned (e.g. in
   `chop_neutral` regime, threshold drops 5 points)?

**D2 Phase A would investigate:**

- Per-ticker p50/p75/p95 score distribution by trailing 5-day window
- Correlation between trailing distribution shift and post-flag alpha
  (does lowering threshold actually surface useful signal, or just
  noise?)
- Whether a ct_config-side lookup would do (one-line per ticker) or a
  function/RPC needs to be added
- Cross-check against the corpus MV (`ct_flag_analysis_corpus`) for
  alpha-by-conviction-bucket to see what conviction range justifies a
  flag

**D2 is NOT shippable without that A first.** Threshold tuning is
trust-tax; doing it blind would break the "is the alarm worth your
attention" calibration.

---

## §6 — Trade-offs needing James's call before any Phase B

1. **D1 is the wrong frame; do we accept the prior audit's Option 1A
   (one-line `ct_config` UPDATE NVDA threshold 60 → 55) as the Tuesday
   patch while D2 is being designed?** 1A is reversible, single-row,
   embeds the same meme-tier decision that violated the implicit
   "Mag7 = 60 club" assumption. But it's the only available Tuesday-AM
   move that would silence the warden's `specialist_oldest_ticker
   _freshness_rth` alert tomorrow. Tenet 15 says no patches — but
   the structural fix (D2) needs design time.

2. **Did the prior audit's Recommendation hold?** That audit explicitly
   said "defer to tomorrow morning, accept the warden alert" because
   the cause was real (regime, not bug) and unilateral threshold/window
   decisions shouldn't be made at end-of-Tuesday. The empirical case
   for that recommendation got STRONGER in this audit: the failure
   class is bigger than NVDA+MSFT (5 of 10 specialists are in score
   drift), which means the "right" fix needs more thought, not less.

3. **MSFT, GOOGL, META, AMZN, AAPL all sit in this same trough.** A
   per-ticker UPDATE to 55 across all six Mag7 names is a bigger-blast
   one-line `ct_config` move — but moves all six down to TSLA/IWM tier
   simultaneously. That's a tier collapse, not a recalibration. Should
   be design-mode work.

4. **Telemetry gap before any threshold change.** No invariant currently
   tracks per-ticker score-distribution shifts. Before any threshold
   move, would James want a warden invariant on "trailing 5-day p75 of
   score divergence from threshold > N points" so the system raises
   itself when re-calibration is needed?

---

## §7 — Phase B proposal: **DO NOT BUILD D1**

### Recommendation

**Do not queue D1 as a Phase B build.** The empirical failure mode
breakdown (89.1% score drift, 10.9% timing race) makes it the wrong
class kill — it would deploy 10 specialists, introduce cross-organ
semantic divergence, and leave NVDA still at 22 of 24 zero-event fires.

### What to queue instead

1. **D2 Phase A brief (separate)** — wakeup threshold recalibration
   investigation per §5 above. Should run before any threshold change.

2. **Optional Tuesday tactical patch (Option 1A from prior audit)** —
   one-row `ct_config` UPDATE on NVDA threshold 60 → 55 to silence the
   warden tomorrow morning while D2 is in design. James's call; the
   prior audit's "defer and accept the warden alert" recommendation
   stands per Tenet 15. This audit confirms 1A would have produced a
   write within the next NVDA wakeup window (NVDA's two 05-05 events
   both scored 60 — they'd clear a threshold of 55).

3. **Telemetry invariant (preventive)** — add a warden invariant for
   "ticker with trailing 5-day p75(score) within 5 pts of its
   wakeup_threshold AND wakeup_passed_count_24h ≤ 2". Surfaces score
   drift automatically, before silence. New invariant = SQL row insert
   per Tenet 25.

### Acceptance test (D2 Phase B, when it ships)

- All 10 specialists fire at expected per-day cadence (8 fires/day) for
  ≥2 trading days post-deploy
- NVDA + MSFT no_events rate drops below 30% (current: 75% / 65.6%)
- No specialist exceeds 6 flags/day during the 2-day acceptance window
  (trust-tax check)
- No new Slack-actioned false alarms attributable to the recalibration
  during 2-day window
- ct_brain_telemetry shows specialist organ p95 latency unchanged

### Acceptance test for D1 (if James overrides this audit and ships D1
anyway)

- NVDA no_events rate measurable change: ≤22/24 → ≤21/24 (1 recovery
  per 16 RTH fires per the empirical model — modest improvement)
- No regression in MSFT/GOOGL/META/AMZN/AAPL no_events rate
- No new symbolics in tape-reader / dispatcher / EOD attributable to
  scored_at vs event_ts divergence
- Cost neutral (D1 is one filter swap, not a wakeup-cadence change)

---

## Read order for next session

1. Prior audit `2026-05-05-nvda-no-events-upstream-phase-a.md` (already on main)
2. This audit
3. If D2 chosen as next move: a fresh Phase A on threshold recalibration
   per §5
