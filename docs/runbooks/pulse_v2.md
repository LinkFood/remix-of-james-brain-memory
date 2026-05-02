# Pulse v2 — Runbook

Tables: `ct_regime_signals`, `ct_regime_classifications`, `ct_regime_history`, `ct_regime_config`
Producer: edge function `ct-regime-capture` (cron `*/5 13-21 * * 1-5` RTH + `0 10-12,21-22 * * 1-5` off-hours)
Brain organ: `_shared/regimeContext.ts`

## Warden invariants

### `regime_state_freshness_rth`
**Threshold:** ≤90 min staleness. **Weekend skip** (returns 0 = pass).

When alarm fires:
1. Check `MAX(last_updated) FROM ct_regime_classifications` — confirm staleness.
2. Check edge function logs at Supabase Dashboard → Edge Functions → `ct-regime-capture` → Logs.
3. If logs show errors: most likely Voyage API or supabase-js issue. Per CLAUDE.md gotcha, never use unpinned `@supabase/supabase-js@2` — must be `@2.84.0`.
4. If no log activity: cron may have stopped. Check `cron.job` table for `ct-regime-capture-rth` and `ct-regime-capture-offhours` — both should exist.
5. Manually re-fire:
   ```bash
   KEY=$(npx supabase projects api-keys --project-ref rvhyotvklfowklzjahdd 2>/dev/null | grep service_role | awk '{print $NF}')
   curl -X POST "https://rvhyotvklfowklzjahdd.supabase.co/rest/v1/rpc/invoke_edge_function" \
     -H "Authorization: Bearer $KEY" -H "apikey: $KEY" -H "Content-Type: application/json" \
     -d '{"function_name":"ct-regime-capture","body":{}}'
   ```

### `regime_history_growing`
**Threshold:** ≥30 rows / 24h on RTH weekdays. Weekend skip.

If failing during RTH: same diagnostic as freshness — producer is broken. Check the row count by ticker:
```sql
SELECT ticker, count(*) FROM ct_regime_history
WHERE created_at > now() - interval '24 hours'
GROUP BY ticker;
```
Should show all 10 watchlist tickers + 1 NULL (market-wide row), each with ~30+ rows after a full RTH session (12 fires × 5-min cadence × 8 hours = ~96 fires, but 11 rows per fire = ~1k/day).

### `regime_embedding_present`
**Threshold:** ≥95% of last-24h `ct_regime_history` rows have non-NULL `embedded_state`.

If failing: Voyage API issue. Check `VOYAGE_API_KEY` secret. Check edge function logs for "Voyage embed failed" messages. Producer continues writing rows with NULL embedded_state on Voyage failure (defensive — better to have history rows than none) — this invariant catches when that defensive behavior leaks into production.

## Adding a new regime classification

```sql
INSERT INTO public.ct_regime_config
  (classification_name, signal_thresholds, priority, active, description)
VALUES (
  'new_regime_label',
  '{"momentum_min": 0.5, "trajectory_in": ["accelerating"]}'::jsonb,
  65,  -- priority: between existing trends (60) and breaking (70)
  true,
  'What this regime captures'
);
```

Effective on next cron fire — no edge function deploy. Tenet 25 operational.

## Manual analog search

```sql
-- Top 5 historical analogs to current market-wide regime state.
SELECT * FROM public.search_ct_regime_analogs(
  p_ticker => null,           -- market-wide
  p_query_embedding => (
    SELECT embedded_state
    FROM ct_regime_history
    WHERE ticker IS NULL
    ORDER BY bucket_ts DESC
    LIMIT 1
  ),
  p_match_count => 5,
  p_threshold => 0.6
);
```

## When to rebuild the HNSW index

Rebuild when `ct_regime_history` row count crosses 100k or when analog search latency exceeds 200ms p95. Standard pgvector rebuild:

```sql
DROP INDEX IF EXISTS ct_regime_history_embedded_hnsw;
CREATE INDEX ct_regime_history_embedded_hnsw
  ON public.ct_regime_history
  USING hnsw (embedded_state extensions.vector_cosine_ops);
```

## Cutover to v1 retirement

Not yet. v1 (`ct_flow_pulse_ticks`, `ct_pulse_events`, `ct_pulse_timeline`) stays alive in parallel. Cutover decision when v2 has 4+ weeks of production data and the brain organ has demonstrated value in consumer telemetry.
