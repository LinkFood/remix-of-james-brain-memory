# Phase A Audit — `distill-principles` Silent No-Op

**Date:** 2026-05-05
**Mode:** Read-only investigation. Zero code changes, zero migrations, zero writes.
**Scope:** JAC weekly principle-distillation cron has been writing to a non-existent table since 2026-02-28.
**Surfaced by:** `docs/audit/2026-05-05-cotrader-mcp-v2-tier1-phase-a.md` — PostgREST returned `PGRST205` for `brain_principles` with hint "Perhaps you meant the table 'public.jac_principles'".

---

## TL;DR

- `supabase/functions/distill-principles/index.ts` writes/updates/deletes from `brain_principles` at 4 call sites (lines 100, 188, 239, 252).
- `brain_principles` **does not exist** and **never has** — no migration was ever written.
- The structurally correct destination is `jac_principles` (already created in `20260301000003_jac_principles.sql`, already read by `jac-dispatcher` and `usePrinciples.ts`).
- Function and target table were created in the **same commit** (`e2a803f`, 2026-02-28). The mismatch is a day-1 naming inconsistency, not a deferred migration.
- ~9 weekly cycles silently no-op'd. `jac_reflections` is fully intact (270 rows; 234 in last 60d) — backfill is viable.
- Zero warden invariants reference principles. `ct_growth_crons` manifest is the right home for the missing invariant.

---

## Q1 — Why does the function write to `brain_principles`?

### Function intent (read end-to-end)

`supabase/functions/distill-principles/index.ts` is JAC-side, weekly Sunday 3 AM UTC. Pipeline:

1. Iterate every row in `profiles`.
2. Per user: pull last 50 `jac_reflections`, pull existing principles from `brain_principles` (the bug).
3. Hand both to Claude Sonnet with a `distill_principles` tool. Claude returns `create | update | retire` actions.
4. For `create`: embed via `generate-embedding`, INSERT into `brain_principles`.
5. For `update`: re-embed, UPDATE `brain_principles` by `existingId`.
6. For `retire`: DELETE from `brain_principles` by `existingId`.

### Comments tell the intended scope

Line 1 header comment: **"Weekly Principle Extraction for JAC Agent OS"** — JAC-side, not Co-Trader. Authored Feb 28, 2026.

### Was a `brain_principles` table ever planned?

**No.** Evidence:

- Full grep across `/supabase/migrations/`, `/supabase/functions/`, and `/src/` for `brain_principles`: zero hits outside the 4 lines in `distill-principles/index.ts`.
- The same commit (`e2a803f` "Brain Evolution: graph memory, heartbeat, principles, memory decay, validation", 2026-02-28) created BOTH:
  - `supabase/functions/distill-principles/index.ts` (writes `brain_principles`)
  - `supabase/migrations/20260301000003_jac_principles.sql` (creates `jac_principles`)
  - `src/hooks/usePrinciples.ts` (reads `jac_principles`)
- The migration `20260301000005_heartbeat_and_crons.sql` (same commit) schedules the cron without ever referencing the destination table — wiring deferred to the function body, where the typo lives.

### Verdict

