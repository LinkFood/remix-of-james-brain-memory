# Pulse v2 — Design Decisions

**Shipped:** 2026-05-02 ~05:30 UTC
**Migrations:** 20260502040100, 20260502040300, 20260502040400
**Edge function:** `ct-regime-capture`
**Brain organ:** `_shared/regimeContext.ts`
**UI:** `src/pages/Pulse.tsx` (rebuild) + `src/hooks/useRegimeState.ts`

---

## Why

Pulse v1 was a single-axis intraday score-momentum view (regime ∈ {trending_up, trending_down, chop, unknown}). It told you whether the tape was up, down, or sideways. It didn't tell you *what kind of up*, didn't carry historical analogs, didn't acknowledge calendar context, and couldn't evolve without code changes.

The captain-into-the-storm operating principle requires regime context that is:
1. **Multi-dimensional** — momentum + breadth + trajectory + dispersion + duration + macro proximity
2. **Embeddable** — every regime state has a 512-dim narrative embedding so analogs can be searched (cosine similarity on `ct_regime_history.embedded_state`)
3. **Configurable** — adding a new regime classification is a database INSERT into `ct_regime_config`, not a code change (Tenet 25)
4. **Calendar-aware** — FOMC/CPI/Jobs proximity overrides flow reads (priority 100 `pre_event_macro` rule)

## Schema architecture

| Table | Role | Cardinality |
|---|---|---|
| `ct_regime_signals` | Raw per-bucket signals per (ticker \| NULL=market-wide). UPSERT on (ticker, bucket_ts) NULLS NOT DISTINCT. | 11 rows × bucket_count |
| `ct_regime_classifications` | Derived label per (ticker, bucket). UPSERT. | Same |
| `ct_regime_history` | Append-only state evolution + embedded_state. HNSW cosine index. | ~1.3k/day RTH |
| `ct_regime_config` | Classification rules. INSERT to add labels. | 11 starter rules |

**Why three tables instead of one:** signals and classifications upsert with different semantics; history is append-only for analog search; config is rule storage. Keeping them separate makes UPSERT contracts unambiguous and lets HNSW live only on the table that needs it.

**Why NULLS NOT DISTINCT:** market-wide rows use `ticker IS NULL`. NULLS NOT DISTINCT (PG 15+) makes the unique index treat NULL as comparable, so each market-wide bucket is correctly unique.

## Producer architecture

**Edge function, not RPC** — original brief said postgres RPC, but `voyageEmbed` lives in TypeScript at `_shared/ctEmbed.ts`. Postgres can't reach it cleanly without pg_net + custom HTTP shim (fragile). Edge function fired by pg_cron via `net.http_post` keeps embedding in TS where it belongs while preserving operational behavior.

**Algorithm (compact):**
1. Round `now()` to 5-min bucket.
2. For each ticker in WATCHLIST + market-wide:
   - momentum = sum of signed `ct_pulse_events.usd_weight` last 30 min, normalized
   - breadth (market-wide only) = fraction of watchlist tickers with positive net premium
   - trajectory = sign comparison of momentum at current vs 5-min-ago bucket
   - dispersion (market-wide only) = std dev of per-ticker momentum
   - duration = minutes since trajectory last changed
   - macro_proximity = jsonb of FOMC/CPI/Jobs days + earnings clusters
3. UPSERT `ct_regime_signals`.
4. Classify: iterate active `ct_regime_config` ORDER BY priority DESC; first match wins.
5. UPSERT `ct_regime_classifications`.
6. Build rich_text → voyageEmbed → INSERT into `ct_regime_history` with embedded_state.

**Idempotent within bucket:** UPSERT on signals/classifications. History gets append-only writes (this is intentional — multiple writes within the same bucket capture trajectory micro-changes).

## Classification rules — starter set (priority order)

