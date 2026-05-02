# 2026-05-02 — Phase A Audit: Tier 2 #9 Detector Lifecycle Automation

**Decision date:** 2026-05-02 ~01:30 UTC (Saturday early morning ET)
**Audit type:** Phase A only — read-only, no code changes
**Phase B:** Mon-Tue with continuing care into Wed if needed
**Pre-Phase-B blocker:** Define seed promote/demote thresholds (~30 min terminal-me analysis pass)

## Substrate health

- `ct_detectors` table exists (migration `20260427000200_detectors_first_class.sql`). 14 detector rows. Status enum: `shadow|trial|live|decay|retired`.
- `ct_flags.detector_id` FK in place + indexed.
- `detectorRegistry.ts` (76 lines) is **read-only** — exposes `loadActiveDetectors()` and `loadDetector()`. **No UPDATE path.** Status promotion/demotion is exclusively SQL DML today.
- Mirror to copy: `ct_specialist_scoreboard` table + `ct_specialist_outcome_stats(p_since_days)` SECURITY DEFINER RPC + nightly `ct-specialist-scoreboard-update` edge fn (cron `0 23 * * 1-5`). Pattern is clean and reusable.
- Truth source for grading: `ct_flag_grades` (1,407 rows last 30d) — `outcome`, `alpha_pct`, `price_change_pct`. Joined to `ct_flags.detector_id`.
- No `/detectors` UI page yet. `/specialists` page exists.
- Lifecycle rules **not written down anywhere** — only the ladder names in CLAUDE.md Tenet 10 ("shadow → trial → live based on rolling hit rate"). No threshold values defined.

## Schema gradability — graded flags by detector (last 30d)

| Detector | Status | Graded n |
|---|---|---|
| signature_v1 | live | 563 |
| unusual_oi_v1 | shadow | 320 |
| whale_v1 | shadow | 144 |
| smart_money_repeat_v1 | shadow | 105 |
| cluster_slow_stacker | trial | 77 |
| (null detector_id) | — | 65 |
| cluster_default | live | 42 |
| zerodte_opening_call_v1 | shadow | 40 |
| zerodte_put_voi_extreme_v1 | shadow | 39 |
| weekly_atm_voi_v1 | shadow | 12 |
| specialist_flag | live | 0 graded? |
| flow_stack_v1 | shadow | 0 (shipped 04-30) |
| scorer_v1 | shadow | 0 |
| pair_qqq_iwm_v1 | shadow | 0 (3 active, 0 graded) |
| small_cap_inverted_put_v1 | shadow | 0 |

Sample-size verdict: 8 of 14 detectors have ≥30 graded flags in 30d (sufficient for Wilson lower-bound on hit rate). Six detectors are too thin or unfired.

