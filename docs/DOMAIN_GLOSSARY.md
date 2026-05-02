# Domain Glossary — Co-Trader

Canonical terms used across prompts, schemas, and code. Citations point to
authoritative source files. **Doc-only — NOT wired into runtime
`buildClaudeContext` preamble.** Wire deferred to post-2026-05-15 per
Specialist Recall C1 measurement window discipline.

---

## Universe

### 10-ticker universe lock

The watchlist for Co-Trader v2. **Locked at 10 tickers, no exceptions** per
the strategic reset 2026-04-25 (Tenet 4):

```
SPY, QQQ, IWM,
AAPL, MSFT, GOOGL, AMZN, META, NVDA, TSLA
```

- Sources: `supabase/functions/_shared/watchlist.ts:31` (`DEFAULT_WATCHLIST`)
- Live override: `ct_config['watcher.watchlist']` (15-isolate cache)
- Validation: array length 1..16, each entry `^[A-Z0-9.]{1,8}$`, deduped uppercase
- AMC-style memes are structurally excluded by design
- The `ct_chat` `tickerCoherenceValidator` flags any off-universe mention; warden invariant `chat_off_universe_mentions_24h` is the structural fence

### 0DTE

Zero-days-to-expiry options. A contract whose `expiry == today` (NY-tz). The
most leveraged segment of the option market — small underlying moves
amplify into 100%+ contract moves in minutes. The `time_to_50pct` /
`time_to_100pct` / `time_to_200pct` columns on `ct_contract_tracks`
explicitly track these intraday realization windows.

Mag7 + IBIT + AVGO have Mon/Wed/Fri expiries → single-name 0DTE on
Mon/Wed is real, not just SPY/QQQ/IWM phenomenon. See
`reference_options_expiry_calendar.md`.

---

## Direction & inference

### Direction

Three-valued for specialist output, two-valued for raw flow inference:

