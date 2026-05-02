# System Map — JAC Agent OS / Co-Trader

**Comprehensive read-only inventory of every edge function, table, cron,
brain organ, warden invariant, UI surface, and cross-facet wire.**
Generated 2026-05-02 via 5 parallel audit agents + programmatic extraction.

This is the load-bearing reference for both Claude Code sessions and
future Cowork conversations. When in doubt about what produces what / what
reads what / what's orphaned, **start here.**

## Inventory at a glance

| Surface | Count | Status |
|---|---|---|
| Edge functions | 163 | Audited — see `edge-functions.md` |
| Migrations | 419 | Distinct tables: 68 |
| Tables | 68 | Audited — see `tables.md` |
| Live crons (cron.job) | 221 | 124 ct-* + 97 jac-* / shared |
| Brain organs | 10 | (+2 infrastructure files) |
| Warden invariants | 19 | All passing 2026-05-02 |
| UI pages | 33 | Audited — see `ui-surfaces.md` |
| UI hooks | 105 | 34 currently unimported |

## Files

| File | Purpose |
|---|---|
| [`README.md`](./README.md) | This file. Top-level navigation + executive summary. |
| [`edge-functions.md`](./edge-functions.md) | Every edge function: purpose, trigger, tables read/written, RPCs, callers, status. |
| [`tables.md`](./tables.md) | Every table: row count, producer(s), consumer(s), brain-organ exposure, status. |
| [`cron-schedules.md`](./cron-schedules.md) | Every live cron: schedule, function invoked, last run, status. |
| [`ui-surfaces.md`](./ui-surfaces.md) | Pages → hooks → tables/RPCs queried. 34 orphan hooks flagged. |
| [`brain-organs.md`](./brain-organs.md) | Every ContextHelper: source tables, audience modes, validators, consumers. |
| [`warden-invariants.md`](./warden-invariants.md) | 19 invariants: what each watches + runbook reference. |
| [`cross-facet-wires.md`](./cross-facet-wires.md) | Co-Trader ↔ JAC connections + audience-mode firewall. |
| [`findings.md`](./findings.md) | **The highest-value file** — orphans, missing wires, dormant features, tenet violations, recommendations. |

## Top 5 findings (executive summary)

Full details in [`findings.md`](./findings.md).

1. **5 orphan tables with rows or schema drift** — `ct_dreams` (Dream Mode scaffolded then abandoned, 4 rows), `ct_specialist_principles`, `ct_weekly_reviews`, `deploy_environments`, `deploy_operations`. Action: archive or revive.

2. **`ct-custom-rule-eval` orphan cron** — header says "every 5min RTH" but no `cron.schedule(...)` block exists in any tracked migration. Either scheduled out-of-band or genuinely never wired. **Investigate before relying on it.**

3. **34 of 105 hooks have zero importers** in `src/pages/` or `src/components/`. Examples: `useEvLadder`, `useGexRadar`, `useMarketBreadth`. UI scaffolding ahead of consumer pages — Tenet 24 within front-end.

4. **`ct-flow-ingester` may have duplicate-cron concern** — 4 overlapping schedule entries in migration history. The unschedule-then-schedule pattern may have left some duplicate active jobs. Verify via direct cron.job query.

5. **Tenet 26 violation: `ct-backtest-harness`** — analysis-mode work living as autonomous infrastructure. Documented + intentional-for-now per CLAUDE.md tech-debt list. Plus watch list: `ct-mcp-shape-probe`, `ct-mcp-verify`.

## What the audit confirmed (good news)

- **0 warden invariants failing** at audit completion
- **All top-10 traffic tables** have producer + consumer + brain-organ exposure where applicable
- **Cross-facet bridges alive in intended direction** (Co-Trader → JAC); JAC → Co-Trader is zero by design
- **Tenet 25 confirmed alive**: detectors / prompts / invariants / lifecycle-rules all DB-driven, not hardcoded
- **Synthesis layer (12 organs)** is in place via `_shared/claudeReadSurface.ts` orchestrator
- **All 14 detectors documented** in `docs/detectors/` per Phase B Mon-Tue-Wed plan

## Caveats / methodology notes

- **Programmatic extraction misses raw REST POST writers** — 6 ingesters (ct-event-calendar-ingester, ct-indicator-events, ct-insider, ct-institutional, ct-political, ct-prediction-markets) write via `${SUPABASE_URL}/rest/v1/<table>?on_conflict=...` instead of `from('X').insert()`. Their `tables_written` columns may show empty.
- **Specialist functions** (10 ticker-specific) are 56-line copies importing `runSpecialistWakeup` from `_shared/specialistRunner.ts`. Real logic + table refs live there.
- **Cluster detectors** (`cluster_default`, `cluster_slow_stacker`) are NOT standalone functions — they're rows in `ct_detectors` consumed by `ct-signature-watcher`'s cluster loop.
- **Saturday audit timing**: 3 newly-shipped weekday-only crons (`ct-detector-scoreboard-update-rth`, `-offhours`, `ct-eod-specialist-narrative`) show `last_run = NULL`. **NOT broken** — they fire Mon during weekday windows. The `-weekend` variant fired successfully Sat 03:00 UTC.

## Auto-regen sketch (stretch goal — not built tonight)

A weekly `ct-system-map-regen` cron could re-run the programmatic
extraction, diff against current `docs/system-map/`, and open a PR via
the code-agent's branch-not-main discipline if drift is non-trivial.
Cadence: Sun 06:00 UTC. Effort: ~1 day. Build only if the system map
proves load-bearing — re-evaluate after 4 weeks of usage.

## When to update this map

- After any major refactor (≥10 files touched)
- When a new edge function category is added (e.g., a new detector class)
- After warden invariant additions/changes
- When a new UI page lands
- Suggested baseline: every 4 weeks via the auto-regen sketch above

Until then: trust this snapshot for navigation, but verify counts/state
against live data before acting on stale numbers.