Config JSONB shape — **inconsistent across detectors** (each has its own keys). That's by design; the scoreboard shouldn't read config. Lifecycle thresholds need their own column or a separate `ct_detector_lifecycle_config` row (don't graft onto `config`).

## Phase B scope

**Migration `ct_detector_scoreboard`** (mirror specialist scoreboard shape):

```sql
id uuid PK, detector_id text REFERENCES ct_detectors(id), snap_date date,
flags_total int, flags_graded int, wins int, losses int, partials int,
hit_rate_7d numeric, hit_rate_30d numeric,
sample_count_7d int, sample_count_30d int,
avg_alpha_pct_30d numeric, median_peak_pct numeric,
current_status text,           -- mirror from ct_detectors at snap time
computed_at timestamptz,
UNIQUE (detector_id, snap_date)
```

Plus `idx_detector_scoreboard_snap_date`, RLS read-auth + svc-all. `SET search_path = public, extensions`.

**RPC `ct_detector_outcome_stats(p_since_days int)`** — same shape as specialist version, GROUP BY `detector_id`, source `ct_flags JOIN ct_flag_grades`. ~80 lines SQL.

**Edge fn `ct-detector-scoreboard-update`** — call RPC at 7d + 30d, upsert into table. ~120 lines TS, mirror of `ct-specialist-scoreboard-update`. Cron `0 23 * * 1-5`.

**Lifecycle automation rule sketch** (rules-as-data, not hardcoded — Tenet 25/16):

Add table `ct_detector_lifecycle_rules` (one row per status transition):

```sql
from_status, to_status, min_sample_count, min_hit_rate, max_hit_rate,
min_alpha_pct, decay_window_days, evaluator_note
```

Seed with first draft (e.g. shadow→trial at n≥50 ∧ hit_rate≥0.30; trial→live at n≥150 ∧ hit_rate≥0.35; live→decay if 14d hit_rate drops below 0.20; decay→retired if 30d sub-baseline).

**Promote/demote function** — SECURITY DEFINER fn `ct_evaluate_detector_lifecycle(p_dry_run bool)`. Reads scoreboard + rules table, returns proposed transitions. Defaults to dry-run; cron fires nightly with `p_dry_run := true` and posts proposals to Slack. James flips status via SQL until the loop earns trust, then enable auto-flip via config flag. **Human-in-the-loop first, auto later** — matches Tenet 8 caution.

**UI** — read-only `/detectors` page (new) or extend `/specialists`. Re-uses scoreboard table. Sortable by status / hit_rate / sample_count. ~200 lines TSX.

## Honest effort estimate

**1.5–2 days** (within Mon-Tue with continuing care into Wed acceptable):

- Scoreboard table + RPC + nightly fn: 0.5d (clean copy of existing pattern)
- Lifecycle rules table + evaluator + dry-run Slack post: 0.5d
- `/detectors` UI: 0.5d
- Backfill scoreboard for last 30d + tune seed thresholds against current 8 detectors with data: 0.25d
- Buffer for the 6 thin detectors needing more bake time: ongoing

## False premises caught

- **`ct_flags.detector_id` exists.** Confirmed. Indexed. ~95% coverage on recent rows; 65 NULL detector_id in 30d window (legacy/specialist_flag — handle as `IS NULL` group, not error).
- **Detector flags are graded.** Confirmed. 1,407 graded last 30d, weighted heavily on signature_v1.
- **Sample-size adequacy.** 8 of 14 detectors gradeable now; 6 are too thin for auto-promotion. Phase B must tolerate empty rows without errors.
- **specialist_flag detector graded count = 0.** Specialist-fired flags fill `specialist_ticker` but `detector_id` may be unstamped on those rows — verify before counting specialist_flag in any auto-rule.
- **Auto-flip vs human-in-loop.** Roadmap says "manual gating is fine for one trader." Phase B should ship dry-run Slack proposals, NOT auto-flip on day one. Spec the auto-flip toggle but ship it OFF.
- **Rule definition gap.** No promote/demote thresholds written down anywhere. Phase B kickoff requires James to spec at least the seed numbers (or terminal-me does an analysis-mode tuning pass against existing scoreboard data first).

## Cleared to start Phase B?

**Yes — with one prerequisite.** The substrate is clean: tables, FKs, grades, sample sizes, mirror pattern all check out.

**Block:** define seed promote/demote thresholds (rule values for the 4–6 transitions) before writing the evaluator. That's a 30-min terminal-me analysis session, not engineering work. Once those numbers exist, Phase B is a 1.5–2 day mechanical copy of the specialist scoreboard pattern with one new wrinkle (rules table + dry-run Slack). Ship lifecycle auto-flip OFF; James pulls the trigger after watching dry-run proposals for a week.

## Key files referenced

- `supabase/functions/_shared/detectorRegistry.ts`
- `supabase/migrations/20260427000200_detectors_first_class.sql`
- `supabase/migrations/20260426000060_specialist_outcome_stats.sql`
- `supabase/migrations/20260426000062_specialist_scoreboard_cron.sql`
- `supabase/functions/ct-specialist-scoreboard-update/index.ts`
- `docs/runbooks/detectors.md`
- `~/.claude/projects/-Users-jameschellis/memory/project_co_trader_roadmap_post_2026_04_25.md`
