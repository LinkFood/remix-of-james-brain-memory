# Co-Trader Pickup — Session Continuation Notes

**Last updated:** 2026-04-19 end-of-session (Saturday night)  
**Gen 1 active:** since 2026-04-19 01:36 UTC, $50k → $60k / 14 days, survival $30k  
**Next market open:** Monday 2026-04-20 09:30 ET (13:30 UTC)

---

## Start here on next session

1. Read `/Users/jameschellis/jac-agent-os/CLAUDE.md` — full thesis (17 tenets + anti-principles + decision ritual + April 18 realizations block). This is the governing design principle; overrides all other judgment.
2. Check Gen 1 status: visit `/workspace` on linkjac.cloud OR query `ct_claude_generations WHERE status='active'`.
3. Check overnight/weekend state — did anything break? Query `ct_cron_failures WHERE resolved_at IS NULL`, `ct_claude_circuit_breakers WHERE cleared_at IS NULL`, `ct_claude_heartbeat` latest row, `ct_claude_decisions WHERE hallucination_flag=true AND created_at > now() - interval '24 hours'`.

---

## Monday open watch list (time-ordered)

First real autonomous trading session. These should happen on their own; if any don't, there's a bug.

| Time (UTC / ET) | Event | Verify |
|---|---|---|
| 11:00 / 07:00 | `ct-daily-brief` runs | New `ct_daily_briefs` row for 2026-04-20, triggered_by=`scheduled`, macro_narrative populated, per_ticker array has 12-13 cards, convergent_view set |
| 11:00 / 07:00 | `ct-hypothesis-proposer` runs (Sonnet) | 0-3 new `ct_hypotheses` rows with generation_id=Gen1, 0 hallucinations, signal categories span positioning/macro/structural |
| 13:30 / 09:30 | Market opens | — |
| 13:30 / 09:30 | First `ct-watcher` tick | New `ct_heartbeats` row, `ct-claude-health-monitor` flips status `off_hours → alive` within 10 min |
| 13:32 / 09:32 | `ct-claude-book-writer` first RTH tick | Monday's `ct_book` row for trader='claude' exists with `session_date=2026-04-20`, `starting_balance=50000` |
| 13:34 / 09:34 | `ct-claude-book-exit-watcher` first tick | Should be no-op (no open Claude positions yet) |
| 13:35 / 09:35 | `ct-trade-idea-generator` first tick | Gate passes (Gen 1 active), decisions logged with generation_id, either armed ideas OR no_trade with reasoning |
| 13:35 / 09:35 | `ct-claude-circuit-breaker` first tick | 0 breakers tripped initially |
| Throughout RTH | `ct-claude-open-trade-journal` every 2min while positions open | `claude_notes` appended with stance updates |
| 20:00 / 16:00 | Session close, `ct-claude-cash-decay` runs | $15 cash decay on balance (~0.03%) |

---

## Known TODOs / punch list

### Critical before Monday open
- **none remaining as of EOD Saturday** — the preflight pass caught the gen_id bug (fixed), the staleness false positive (fixed pending agent report), and the empty-table oddities (non-blocking).

### Known non-critical issues
- **`gamma_flip` derivation bug** (Wave G flagged). Picks thin OTM strikes sometimes (e.g., returned 85 for SPY when true flip ≈ 707). Needs sign-change detector in the strike scan rather than min(|net_gex|). Fix before Gen 3 ideally. File: `supabase/functions/_shared/tickerQuantCard.ts` build_ticker_quant_card RPC.
- **`ct_correlations` empty on every run**. UW MCP `get_correlations` tool returns `raw_pairs: 0`. Likely input-schema mismatch. Needs `ct_uw_mcp_tools.input_schema` inspection + adjust call args in `ct-correlations-ingester`. Non-blocking (correlations are advisory signal).
- **`ct_yield_curve` empty as of last check** (was 1 row earlier). Investigate the ingester's response on next manual trigger. Daily cron fires 9:00 UTC Mon-Fri — Monday's run may populate on its own.
- **5 UW ingesters on REST legacy** (short_interest, skew, sector_tide, news, event_calendar). Deferred from MCP migration because UW MCP doesn't expose those tools yet. Working fine on REST. Re-check inventory quarterly in case UW adds them.
- **`recordDecision` generation_id auto-resolve** is confirmed working post-redeploy, but the pattern should be extended to other implicit-context fields (brief_id, session_date). Same class-fix principle.