This is a **table-naming inconsistency from day 1**, not a migration that never landed. The function author named the destination `brain_*` (matching `brain_insights`, `brain_entities`, `brain_reports` from the same commit's vocabulary) while the migration author named the table `jac_*` (matching `jac_reflections`). The two were never reconciled before deploy. PostgREST's hint in `PGRST205` is correct: the structurally intended table is `jac_principles`.

---

## Q2 — Which extant table is the structurally correct target?

### Schema comparison

#### `jac_principles` (migration `20260301000003_jac_principles.sql` + RLS extension `20260420000023_principles_rls.sql`)

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | gen_random_uuid |
| `user_id` | UUID NOT NULL | FK auth.users, RLS-scoped |
| `principle` | TEXT NOT NULL | the distilled statement |
| `source_reflection_ids` | UUID[] | provenance back to `jac_reflections.id` |
| `confidence` | FLOAT 0..1 | default 0.5 |
| `times_applied` | INT | default 0 |
| `embedding` | extensions.vector(512) | HNSW index (Voyage 512-dim) |
| `created_at` | TIMESTAMPTZ | default now() |
| `last_validated` | TIMESTAMPTZ | default now() |
| `category` | TEXT | added 04-20 (UI grouping) |
| `severity` | INT 1..5 | added 04-20 (UI prioritization) |
| `acknowledged` | BOOLEAN | added 04-20 (James-read flag) |
| `retired_at` | TIMESTAMPTZ | added 04-20 (soft-delete) |

Row count: **0**.

Writers today: **none.** (Distiller is the intended writer — broken since day 1.)

Readers today:
- `supabase/functions/jac-dispatcher/index.ts:398` — pulls top 5 by confidence per `user_id` into the system prompt.
- `src/hooks/usePrinciples.ts` — `usePrinciples`, `usePrinciplesFull`, `useAcknowledgePrinciple`, `useRetirePrinciple` all bind to this table.
- Routes referencing it: `/brain` (BrainInspector), `PrincipleTickerWidget`, `Principles` page.

**Field-by-field compatibility with what the distiller writes:**

| Distiller writes | `jac_principles` column | Match? |
|---|---|---|
| `user_id` | `user_id` | exact |
| `principle` | `principle` | exact |
| `confidence` | `confidence` | exact |
| `last_validated` | `last_validated` | exact |
| `embedding` (JSON.stringify of 512-dim) | `embedding` (vector(512)) | exact |

Distiller does NOT write `source_reflection_ids`, `category`, `severity`, `acknowledged`, `times_applied`. All have defaults / nullable. **Drop-in compatible.**

#### `ct_principles` (migration `20260422000006_ct_phase1_foundation.sql`)

| Column | Type |
|---|---|
| `id` UUID PK | |
| `trader` TEXT NOT NULL | check `'claude' | 'james'` |
| `principle` TEXT NOT NULL | |
| `derivation` TEXT | |
| `strength` NUMERIC 0..1 | (NOT `confidence`) |
| `status` TEXT | check `'active' | 'deprecated' | 'under_review'` |
| `domain` TEXT | |
| `support_count` INT | |
| `refute_count` INT | |
| `last_tested_at` TIMESTAMPTZ | |
| `created_at`, `updated_at` | |

Row count: **0**.

Writers today: **none** (intended for Co-Trader weekly review; the `ct-weekly-review` companion never landed).

Readers today: documented in `docs/CO_TRADER_V2_SCOPE.md`; no live consumers grep'd.

**Compatibility with distiller:** poor. No `user_id` (Co-Trader is single-trader; distiller is per-user). No `confidence` (uses `strength`). No `embedding`. No `last_validated`. Co-Trader-domain semantics (`trader`, `domain`, `support_count`).

#### `ct_specialist_principles` (migration `20260423000026_v2_specialist_schema.sql`)

| Column | Type |
|---|---|
| `id` UUID PK | |
| `specialist_ticker` TEXT NOT NULL | (per-ticker, not per-user) |
| `principle` TEXT NOT NULL | |
| `evidence_flags` UUID[] | (FK ct_flags) |
| `confidence` NUMERIC | |
| `created_at`, `updated_at` | |
| UNIQUE (specialist_ticker, principle) | |

Row count: **0**.

Writers today: **none** (intended for V2 specialist post-flag-grade reflection; never wired).

Readers today: none grep'd.

**Compatibility with distiller:** wrong layer. Per-ticker, not per-user. No `embedding`. The unique constraint would reject the distiller's create-then-update flow. Wrong table.

### Recommendation

**`jac_principles` is the structurally correct destination.** Drop-in: every column the distiller writes already exists. Already wired into the readers (`jac-dispatcher`, `usePrinciples`, BrainInspector, Principles page, PrincipleTickerWidget). The original migration even comments: *"Weekly cron extracts patterns into reusable operating principles."* The table was built for this writer.

`ct_principles` and `ct_specialist_principles` are Co-Trader-domain principle stores with different shape and different intended writers. Out of scope for the JAC weekly distiller.

> **No `brain_principles` migration was ever written.** Don't create one — the structurally correct table already exists with the correct shape, correct readers, and four months of frontend code aligned to it. Redirect the writer.

---

## Q3 — Quantify the loss

### Cron schedule

`supabase/migrations/20260301000005_heartbeat_and_crons.sql` line 27:

```sql
SELECT cron.schedule(
  'distill-principles',
  '0 3 * * 0',   -- Sunday 03:00 UTC, weekly
  ...
);
```

### Function deploy lineage

```
e2a803f  2026-02-28  Brain Evolution: graph memory, heartbeat, principles, memory decay, validation
4cbdb20  2026-02-28  Fix migrations: use extensions.vector schema, match existing function signature
```

Only two commits ever touched the function or its supporting migrations. Function has been deployed continuously since 2026-02-28.

### Sundays elapsed since 2026-02-28

| Sunday | Status |
|---|---|
| 2026-03-01 | first eligible fire |
| 2026-03-08 | fire |
| 2026-03-15 | fire |
| 2026-03-22 | fire |
| 2026-03-29 | fire |
| 2026-04-05 | fire |
| 2026-04-12 | fire |
| 2026-04-19 | fire |
| 2026-04-26 | fire |
| 2026-05-03 | fire (most recent — 2 days ago) |

**~10 weekly distillation cycles × 0 rows landed = 10 lost cycles.**

Loss caveat: each fire iterates every user in `profiles`. JAC is single-user (James), so loss is "10 weekly Sonnet calls + ~50 reflection contexts + N embeddings, all silently dropped on PostgREST's `PGRST205` response." The function's `for (const item of distilled)` loop catches `insertError` → `console.warn` → continues, so cron logs success. Classic silent-failure shape (same class as `feedback_silent_failure_detection_pattern.md`).

**Spend impact:** ~10 × Sonnet calls (≤2048 max_tokens, temp 0.3) on roughly 50-reflection contexts. Conservatively $0.50–$1.50 of API spend produced no persisted output, plus ~10–50 wasted Voyage embeddings.

**Intelligence impact:** more interesting. `jac_reflections` accumulated 270 rows (234 in last 60d, 13 of which are `co_trader_reflection` from the `ct-reflect-to-jac` bridge). All 270 are intact and embedded. **The pattern-extraction window the dispatcher reads from has been empty since day 1** — every JAC dispatch has shipped without operating-principle context, despite the architecture intending it.

---

## Q4 — Warden gap

### Search for existing invariants

Query (live):

```
GET /rest/v1/ct_invariants?or=(name.ilike.*principle*,name.ilike.*distill*,description.ilike.*principle*)
→ []
```

29 active invariants. **Zero reference principle distillation, principle row-count growth, or weekly-cadence cron freshness on the principles surface.** Nothing would have caught this.

### Why the existing silent-failure invariant didn't catch it

`cron_zero_row_upsert_silent_failure_class` (migration `20260502040000_warden_silent_failure_class.sql`) is exactly the right shape — *iterate `ct_growth_crons` manifest, alert when target table doesn't grow on cadence.* But:

- Its seed inventory only contains Co-Trader crons (`ct-detector-scoreboard-update-rth`, `ct-flow-pulse-capture`, `ct-flow-ingester-perticker-rth`, `ct-system-warden`, `ct-specialist-scoreboard-update`).
- `distill-principles` (JAC-side, weekly cadence) was never registered in `ct_growth_crons`.
- The manifest is a Tenet 25 design — adding to it is a `INSERT` row, no code change.

### Proposed invariant shape (Phase B)

Two complementary options:

**Option A — Add to existing manifest (lowest-friction, leverages existing infra):**

```sql
INSERT INTO public.ct_growth_crons
  (cron_jobname, target_table, freshness_column, scope, expected_window_minutes, description)
VALUES
  ('distill-principles', 'public.jac_principles', 'created_at', 'weekly', 10080,
    'JAC weekly principle distillation — Sunday 3 AM UTC. Silently no-op''d 2026-02-28 → 2026-05-05 writing to nonexistent brain_principles. See docs/audit/2026-05-05-distill-principles-silent-noop-phase-a.md.');
```

`expected_window_minutes = 10080` = 7 days. `cron_zero_row_upsert_silent_failure_class` then surfaces it automatically. Zero new SQL machinery.

**Caveat:** weekly cadence may be too long for the existing aggregator's 30-min Warden cadence — works, but 7-day windows mean the warden only flips fail roughly one Sunday after a missed run. Acceptable tradeoff for a weekly cron; instant detection is overkill.

**Option B — Standalone invariant (`jac_principles_growth_weekly`):**

```sql
INSERT INTO public.ct_invariants (name, category, description, query_sql, expected_min, expected_max, severity, runbook_path)
VALUES (
  'jac_principles_growth_weekly',
  'silent_failure',
  'JAC distill-principles must add ≥1 jac_principles row in the last 14 days. Catches the 2026-02-28 → 2026-05-05 silent no-op class (writer pointed at brain_principles which never existed).',
  $sql$
    SELECT
      COUNT(*)::numeric AS metric_value,
      CASE WHEN COUNT(*) = 0
           THEN 'jac_principles has zero rows added in last 14 days — distill-principles cron may be silently no-op''ing'
           ELSE COUNT(*)::text || ' principles added in last 14d (healthy)'
      END AS message
    FROM public.jac_principles
    WHERE created_at >= now() - interval '14 days';
  $sql$,
  1,    -- expected_min
  NULL, -- expected_max
  'warn',
  'docs/audit/2026-05-05-distill-principles-silent-noop-phase-a.md'
);
```

Mirrors the pattern from `feedback_warden_count_distinct_misses_single_entity_failure.md` — row-count threshold over a freshness window. 14d window covers two cron fires (gives one missed-fire grace).

### Recommendation

**Ship Option A.** `ct_growth_crons` manifest is the structural home for any cron whose health is "rows must appear in target table on cadence." Adding `distill-principles` to it is a 1-row INSERT and inherits all the existing aggregation, alarm-state debouncing, and runbook plumbing.

Reserve Option B as a fallback if the 7-day window proves too coarse against the Warden's 30-min cadence in practice (it almost certainly won't).

