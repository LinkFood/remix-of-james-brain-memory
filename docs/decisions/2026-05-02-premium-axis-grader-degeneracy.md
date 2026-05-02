# 2026-05-02 — Premium-axis grader degeneracy: diagnosis + fix shapes (no ship)

**Phase 4 surfaced:** `premium_axis_outcome` distribution on n=30 settled is 27 partial / 3 win / 0 loss. Hit-rate-strict 0.10, hit-rate-weighted 0.55. The grader essentially never calls a premium-axis loss.

## Root cause: asymmetric anchoring

`supabase/migrations/20260502040600_specialist_v2_score_rpc.sql` lines 136-154:

```sql
IF v_track_peak IS NOT NULL OR v_track_current IS NOT NULL THEN
  IF v_track_peak IS NOT NULL AND v_track_peak >= v_premium_threshold THEN
    v_premium_outcome := 'win';                       -- (1) WIN: peak >= +50%
    v_premium_alpha := v_track_peak;
  ELSIF v_track_drawdown IS NOT NULL
        AND v_track_drawdown <= -v_premium_threshold
        AND COALESCE(v_track_current, 0) <= 0 THEN
    v_premium_outcome := 'loss';                      -- (2) LOSS: drawdown <= -50% AND current <= 0%
    v_premium_alpha := COALESCE(v_track_current, v_track_drawdown);
  ELSIF v_track_status IN ('WORKING')
        AND v_track_print_time IS NOT NULL
        AND now() - v_track_print_time < interval '4 hours' THEN
    v_premium_outcome := 'pending';
    v_premium_alpha := v_track_current;
  ELSE
    v_premium_outcome := 'partial';                   -- (3) catch-all
    v_premium_alpha := v_track_current;
  END IF;
END IF;
```

Threshold from migration line 206-207: `v_premium_threshold = 50.0 / 100.0 = 0.5` (50% move on contract premium).

**The bug isn't the threshold — it's the anchoring asymmetry.**

| classification | what it requires | anchored on |
|--|--|--|
| WIN  | `peak >= +50%` (contract ever touched +50% within ±2hr window) | best point reached |
| LOSS | `drawdown <= -50%` **AND** `current <= 0%` (contract dropped -50%+ AND is still down at evaluation) | worst point + recovery check |

**WIN is generous.** Any spike to +50% counts, even if the contract subsequently crashed back.
**LOSS is strict.** Requires both deep drawdown AND failure to recover. A contract that drops -60% then recovers to +5% is not a loss — it falls through to `partial`.

Combined with WIN-first ordering (line 137 fires before line 140), this means: **a contract that spiked +60% then crashed -60% is classified WIN, not LOSS.** Markets are noisy; lots of contracts touch +50% transiently, almost none satisfy "deep drawdown with no recovery."

## Distribution evidence

n=30 settled premium grades (current corpus, all specialist-source):
- **27 partial** — none of these hit either +50% peak OR (drawdown ≤ -50% with current ≤ 0).
- **3 win** — touched +50% peak at some point.
- **0 loss** — none satisfied the three-part loss condition.

Compare to underlying axes which are symmetric (lines 184-187, 205-207, etc. — all use `>= threshold` for win, `<= -threshold` for loss, on the SAME variable `v_und_*_pct = end-vs-base move`):

| axis | win | loss | partial | strict_hr |
|--|--:|--:|--:|--:|
| premium | 3 | 0 | 27 | 0.10 |
| underlying_4h | 24 | 18 | 46 | 0.27 |
| underlying_1d | 27 | 30 | 27 | 0.32 |
| underlying_3d | 29 | 22 | 17 | 0.43 |

Underlying axes have ~symmetric win/loss counts. Premium axis is degenerate in one direction.

## Fix shapes (James picks)

### Option 1 — Symmetric peak/trough anchoring (simplest)

Drop the `current <= 0` gate from line 142. Make WIN and LOSS both anchored on best-or-worst point reached during the window:

```sql
IF v_track_peak IS NOT NULL AND v_track_peak >= v_premium_threshold THEN
  v_premium_outcome := 'win';
  v_premium_alpha := v_track_peak;
ELSIF v_track_drawdown IS NOT NULL AND v_track_drawdown <= -v_premium_threshold THEN
  v_premium_outcome := 'loss';
  v_premium_alpha := v_track_drawdown;  -- worst point, mirrors win using best
ELSIF ...
```