### Cross-facet items flagged in audit
- **JAC-side `enrich-entry` function dormant** — UI was removed; function can be deleted or re-enabled. Low priority.
- **Memory decay / archival** — entries + reflections grow unbounded. pgvector with HNSW handles scale, but eventually archival tier will be needed.
- **Realtime INSERT events unreliable** for `agent_conversations` — workaround is debounced polling on task completion (already in place).
- **Dashboard layout in localStorage only** — should persist to `user_settings.dashboard_layout`. Minor tech debt.

---

## Phase 3 backlog (post-Monday shakedown)

These were explicitly discussed tonight and agreed not to build before seeing Gen 1 data:

1. **Self-code trust scaffolding or direct use.** Capability already exists (code agent + PR flow). Decision: either build preview deploys / change diary / auto-rollback first, OR just start using self-code on small tasks (tune a config key via JAC Slack command) and build trust through observed reliability. James leaned toward "ship fewer safety nets, use the capability." His call.

2. **Claude Code Agent writes self-code PRs triggered by distilled principles.** When a `jac_principle` hits high confidence and implies a code change, JAC code-agent opens a PR against the affected prompt/config file. Gated on scope manifest (Tier 1: config only → Tier 2: prompts → Tier 3: function bodies in specific files). Closes the meta-loop entirely.

3. **Strategy universe expansion.** Current Claude: directional stock/option trades only. Phase 3 unlocks spreads, vol-selling, pair trades, calendar plays. Requires new trade_ideas schema extensions, new exit logic, new grading.

4. **13F institutional holdings deep integration.** We ingest (N.2) but Claude doesn't yet reason heavily over position-change deltas across quarters. Natural Phase 3 signal expansion.

5. **WebSocket streams.** Replace polling-based ingestion for flow/GEX/news with UW's WebSocket channels. Latency improvement; also enables faster re-brief on breaking events.

6. **Cross-facet principle distillation.** Currently: Co-Trader has its own `ct_principles`, JAC has `jac_principles`. They're siloed. Phase 3: `distill-principles` could extract cross-domain principles ("I tend to over-commit when I'm behind on weekly goals — this pattern shows in both trading and code").

---

## Decisions James needs to make

- **Self-code cadence.** Once comfortable, JAC can auto-PR based on principle confidence. Your call on when to flip this on (via Management PAT).
- **Next facet after Co-Trader.** JAC can support multiple verticals — what's the next domain to point it at? Writing assistant? Research compiler? Life manager? Podcast/content creator? Your call shapes Phase 3.
- **Gen 1 expectations.** James set this at 20-30% probability of hitting target on first generation. Either outcome is productive (win = scale up stakes; fail = generational reset teaches). Emotional calibration set.

---

## Context links

- **Full thesis:** `/Users/jameschellis/jac-agent-os/CLAUDE.md` (tenets 1-17 + realizations)
- **Memory:** `~/.claude/projects/-Users-jameschellis/memory/feedback_co_trader_thesis.md` (auto-loaded in future sessions)
- **State dashboard:** `linkjac.cloud/workspace` (Claude's State view — glance-first)
- **Decision log:** `linkjac.cloud/workspace?view=decisions` (Claude's thought-stream)
- **Generation lineage:** `linkjac.cloud/workspace?view=lineage` (past generations + why they ended)
- **Preflight:** `linkjac.cloud/preflight` (system readiness — ignore false-positive stale alerts from the cadence-unaware check until that's fixed)
- **Scorecard:** `linkjac.cloud/scorecard` (per-thesis win rate + James-vs-Claude divergence)

---

## What tonight shipped (for session continuity)

Phase 1 (A-H): generational foundation + read surface + proposer rewrite + trade engine + workspace UI. Commits `a8a4bbe → 2f6e533 → 0340f66 → 18addbf → bd2ba70`.  
Phase 2 (I-L): live trade journal + CIO Opus review + enhanced dream + UW MCP migration partial. Commits `3543dbc → d2e5bf3 → 5dba0b4 → 9b0256e`.  
Cleanup + thesis lock: gen_id auto-resolve + learning loops bridge + CLAUDE.md update. Commits `158cce9 → 4fefa8f → 7773197`.

All pushed to `main`. CI green.

---

*This file is living context. Update after every meaningful session so the next pickup has fresh state.*
