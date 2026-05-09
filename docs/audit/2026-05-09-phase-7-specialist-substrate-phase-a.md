# Phase 7 — Specialist substrate Phase A scoping

**Status:** read-only Phase A audit. **Do not ship code from this doc.** Implementation gated until D2.2 acceptance verdict on 2026-05-13. This document pre-bakes the ship plan so the unblock is a same-day ship, not a same-day scope.

**Companion phases:** Phases 1–6 (PRs #86 / #87 / #88 / #89 / #90 / #91) shipped the audit-driven 1→6 loop. Phase 7 closes the only remaining substrate gap from the JAC OS / Co-Trader fusion ground-truth audit (2026-05-09): per-wakeup specialist commentary is unembedded.

---

## 1. The gap

`ct_specialist_reads` (migration `20260424000036_specialist_reads.sql`) holds one row per specialist wakeup — `direction_lean`, `conviction` (0–100), `read_text`, `flagged`, `flag_id`, `source_flow_ids`. ~315+ rows over 7 days × 10 tickers, ~6-min RTH cadence.

**No embedding column today.** The table is the live track-record substrate the recall organ reads, and yet captain never sees "this read most resembles X prior reads on this ticker" — only chronological recall.

`specialistRecallContext.ts:259` is explicit about it:

```
'_shared/specialistRecallContext.ts / ct_specialist_reads + ct_flags + ct_flag_grades +
 ct_specialist_scoreboard_v2 (chronological recall — semantic not yet shipped; cotrader
 audience only)'
```

That's the ship target.

---

## 2. Sibling table — DO NOT touch

`ct_specialist_memory` (v2 schema migration `20260423000026_v2_specialist_schema.sql`) **already has** `embedding extensions.vector(512)` + HNSW. It is dead-on-arrival per `specialistRecallContext.ts:43`:

> *ct_specialist_memory is dead-on-arrival (2 rows, writer path is dead v1 code that gates on `flag.source === 'specialist'` which v2 never produces).*

Phase 7 does **not** revive that table. The substrate target is `ct_specialist_reads`, the live one.

---

## 3. Pattern to mirror — Phase 1 (PR #86, `ct_tape_commentary`)

Phase 1 is the proven substrate template. Phase 2 (PR #87, `ct_breaking_news`) is the cron-only variant. Phase 7 mirrors Phase 1 (write-time embed) because the producer is a single function (`specialistRunner.writeSpecialistRead`) we already maintain — there is no two-producer asymmetry that justified Phase 2's cron-only pivot.

Files Phase 7 will add (when unblocked):

| Layer | File | Notes |
|---|---|---|
| Migration A | `supabase/migrations/<TS>_ct_specialist_reads_embedding.sql` | ADD COLUMN embedding + rich_text + HNSW + match RPC + warden invariant |
| Migration B | `supabase/migrations/<TS>_ct_embed_specialist_reads_cron.sql` | every 5 min RTH (UTC `*/5 13-21 * * 1-5`) — backstops the write-time path |
| New edge fn | `supabase/functions/ct-embed-specialist-reads/index.ts` | backlog drainer, batch 1–100, internally chunks ≤20 per Voyage gotcha |
| Edit | `supabase/functions/_shared/specialistRunner.ts` | `writeSpecialistRead` returns the new row id; after-insert fire-and-forget voyageEmbed + UPDATE |
| Config | `supabase/config.toml` | register `ct-embed-specialist-reads` with `verify_jwt = false` |

5 files. Same shape as Phase 1's 7 files (Phase 1 also added a runbook + an iteration log entry).

---

## 4. Migration A — concrete shape

```sql
SET search_path = public, extensions;

ALTER TABLE public.ct_specialist_reads
  ADD COLUMN IF NOT EXISTS embedding extensions.vector(512),
  ADD COLUMN IF NOT EXISTS rich_text text;

COMMENT ON COLUMN public.ct_specialist_reads.embedding IS
  'Voyage 3-lite 512-dim embedding of rich_text. Semantic-recall substrate for the per-ticker specialist Learning Arc on /alpha (Phase 7c) and the optional semantic swap of UNFLAGGED recall in specialistRecallContext (Phase 7b).';
COMMENT ON COLUMN public.ct_specialist_reads.rich_text IS
  'What got embedded. Cluster axis: ticker + lean + conviction band + flagged + session date. Setup-shape clusters, not just prose.';

CREATE INDEX IF NOT EXISTS ct_specialist_reads_embedding_hnsw
  ON public.ct_specialist_reads
  USING hnsw (embedding extensions.vector_cosine_ops)
  WHERE embedding IS NOT NULL;

CREATE OR REPLACE FUNCTION public.match_ct_specialist_reads_by_similarity(
  query_embedding   extensions.vector(512),
  match_threshold   numeric DEFAULT 0.5,
  match_count       int     DEFAULT 5,
  exclude_after_ts  timestamptz DEFAULT NULL,    -- skip current run's own row
  ticker_filter     text    DEFAULT NULL,        -- per-specialist narrow; NULL = any
  min_conviction    int     DEFAULT NULL,        -- NULL = any conviction; int = conv >= N
  flagged_filter    boolean DEFAULT NULL         -- NULL=any, true=flagged-only, false=unflagged-only
)
RETURNS TABLE (
  id             bigint,
  ticker         text,
  updated_at     timestamptz,
  direction_lean text,
  conviction     int,
  flagged        boolean,
  flag_id        uuid,
  read_text      text,
  rich_text      text,
  similarity     numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
  SELECT id, ticker, updated_at, direction_lean, conviction, flagged, flag_id,
         read_text, rich_text, similarity
  FROM (
    SELECT
      r.id, r.ticker, r.updated_at, r.direction_lean, r.conviction, r.flagged,
      r.flag_id, r.read_text, r.rich_text,
      1 - (r.embedding <=> query_embedding) AS similarity
    FROM public.ct_specialist_reads r
    WHERE r.embedding IS NOT NULL
      AND (exclude_after_ts IS NULL OR r.updated_at < exclude_after_ts)
      AND (ticker_filter   IS NULL OR r.ticker = ticker_filter)
      AND (min_conviction  IS NULL OR r.conviction >= min_conviction)
      AND (flagged_filter  IS NULL OR r.flagged = flagged_filter)
    ORDER BY r.embedding <=> query_embedding
    LIMIT GREATEST(match_count * 3, 12)
  ) ranked
  WHERE similarity >= match_threshold
  ORDER BY similarity DESC
  LIMIT match_count;
$fn$;

GRANT EXECUTE ON FUNCTION public.match_ct_specialist_reads_by_similarity(
  extensions.vector(512), numeric, int, timestamptz, text, int, boolean
) TO authenticated, service_role;

INSERT INTO public.ct_invariants (
  name, category, description, query_sql,
  expected_min, expected_max, severity, runbook_path
) VALUES (
  'specialist_reads_embedding_backlog_1h',
  'embedding_gate',
  'Count of ct_specialist_reads rows in the last 1 hour during RTH with NULL embedding. Catches write-time embedding gate failures (Voyage outage, code regression). Expected 0 - 10 (10 tickers x ~6/hr cadence; allows in-flight + transient retry; drainer cron is the backstop).',
  'SELECT count(*)::numeric AS metric_value, ''rows ''||count(*)||'' un-embedded in last 1h'' AS message FROM public.ct_specialist_reads WHERE updated_at >= now() - interval ''1 hour'' AND embedding IS NULL',
  0,
  10,
  'warn',
  'docs/runbooks/embedding_gate.md'
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  query_sql = EXCLUDED.query_sql,
  expected_min = EXCLUDED.expected_min,
  expected_max = EXCLUDED.expected_max,
  severity = EXCLUDED.severity,
  runbook_path = EXCLUDED.runbook_path,
  updated_at = now();
```

**Why expected_max 10 (not 2 like Phase 1):** ten tickers × ~6/hr cadence ≈ 60 rows/hr. Phase 1 (`ct_tape_commentary`) is one writer; this is ten. Allow ~16% transient drift before warden alerts.

---

## 5. rich_text shape

```
SPECIALIST_READ | ticker:NVDA lean:bullish conv:65 flagged:false flag:- | session:2026-05-13
<read_text>
```

When `flagged=true` and `flag_id` resolves to a `ct_flags.option_symbol`, render `flag:NVDA250515P250` instead of `flag:-`.

Cluster axis = ticker + lean + conviction band + flagged + session date. Similar setups (NVDA bullish high-conviction unflagged on RTH) cluster regardless of prose differences.

---

## 6. Producer change — `specialistRunner.writeSpecialistRead` (lines 535–561)

Today (line 546):
```ts
const { error } = await supabase.from('ct_specialist_reads').insert({...});
```

Change to (concept; pseudo-code):
```ts
const { data, error } = await supabase
  .from('ct_specialist_reads')
  .insert({...})
  .select('id, updated_at')
  .single();
if (error || !data) { console.warn(...); return; }

// fire-and-forget — never block specialist wakeup response
(async () => {
  try {
    const richText = buildSpecialistRichText({ ticker, args.read, args.flagged, args.flagId, sessionDate });
    const embedding = await voyageEmbed(richText, 'document');
    await supabase.from('ct_specialist_reads')
      .update({ embedding: embedding as unknown as string, rich_text: richText })
      .eq('id', data.id);
  } catch (e) {
    console.warn('[specialistRunner] embed failed (non-blocking):', String(e));
  }
})();
```

`buildSpecialistRichText` is a 10-line helper. The cron drainer (Migration B) catches failures.

**Tenet 26 fit:** producer is autonomous-mode (specialist cron) — embed call belongs in the same mode. Drainer is autonomous-mode. No UI-mode or analysis-mode work in Phase 7a.

---

## 7. Cron drainer — `ct-embed-specialist-reads`

Mirrors `ct-embed-tape-commentary` (`supabase/functions/ct-embed-tape-commentary/index.ts`, 137 LOC). Selects `embedding IS NULL`, batch 1–100, voyageEmbeds (chunked ≤20 per gotcha), UPDATEs.

Cron schedule: every 5 min RTH (`*/5 13-21 * * 1-5` UTC). Specialists are RTH-only producers. Off-hours scheduling buys nothing.

```sql
DO $$
BEGIN
  PERFORM cron.unschedule('ct-embed-specialist-reads-rth')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-embed-specialist-reads-rth');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'ct-embed-specialist-reads-rth',
  '*/5 13-21 * * 1-5',
  $cron$ SELECT public.invoke_edge_function('ct-embed-specialist-reads', '{"batch_size": 50}'::jsonb); $cron$
);
```

Idempotency per `feedback_pg_cron_schedule_idempotency.md`. apikey-header pattern in `invoke_edge_function` already handled by `20260507170000_apikey_in_invoke_edge_function.sql`.

---

## 8. Phase 7b (DEFERRED) — semantic swap in `specialistRecallContext`

`specialistRecallContext.ts` currently builds the UNFLAGGED set as:

> *the last 5 unflagged reads with conviction ≥ 50, within the last 5 days* (`UNFLAGGED_CAP=5`, `UNFLAGGED_LOOKBACK_DAYS=5`, `UNFLAGGED_CONVICTION_FLOOR=50`).

A semantic swap would replace that with: *5 most-similar prior unflagged reads to the current read*, scoped to ticker, threshold ≥0.5.

**Risk:** changes the prompt context the specialist sees on the next wakeup → directly changes specialist behavior. **D2.2 acceptance is measuring exactly this surface.** Shipping Phase 7b during the window contaminates the verdict.

**Gate:** ship Phase 7b ONLY after the D2.2 verdict is in (2026-05-13). Even then, ship it with explicit captain go because it's not a substrate ship — it changes the specialist's behavior.

Implementation when unblocked: replace the unflagged query in `specialistRecallContext.ts:336` with a call to `match_ct_specialist_reads_by_similarity` using the *current* read's freshly-computed embedding (or recompute richText → voyageEmbed → match). FLAGGED set stays chronological — the *graded outcomes* trail must remain temporally coherent for tenant trust.

---

## 9. Phase 7c (DEFERRED) — Specialist Learning Arc on /alpha

Surface analog to `TapeReaderArc` (PR #88). Per ticker, horizontal segment strip of the day's wakeups colored by `direction_lean` (bullish=emerald, bearish=red, neutral=blue, mixed=violet), height scaled by `conviction`, `flagged` segments amber-ringed. Click any segment → expand to full `read_text` + 5 most-similar prior reads via `match_ct_specialist_reads_by_similarity` (`ticker_filter=<row.ticker>`).

Substrate dependency: requires Migration A live + ≥1 day of write-time-embedded reads.

Layout slot on /alpha: long-horizon row (per `2026-05-09-jac-os-fusion-ground-truth.md` Section E.5). Sibling to `RegimeFlipJournal` (PR #91).

5x bar measured against `/specialists` and `TickerSheet → SPECIALIST — LATEST TAKE`: those surfaces show the **current** specialist read, not the day's *arc* of reads. Glance-density 5x.

Ship after Phase 7a + at least one full RTH session of clean drainer state.

---

## 10. Migration timestamp slot

Latest migration on main as of 2026-05-09 is `20260510090000`. By 2026-05-13 the next available slot is anything `20260513XXXXXX+`. Coordinate with session-A's prior migration ships to avoid collision per the morning's `docs-PR-merge-doesnt-imply-migration-applied` cascade.

Suggested slots when shipping:
- Migration A: `2026051310000_ct_specialist_reads_embedding.sql`
- Migration B: `20260513100100_ct_embed_specialist_reads_cron.sql`

Verify via `git ls-tree origin/main -r --name-only | grep migrations` immediately before staging.

---

## 11. Test plan

Pre-ship:
- [ ] Phase A re-verify on 5/13 morning: `ct_specialist_reads` schema unchanged since this audit; no new sibling embedding column was added in the interim.
- [ ] D2.2 verdict on 5/13 reviewed before any code edit. If verdict requires threshold rework, re-scope.

Ship-day verification:
- [ ] Migration A applies clean (`npx supabase db push`).
- [ ] Self-match query: pick any embedded row, query `match_ct_specialist_reads_by_similarity` with its own embedding — top result is itself at similarity 1.000.
- [ ] `ticker_filter` narrows correctly: `ticker_filter='NVDA'` returns only NVDA rows.
- [ ] `min_conviction=70` returns only rows with `conviction >= 70`.
- [ ] `flagged_filter=true` returns only `flagged=true` rows.
- [ ] Warden invariant `specialist_reads_embedding_backlog_1h` registered. Dormant until first 30-min warden tick.
- [ ] Producer change deployed: redeploy `ct-specialist-dispatcher` + every per-ticker `ct-specialist-<ticker>` function (10 tickers) — OR, if `_shared/specialistRunner.ts` is bundled at build time per the existing pattern, redeploy ALL specialist edge functions importing it. **Verify via the pattern: `grep -l specialistRunner supabase/functions/ct-specialist-*`.**
- [ ] Cron drainer registered: `SELECT * FROM cron.job WHERE jobname = 'ct-embed-specialist-reads-rth'`.

First-RTH-after-ship verification:
- [ ] At first specialist wakeup post-deploy, query the new row: `embedding` column populated within 30s. If not, write-time path is broken — drainer is backstop.
- [ ] After 1 RTH hour: `count(*) WHERE embedding IS NULL AND updated_at > now() - interval '1 hour'` ≤ 10. (Drainer running every 5 min keeps backlog bounded.)
- [ ] After full RTH session: backlog should drift to 0 (or ≤ in-flight).
- [ ] Warden invariant turns green by next 30-min tick.
- [ ] Drainer drains the full pre-ship backlog (~315+ historical rows) over ~30 min.

---

## 12. Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Voyage outage during RTH | Low | Write-time path is fire-and-forget (specialist wakeup never blocks); drainer backstops within 5 min |
| Voyage rate-limit at 10-ticker simultaneous wakeups | Medium | 10 wakeups/6 min ≈ 1.67/min, well under Voyage limit; chunked-≤20 batching in drainer |
| Specialist behavior change | None in 7a | 7a is purely additive (column add + write-time UPDATE); no recall change. 7b explicitly gated post-D2.2. |
| Migration timestamp collision with session-A's parallel ship | Low | Verify immediately before staging per `docs-PR-merge-doesnt-imply-migration-applied` |
| ct_specialist_memory confusion | Low | This doc is explicit about NOT touching that table |
| Cost — ~$0.15/day Voyage | Negligible | <1% of current Voyage spend |

---

## 13. Tenet check

- **Tenet 13 (hallucination prevention):** semantic recall over the specialist's own track-record reduces "I just made up a conviction" risk by giving the specialist its own historical voice as primary context.
- **Tenet 24 (no silos):** specialist reads become readable to /alpha (Specialist Learning Arc), specialistRecallContext (semantic swap 7b), and any future organ. One organism.
- **Tenet 25 (evolves in structure):** semantic recall is structural — it changes WHICH past reads the specialist sees on its next wakeup, not the threshold values. Day-180 specialist behavior diverges from day-30 specifically because the recall window is now setup-shape-aware, not chronological.
- **Tenet 26 (three-mode):** Phase 7a is autonomous-mode end-to-end. Phase 7b stays autonomous. Phase 7c is UI-mode. Zero analysis-mode work — no service shim, no ad-hoc terminal-only edge function.
- **Tenet 13 + Tenet 24 substrate ship:** writing to one column ≠ shipping a feature. The captain doesn't see anything different until 7b or 7c lands.

---

## 14. Cascade catalog instances surfaced by this Phase A

- **#43 — substrate-on-table-vs-sibling-table-discrimination.** ct_specialist_memory has the embedding column but is the dead writer; ct_specialist_reads is the live writer but has no embedding column. Future "embed the specialist trail" briefs that don't distinguish the two will write the embed in the wrong place. Codified in this doc Section 2.
- **#44 — measurement-window-respect on substrate ship.** Substrate (column add + write-time embed) reads as innocent additive change but the write-time path lives inside specialistRunner — the SAME function whose other knobs are being measured. Ship anyway? Yes, because the column adds zero behavior to the recall organ which IS what D2.2 measures. But the audit must articulate "additive substrate is window-safe; consumer change (7b) is not." Codified in this doc Section 8.

---

## 15. Ship sequence (when 5/13 verdict is in)

1. **Phase 7a, single PR:** Migration A + Migration B + new edge function + producer change + config.toml entry. ~5 files, est. 30–45 min from "go" to ship-ready.
2. **Verify across one RTH session.** Drainer drains backlog. Warden green.
3. **Decision point:** Phase 7b (semantic swap in specialistRecallContext) — captain go/no-go based on captain's read of D2.2 verdict.
4. **Phase 7c (Specialist Learning Arc on /alpha)** — separate PR, surface ship. Sibling to TapeReaderArc + RegimeFlipJournal. Ships when 7a substrate has ≥1 RTH session embedded.

---

## 16. References

- `docs/audit/2026-05-09-jac-os-fusion-ground-truth.md` — fusion ground-truth audit
- `docs/audit/tape-v2-iteration-log.md` — Phase 1–6 iteration log
- `supabase/migrations/20260510050000_ct_tape_commentary_embedding.sql` — Phase 1 substrate template
- `supabase/migrations/20260424000036_specialist_reads.sql` — current ct_specialist_reads schema
- `supabase/functions/_shared/specialistRecallContext.ts` — chronological recall organ (consumer)
- `supabase/functions/_shared/specialistRunner.ts:535-561` — writeSpecialistRead (producer)
- `feedback_pg_cron_schedule_idempotency.md` — idempotency pattern for the cron migration
- `feedback_supabase_gateway_rewrites_authorization.md` — apikey-header rule already handled by invoke_edge_function

---

## 17. Open questions for captain (not blockers)

1. Should the warden `expected_max=10` band be tighter? Empirical: at ~1.67 wakeups/min, a 5-min drainer cycle leaves ≤9 in-flight at any moment. 10 is a safe ceiling; 5 is calibrate-down territory if the system is reliably sub-5.
2. Phase 7b — ship the semantic swap immediately after 7a verifies, or hold for explicit captain go? Recommend explicit go — D2.2 verdict will reset the captain's mental model of specialist reliability, and forcing a captain-touch on 7b stays disciplined.
3. Specialist Learning Arc layout — long-horizon row (sibling to RegimeFlipJournal) per Section E.5, or near-term row sibling to TapeReaderArc? Substrate-driven view (the day's wakeups for one ticker) reads as near-term; cross-ticker grid (10 strips, one per ticker) reads as long-horizon.

---

**Document end. Implementation gated until 2026-05-13 D2.2 verdict.**