---

## Phase B Proposal (no shipping)

Three discrete migrations + one optional backfill:

### B1 — Redirect writer
Edit `supabase/functions/distill-principles/index.ts`, replace 4 occurrences of `'brain_principles'` with `'jac_principles'` (lines 100, 188, 239, 252). Redeploy.
- **Class kill check (Tenet 15):** Does this make the class ("writer aimed at non-existent table") impossible? **No** — only kills this instance. Tenet-15-compliant fix is a CI grep against `from('<table>')` cross-checked against migrations. Out of scope; flag as separate punchlist item.
- **Verification:** invoke function once with service role + force one user, confirm a row lands in `jac_principles`. Confirm `usePrinciples` hook on `/brain` page renders it. Confirm `jac-dispatcher` next dispatch surfaces it under "JAC'S OPERATING PRINCIPLES" in the system prompt.

### B2 — Register in growth-cron manifest
INSERT one row into `ct_growth_crons` per Option A above. Warden picks it up next 30-min run.
- **Verification:** `SELECT * FROM check_growth_cron_silent_failures()` post-INSERT shows either green (post-B1) or a clean failure message naming `distill-principles`.

### B3 — Optional backfill from `jac_reflections`
234 reflections in last 60d are intact and embedded. Two backfill shapes:

- **Shape A (single retroactive run):** invoke `distill-principles` once manually after B1 lands. Sonnet processes the latest 50 reflections, lands ~1–5 principles. Cheapest. Loses the longitudinal arc — only the most recent 50 reflections inform the distillation.
- **Shape B (window replay):** scripted: chunk `jac_reflections` into 5–10 weekly windows, invoke a one-shot variant of the distiller per window, accumulate principles. Captures the longitudinal pattern. More API spend (~5–10 × Sonnet calls). Requires a one-shot script — terminal-Claude / analysis-mode work per Tenet 26, NOT a new edge function.

