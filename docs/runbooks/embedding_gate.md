# Embedding Gate Runbook

## What this protects

The JAC OS embedding gate — every load-bearing narrative table embeds at
write-time so semantic recall over historical content is possible. Per the
2026-05-09 fusion ground-truth audit (Section B), the gate currently covers:

- `ct_tape_commentary` (Phase 1 ship)
- `ct_news_causality` (Phase 2 ship — TBD)
- `ct_specialist_reads` (Phase 7 ship — queued post 2026-05-13)

Each protected table has a write-time embedder (in its producer edge function)
+ a backlog cron for missed writes + a warden invariant to catch silent
gate failures.

## Invariants in this family

- `tape_commentary_embedding_backlog_1h` — count of rows in last 1h with NULL
  embedding. Expected 0–2 (allows in-flight + transient retry).

## Diagnosis sequence when one fires

1. **Is Voyage AI down?**
   - `curl -s -o /dev/null -w "%{http_code}\n" -X POST https://api.voyageai.com/v1/embeddings -H "Authorization: Bearer $VOYAGE_API_KEY" -H "Content-Type: application/json" -d '{"input":["test"],"model":"voyage-3-lite","input_type":"document"}'`
   - 200 = Voyage healthy; problem is in our code path.
   - 5xx / timeout = wait it out; backlog cron will drain when Voyage recovers.

2. **Is the producer's write-time embed code path firing?**
   - Read recent logs for the producer (e.g., `ct-tape-reader`) via
     Supabase logs UI — look for `voyageEmbed failed` or `embed update failed`
     warnings.
   - If silent (no log lines), the wiring regressed — inspect the producer
     for the post-insert embed block.

3. **Is the backlog cron alive?**
   - For tape commentary: `ct-embed-tape-commentary` cron runs every 30 min
     RTH. Verify via `cron.job` or recent rows in `ct_invariant_log`.

4. **Did Vault key rotate?**
   - `VOYAGE_API_KEY` in Supabase secrets must be present + valid.

## Manual backfill

If the cron is alive but slow, manually invoke the backlog function with a
larger batch:

```
curl -X POST https://rvhyotvklfowklzjahdd.supabase.co/functions/v1/ct-embed-tape-commentary \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H "apikey: $SERVICE_ROLE_KEY" \
  -d '{"batch_size": 100}'
```

Returns `{ embedded: N, errors: [] }`.

## Why this matters (link to audit)

Per the fusion ground-truth doc Section B verdict, the JAC OS "nothing in the
gate without embedding" claim was empirically half-true before Phase 1 — high-
frequency narrative output (tape commentary, news causality, specialist reads)
violated the claim. Closing the gap turns the thesis from aspirational to
structural. This invariant family enforces it.

## Don't

- Don't disable the invariant if it fires repeatedly. Fix the upstream cause.
  The whole point is surfacing silent wrongness.
- Don't backfill via direct SQL UPDATE without going through `voyageEmbed` —
  the embeddings must come from the same model+dim (voyage-3-lite, 512) for
  cosine similarity to be meaningful.