| Priority | Name | Notes |
|---|---|---|
| 100 | `pre_event_macro` | FOMC/CPI/Jobs within 2 days. Calendar overrides flow. |
| 80 | `trending_up_strong` / `trending_down_strong` | High momentum + broad participation |
| 70 | `breaking_up` / `breaking_down` | Just-flipped momentum (last 15 min) |
| 60 | `trending_up_steady` / `trending_down_steady` | Moderate sustained |
| 45 | `chop_high_dispersion` | Rotation regime (low net momentum, high spread) |
| 40 | `chop_low_dispersion` | Consolidation |
| 30 | `decaying` | Trajectory losing energy |
| 0 | `unknown` | Fallback |

Rules are tunable via `ct_regime_config.signal_thresholds` (JSONB). Adding a regime label is `INSERT INTO ct_regime_config` — no edge function deploy. Tenet 25 operational.

## Why partitioning was deferred

Brief specified "partition by date." At 1.3k rows/day, ~480k/year, partitioning adds operational cost without performance benefit yet. HNSW on a non-partitioned table is simpler than HNSW per partition. **Cutover trigger:** when `ct_regime_history` row count exceeds 5M OR analog search latency exceeds 200ms p95, migrate to monthly RANGE partition with HNSW per partition.

## Brain organ

`_shared/regimeContext.ts` — `ContextHelper<RegimeResult>` exposing:
- `market_wide` — current market regime tile
- `per_ticker` — per-watchlist-ticker classification
- `top_analogs` — top 3 historical analog regime states by cosine similarity (via `search_ct_regime_analogs` RPC)
- `generated_at` — timestamp

**Audience filter:** `['cotrader', 'analyst']`. `paper_claude` excluded — preserves the original isolation contract for the research-layer firewall.

**Preamble injection deferred until 2026-05-15** — adding regime context to the runtime preamble during the active C1 hit-rate experiment would contaminate falsifiability. Data is available via `organs.regime`; consumers can read it explicitly without polluting the global preamble until the C1 window closes.

## Warden invariants (3)

| Name | Threshold | Purpose |
|---|---|---|
| `regime_state_freshness_rth` | ≤90 min, weekend pass | Catches frozen producer |
| `regime_history_growing` | ≥30 rows / 24h on RTH days | Catches dead append path |
| `regime_embedding_present` | ≥95% non-NULL on 24h | Catches Voyage failures going unobserved |

All three passing post-build.

## Parallel-run with v1

`ct_flow_pulse_ticks`, `ct_pulse_events`, `ct_pulse_timeline`, `useFlowPulse` hook — all preserved. v2 is purely additive. v1 keeps powering the FlowPulse chart and the existing `pulseContext.ts` brain organ. v2 is a new dimension, not a replacement.

**Cutover decision deferred.** When v2's classification proves itself in production over the next 2-4 weeks, migrate v1 consumers to v2 incrementally. Until then both observe.

## Open items / next iterations

- **True cosine analog search in UI** — Pulse.tsx currently uses a frequency-based "what usually happens next" panel. Real cosine search via `search_ct_regime_analogs` RPC requires a Voyage embed call from the browser; deferred to v2.1.
- **Trading-day aware duration** — `duration_minutes` currently treats overnight as continuation. Consider trading-clock-only duration for sessions-spanning regimes.
- **Per-ticker dispersion proxy** — currently NULL on per-ticker rows; only market-wide has dispersion. Per-ticker dispersion (e.g., strike-skew dispersion) is a future signal.
- **`ct-system-map-regen` weekly** — auto-regen system map (per findings.md note). Should pick up new tables/organs/crons/invariants automatically. Hand-update for tonight's batch is in `docs/system-map/` (this commit).

## System map findings amendments

Per `docs/system-map/findings.md`, the recommendation "auto-regen pattern" applies — `ct-system-map-regen` should be a weekly Sunday cron that regenerates `tables.md`, `cron-schedules.md`, `warden-invariants.md` programmatically. Tonight's manual update suffices; build the regen cron in a follow-up.