**Recommended:** Shape A only. The reflection embeddings are already first-class in the brain — re-distilling history into principles is a research artifact, not load-bearing infrastructure. If B1 + B2 land and the next Sunday cycle (2026-05-10) writes successfully, the system is whole. Shape B is a "nice to have" terminal-mode exercise.

### B4 — Tenet-25 follow-up (deferrable)
Add a CI lint that grep's `from\(['"]\w+['"]\)` across `/supabase/functions/` and cross-checks against `information_schema.tables`. Catches the writer-points-at-nonexistent-table class structurally. Punchlist item, not Phase B blocker.

---

## Trade-offs needing James's call

1. **Redirect (`jac_principles`) vs. create (`brain_principles`).**
   Recommendation: redirect. Reasoning: `jac_principles` already exists with the right shape, the right RLS, the right indexes, and **two readers (`jac-dispatcher`, `usePrinciples`) and four UI surfaces are already wired to it**. Creating `brain_principles` would orphan the existing table and require migrating both writers and all four readers. The distiller's `from('brain_principles')` was a typo, not a design.

2. **Warden invariant: Option A (manifest INSERT) vs. Option B (standalone invariant).**
   Recommendation: Option A. Lower surface area, leverages the existing aggregator + alarm-state machine + runbook indirection. Option B is fallback if 7-day cadence proves too coarse.

3. **Backfill shape: A (one re-run) vs. B (windowed replay) vs. none.**
   Recommendation: A. Shape B is research-artifact analysis-mode work and shouldn't pre-empt B1/B2. James can call Shape B as a terminal-me task post-B2 if he wants the longitudinal arc.

4. **Spend recovery framing.** Roughly $1–$2 in Sonnet+Voyage spend was burned over 10 weeks. Not refundable — flag as accepted loss. The bigger cost was **opportunity**: 10 weeks of dispatch-prompt context with empty principles section.

---

## Backfill viability

**Yes.** Live counts (queried 2026-05-05 21:35 UTC):

| Source | Rows | Notes |
|---|---|---|
| `jac_reflections` (total) | 270 | earliest 2026-03-01 04:05 UTC — 1 day before first Sunday eligible fire |
| `jac_reflections` (last 60d) | 234 | covers the entire silent-no-op window |
| `jac_reflections` task_type='co_trader_reflection' | 13 | from `ct-reflect-to-jac` bridge (Tenet 23) — Co-Trader→JAC learning loop |
| `jac_principles` | 0 | the missing output |
| `brain_principles` | n/a | does not exist |

All 270 reflections are embedded (Voyage 512-dim) and present in the brain. The pattern substrate the distiller needs is fully intact. A single post-B1 manual fire of `distill-principles` will draw from the most recent 50 reflections and write the first principles row in JAC's history.

---

## Structural concerns to pause Phase B

**None blocking.** Two soft notes:

1. **`jac-dispatcher` reads top 5 principles per `user_id` ordered by `confidence DESC`** (line 401). Once B1 writes the first batch, the next dispatch will surface them in the system prompt. No regression risk — the `if (principles && principles.length > 0)` guard means current behavior (no principles section emitted) is preserved if the table is empty.

2. **`usePrinciples.ts` docstring (line 7) says "Watcher / morning-brief READ this table on every tick (see `_shared/memoryRecall.ts`)."** Grep'd `_shared/memoryRecall.ts` — no `jac_principles` reference. Docstring is aspirational / out of date. Not a blocker for B1, but worth flagging as a separate doc-drift item: either wire memoryRecall into jac_principles or fix the comment. Out of Phase B scope.

---

## File references (absolute paths)

- `/Users/jameschellis/jac-agent-os/supabase/functions/distill-principles/index.ts` (the broken writer)
- `/Users/jameschellis/jac-agent-os/supabase/migrations/20260301000003_jac_principles.sql` (intended target)
- `/Users/jameschellis/jac-agent-os/supabase/migrations/20260420000023_principles_rls.sql` (UI columns added)
- `/Users/jameschellis/jac-agent-os/supabase/migrations/20260301000005_heartbeat_and_crons.sql` (cron schedule, line 27)
- `/Users/jameschellis/jac-agent-os/supabase/migrations/20260422000006_ct_phase1_foundation.sql` (ct_principles)
- `/Users/jameschellis/jac-agent-os/supabase/migrations/20260423000026_v2_specialist_schema.sql` (ct_specialist_principles)
- `/Users/jameschellis/jac-agent-os/supabase/migrations/20260502040000_warden_silent_failure_class.sql` (ct_growth_crons manifest pattern)
- `/Users/jameschellis/jac-agent-os/supabase/functions/jac-dispatcher/index.ts` (line 398, the reader)
- `/Users/jameschellis/jac-agent-os/src/hooks/usePrinciples.ts` (frontend reader)
- `/Users/jameschellis/jac-agent-os/docs/audit/2026-05-05-cotrader-mcp-v2-tier1-phase-a.md` (parent audit that surfaced this)