- **Specialist flag direction:** `bullish` | `bearish` | `neutral`
- **Flow inference (`directionInference.ts`):** `up` | `down`
- **Lean:** `bullish` | `bearish` | `neutral` | `mixed` (specialist's
  read of overall posture, allows ambiguity that `direction` doesn't)

### Aggressor

Which side of the spread initiated the print:

- **Aggressive ask** (`is_ask=true`) — buyer lifted the offer. Bullish
  for calls, bearish for puts ("buying puts").
- **Aggressive bid** (`is_bid=true`) — seller hit the bid. Bearish for
  calls (call writing or call distribution), bullish for puts (put
  writing).

When neither flag is true (the no-explicit-aggressor case), the
**RepeatedHits rule** applies — see below.

### RepeatedHits rule

Load-bearing inference rule (`directionInference.ts:8`). When UW's
`alert_rule` field signals RepeatedHits and no explicit aggressor flag is
present, **trust the rule's directional intent: RepeatedHits = active
accumulation/buying.**

- Calls: ask-aggressive → bullish
- Puts: ask-aggressive → bearish ("buying puts")

Both sides map to ask-aggressive (BUYING the contract). Pre-2026-04-28 the
put case mistakenly mapped to aggressive_bid_put (= "selling puts" =
bullish), which produced a structural call/bullish bias on 121/121 of one
day's puts. Corrected so puts are symmetric with calls.

The fix lives in `_shared/directionInference.ts`. Memory:
`feedback_direction_inference_repeatedhits_put_inverted.md`.

---

## Conviction & flagging

### Conviction (0-100 scale)

Specialist's self-rated proximity to writing a flag, on every wakeup.

- **0** = quiet day, nothing here
- **100** = you DID flag this wakeup
- The convention is set by `specialistRunner.ts:125` and `:1271`:
  *"how close were you to writing a flag — 0=quiet day, 100=you DID flag"*
- Hard-clamped to `[0, 100]` (`specialistRunner.ts:463`)

The Specialist Recall organ (`specialistRecallContext.ts`) considers
conviction ≥ 50 as "I almost flagged" — included in unflagged-recent
context for self-awareness even when no flag was written.

### Lean

Specialist's overall posture for the wakeup, separate from any specific
flag's `direction`:

- `bullish`, `bearish`, `neutral`, `mixed`

`mixed` is allowed — the specialist may see both a bullish stack and a
bearish unwind in the same window and report `lean=mixed` even with no
flag.

---

## Flow aggregations

### Stack

A repeat-hit pattern on the same contract within a window (default 6h,
≥3 prints, ≥$100k cumulative). Surfaces "institutional repeat conviction"
— the same contract is being touched again and again, not a one-off.

- Source RPC: `ct_contract_stacking(p_window_min, p_min_prints, p_min_premium, p_ticker, p_limit)`
- Per-flag attribution: `ct_max_peak_for_flag(p_option_symbol, p_flag_created, p_flag_horizon)` — see grader silent-exit kill 2026-05-02
- `ct_scored_flow.stacking_prints` ≥ 5 AND `stacking_signal` ≠ null AND
  agreement direction → +10 score boost; contradiction → -5
- Stack interpretations: `call_accum`, `put_accum`, `put_writing`,
  `call_writing`, `call_distribution`, `put_distribution`, `two_sided`,
  `mixed`

### Tide

Market-wide directional bias derived from FlowPulse. Coarse-grained:

- `bullish` — `netPremium > $5M`
- `bearish` — `netPremium < -$5M`
- `flat` — between

Used in `ct_tape_commentary.market_tide` and tape-reader narratives. The
tide formula is the reduced form; FlowPulse `netPremium` is the underlying
quantity.

### Pulse

Per-ticker directional pressure aggregator (`pulseContext.ts`). Each
wakeup samples the most recent 3 ticks of `ct_flow_pulse_ticks` to
compute:

- `netPremium` — latest tick's signed premium
- `slope5min` — premium delta divided by minutes between the two most
  recent ticks
- `regime`:
  - `trending_up` — `slope5min ≥ threshold`
  - `trending_down` — `slope5min ≤ -threshold`
  - `chop` — between (no directional signal in the slope)
  - `unknown` — insufficient data (≤1 tick)

Threshold is tunable: `ct_config['pulse_regime_trend_threshold']`,
default $100,000/min. See `pulseContext.ts:51` and migration
`20260427000210_alarm_pulse_context.sql`.

`ct_flags.pulse_regime_at_fire` snapshots the regime at flag-write time
so post-hoc evaluation can ask "what regime was this flag fired into?".

---

## Math modes (5 modes — `ct_flow_heatmap_*` RPCs)

How a per-row premium value is rolled up across contributing flow alerts.
Selectable per query via `p_math_mode`. Default `aggressive_directional_decay`
(see `flowHeatmapContext.ts:55`).

| Mode | What it sums | Use case |
|---|---|---|
| `total` | `total_premium` (all sides, both directions) | Raw activity volume — "how much money touched this expiry?" |
| `net_signed` | `net_signed_premium` (calls minus puts, signed) | Headline directional balance — call-buy minus put-buy at face value |
| `aggressive_directional_raw` | premium where the aggressor flag actually fired (`is_ask` or `is_bid`), signed | Filters out mid-prints / RepeatedHits-without-aggressor — only "loud" prints |
| `aggressive_directional_decay` | aggressive_directional_raw × time-decay weight | DEFAULT. Same as raw but newer prints count more, older prints decay; the canonical "what does the tape say RIGHT NOW" view |
| `voi_unusual_score` | volume-over-OI score (volume / max(open_interest, 1)) | Pure unusual-activity metric — flags contracts being turned over relative to existing position |

Source: `supabase/migrations/20260430153500_ct_flow_heatmap_rpcs.sql:64`
(`CASE p_math_mode` block).

### Multi-mode agreement

When the heatmap renders a strike or expiry that scores high across
**multiple** math modes simultaneously, that's stronger than scoring high
in only one. Specifically:

- High `aggressive_directional_decay` + high `total` = directional flow
  riding heavy raw volume (real institutional move).
- High `aggressive_directional_decay` only, low `total` = directional but
  thin (could be sweep on illiquid contract — confirm with stacking).
- High `voi_unusual_score` + low absolute premium = small notional but
  unusual relative to OI (penny-call situation; check spot-from-strike
  for distance to ITM).
- High `total` + low `aggressive_directional_decay` = heavy two-sided
  activity, likely dealer hedging — not a directional bet.

The `flow_heatmap` brain organ surfaces all 5 columns so consumers can
read agreement directly.

---

## Pulse regime states

Per-ticker, computed per wakeup from the latest 2-3 ticks of
`ct_flow_pulse_ticks`. Stored on `ct_flags.pulse_regime_at_fire` for
post-hoc.

- `trending_up` — bullish premium accelerating
- `trending_down` — bearish premium accelerating
- `chop` — no significant slope; slope within threshold band
- `unknown` — insufficient ticks (capture cron hasn't filled enough yet)

Threshold tunable per Tenet 16; live value in `ct_config`.

---

## Outcome / grading vocabulary

### Flag-grader outcomes (`ct_flag_grades.outcome`)

- `win` — direction-correct, magnitude met threshold
- `partial` — direction-correct, magnitude below threshold but >0
- `loss` — direction wrong (move beyond `target_threshold_pct` against)
- `invalidated_early` — peak ≤0 or drawdown beyond `alarm_loss_pct`
  (signature/detector axis only)
- (`neutral` no longer used in v2 — replaced by `partial` for the
  small-magnitude case)

### Grading axes

- **Underlying axis** (`specialist`, `james_star`) — uses
  `nearestClose(ct_price_bars, ticker, ts)` for entry/exit spot. Subject
  to the trading-clock gate (skip if both now and horizon are
  market-closed; ct_price_bars doesn't tick).
- **Contract axis** (`signature_alarm`, `detector_alarm`) — uses
  `peak_contract_pct` from `ct_contract_tracks` via
  `ct_max_peak_for_flag`. Independent of ct_price_bars freshness; runs
  any time of day. Boost/penalty thresholds:
  `ct_config['grader.alarm_win_pct']` (default 50%) and
  `grader.alarm_loss_pct` (default 30%).

See `ct-flag-grader/index.ts` and the 2026-05-02 silent-exit kill
(`feedback_warden_catches_build_layer_drift.md`) for the corruption
class that arose when `detector_alarm` flags were misclassified as
underlying-axis.

---

## Warden vocabulary

### Invariant

A SELECT-only query stored in `ct_invariants` that returns one row of
`(metric_value numeric, message text)` plus pass/fail bounds. The
warden's structural shield.

Three classes of failure invariants catch (per
`feedback_warden_catches_build_layer_drift.md`):

1. **Operational** — pipeline broken, data missing, cron stale
2. **Build-layer architectural drift** — a function reactivates a
   path the architecture explicitly retired. Example:
   `specialist_memory_table_dead`
3. **Subtle hallucination class re-emergence** — Claude-side
   coherence violations. Example:
   `chat_off_universe_mentions_24h`

### Severity grades

- `info` — log only
- `warn` — Slack on first fail and on recovery
- `critical` — Slack on first fail, every escalation, and on recovery

### Heartbeat

Once-per-day Slack post when nothing changed. Confirms the warden
itself is alive.

---

## Three-mode rule (Tenet 26)

Every piece of work belongs to ONE of three modes. Building in the wrong
mode wastes effort.

- **Autonomous mode** (cron + edge function) — runs when James isn't
  here. UW ingest, alarm watchers, detectors firing, EOD summary, daily
  brief.
- **UI mode** (React page + hook) — pure read-only window into system
  state. James glances, reads, decides. `/tape`, `/flags`, `/eod`,
  `/specialists`, `/pulse`, `/heatmap`. **No analysis tooling on the
  site.** No backtest buttons. No "click to run" services.
- **Analysis mode** (terminal-Claude) — tuning, backtesting,
  calibration, deep dives, "what if" questions. Lives in this terminal
  under Max 20x. Conversational, cumulative memory across sessions.

The reflex test: *"Does this need to run when James isn't here?"* →
autonomous. *"Will James glance at this in browser?"* → UI page.
*"Will James ASK ME to compute this?"* → terminal-me, never build a
service.

---

## Provenance & citation rules (for future Claude consumers)

Every term above resolves to either a code file path with line numbers
or a migration SQL file. When in doubt about a number or a threshold,
the source-of-truth order is:

1. Live `ct_config` row (most recent) — runtime authoritative
2. Migration SQL that seeded that config row — original semantics
3. Code consumer (helper or runner) — interpretation of the value
4. This glossary — synthesized for prompt grounding (eventually)

If a future runtime-preamble wire happens (post-C1, post-2026-05-15),
this doc is the seed. The wire is its own structural change with its
own measurement window.

---

## Related references

- `feedback_co_trader_thesis.md` — 17 tenets governing every Co-Trader change
- `reference_options_expiry_calendar.md` — Mon/Wed/Fri expiry universe
- `feedback_direction_inference_repeatedhits_put_inverted.md` — the put-side fix
- `feedback_uw_is_ask_bid_never_set.md` — never read raw `is_ask`/`is_bid` from `ct_flow_alerts`; always use `inferDirection()`
- `project_co_trader_synthesis_layer_complete_2026_04_30.md` — 9-organ context architecture
- `feedback_warden_catches_build_layer_drift.md` — 3 classes of warden invariant
- `docs/SYNTHESIS_LAYER.md` — operational reference for `buildClaudeContext`
- `docs/SYSTEM_INDEX.md` — runbook navigator for invariant failures
- `docs/END_STATE_VISION.md` — Captain Into The Storm governing image