**Pro:** clean, mirrors underlying axes' "did the move ever happen?" semantics. Both classifications now aggressive.
**Con:** any contract that whipsawed +50%/-50% gets classified WIN (line 137 fires first). Probably want to handle the both-fire case explicitly. Also: many contracts will now register as LOSS that previously fell through to PARTIAL — the historical 27 partials would mostly reclassify (some as wins, more as losses). Re-grading required.

### Option 2 — Symmetric end-anchored (conservative)

Both WIN and LOSS based on `current` (end-of-window contract %), not peak/drawdown:

```sql
IF v_track_current IS NOT NULL AND v_track_current >= v_premium_threshold THEN
  v_premium_outcome := 'win';
  v_premium_alpha := v_track_current;
ELSIF v_track_current IS NOT NULL AND v_track_current <= -v_premium_threshold THEN
  v_premium_outcome := 'loss';
  v_premium_alpha := v_track_current;
...
```

**Pro:** matches what underlying axes do (end-of-horizon close vs base close). True symmetry. Reflects realized P/L if you held through the whole window.
**Con:** loses the "did this ever spike?" information. The 3 current wins were peak-driven — they might reclassify to partial under this rule if the contract didn't end at +50%.

### Option 3 — Realistic exit (which-came-first)

Track which event came first chronologically: peak ≥ +threshold or drawdown ≤ -threshold. Classify based on whichever happened first.

```sql
-- pseudocode; needs ts column from ct_contract_tracks
SELECT
  MIN(print_time) FILTER (WHERE peak_contract_pct >= v_premium_threshold)  AS first_win_ts,
  MIN(print_time) FILTER (WHERE max_drawdown_pct <= -v_premium_threshold)  AS first_loss_ts
FROM ct_contract_tracks ...

IF first_win_ts IS NOT NULL AND (first_loss_ts IS NULL OR first_win_ts < first_loss_ts) THEN
  win
ELSIF first_loss_ts IS NOT NULL THEN
  loss
ELSE
  partial
```

**Pro:** captures "you'd have closed at the spike" or "you'd have stopped out before recovery." Most realistic.
**Con:** more complex query. ct_contract_tracks may not store enough granular history to resolve "which came first" without more snapshot rows.

### Option 4 — Multi-tier with magnitude

Three buckets per direction: WIN / SMALL_WIN / PARTIAL / SMALL_LOSS / LOSS using ±25% and ±50% thresholds. Eliminates the all-or-nothing cliff.

**Pro:** higher information content.
**Con:** breaks the existing 4-state schema (win/loss/partial/pending). Significant downstream change.

## Recommendation

**Option 1** for immediate fix — minimal code change (drop one AND clause), restores symmetry, mirrors how underlying axes already work conceptually (peak/drawdown ≈ "did the move occur?"). Re-grade the 30 existing rows after the fix to verify the distribution looks more like underlying axes.

**Long-term: Option 3** (realistic exit) if you ever want premium-axis to drive paper-trading P/L decisions, since it's the most faithful to "what would have actually happened to a trader." But that's beyond current scope per Tenet 1 (intelligence amplifier, not auto-trader) — premium axis is just a hit-rate signal, not a P/L signal.

**Don't ship anything during the C1 verification window (through 2026-05-15)** — this changes the grader RPC. Even if the change is conceptually right, it perturbs the experimental layer being measured. Park the fix until 2026-05-16 unless James explicitly overrides.

## Open questions for James

1. Pick a fix shape (1, 2, 3, or 4)?
2. Wait for C1 window to close (2026-05-15) or override?
3. Re-grade existing 30 rows after fix lands, or only apply forward? (Re-grading would change the historical baseline numbers in `docs/calibration/2026-05-02-corpus-baseline-and-first-slices.md`.)
4. Do you want premium-axis grades on detector flags too (i.e., does Track 1 path matter here)? Path B keeps premium axis specialist-only; Path A would require reasoning about whether premium-axis classification means the same thing for whale_v1 / signature_v1 flags (which lack a "specialist read" context).

Awaiting decisions before Track 2 ships.
