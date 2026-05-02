# Brain Organs (ContextHelpers)

**10 organs registered** — the synthesis layer's sensory inputs. Source: `supabase/functions/_shared/*Context.ts`.

Every Claude-facing surface composes its context through `buildClaudeContext(supabase, opts)` in `_shared/claudeReadSurface.ts`. The orchestrator fans out across registered organs via `Promise.all`, audience-gates per helper (`audienceFilter` on each `ContextHelper`), caches where opted-in, and emits one telemetry row per invocation to `ct_brain_telemetry`.

**Validator chain** (post-Claude, in `claudeReadSurface.ts`):
- `temporalValidator` — every consumer; catches confabulated time references
- `tickerCoherenceValidator` — `ct-chat` only (post-validated; off-universe mentions persisted to `ct_chat_tokens.validator_warnings`)

**Read/write separation (D4)**: organs NEVER call UW MCP. UW is write-path only; consumers read from our DB via organs. Warden invariant `ct_chat_no_uw_mcp` enforces.

## Organ matrix

| organ (file) | source tables | audience filter | cache TTL (s) | one-line summary | consumers (audience-gated) | status |
| --- | --- | --- | --- | --- | --- | --- |
| `flowHeatmapContext` (`flow_heatmap`) | `ct_flow_alerts (via RPC `ct_flow_heatmap_live`)` | none (universal) | 60 | Live heatmap of stacked flow alerts per ticker × strike × DTE. | `ct-alert-post-mortem`, `ct-chat`, `ct-curiosity`, `ct-daily-brief`, `ct-debate-outcome-scorer` +13 more | LIVE |
| `pulseContext` (`pulse`) | `ct_config`<br>`ct_flow_pulse_ticks` | none (universal) | 30 | Net premium velocity / pulse curve for QQQ + IWM. | `ct-alert-post-mortem`, `ct-chat`, `ct-curiosity`, `ct-daily-brief`, `ct-debate-outcome-scorer` +13 more | LIVE |
| `tapeContext` (`tape`) | `ct_tape_commentary` | none (universal) | none | Latest running commentary from `ct-tape-reader`. | `ct-alert-post-mortem`, `ct-chat`, `ct-curiosity`, `ct-daily-brief`, `ct-debate-outcome-scorer` +13 more | LIVE |
| `specialistContext` (`specialist`) | `ct_specialist_reads` | none (universal) | none | Per-ticker specialist read for the active session. | `ct-alert-post-mortem`, `ct-chat`, `ct-curiosity`, `ct-daily-brief`, `ct-debate-outcome-scorer` +13 more | LIVE |
| `specialistRecallContext` (`specialist_recall`) | `ct_specialist_reads`<br>`ct_flags`<br>`ct_flag_grades` | `cotrader` | none | Each per-ticker specialist's last 5 flagged + last 5 unflagged-conv-≥50 reads on the ticker. Three-state outcome rendering. | `ct-alert-post-mortem`, `ct-chat`, `ct-curiosity`, `ct-daily-brief`, `ct-debate-outcome-scorer` +11 more | LIVE-NEW (cotrader-only; 1st live exercise 2026-05-02 RTH) |
| `jamesFlagsContext` (`james_flags`) | `ct_flags (filtered to source = james)` | `cotrader, analyst` | none | James's hand-labeled signals — the human supervisor's training dataset. | `ct-alert-post-mortem`, `ct-chat`, `ct-curiosity`, `ct-daily-brief`, `ct-debate-outcome-scorer` +11 more | LIVE (cotrader/analyst only — paper_claude blocked) |
| `newsCausalityContext` (`news_causality`) | `ct_breaking_news`<br>`ct_news_analyses`<br>`ct_news_causality` | none (universal) | none | News headlines paired with measured market reaction. | `ct-alert-post-mortem`, `ct-chat`, `ct-curiosity`, `ct-daily-brief`, `ct-debate-outcome-scorer` +13 more | LIVE |
| `eventRecencyContext` (`event_recency`) | `ct_events`<br>`ct_breaking_news`<br>`ct_earnings_moves`<br>`ct_central_bank_rates` | none (universal) | none | What just happened in the last 72h. Source for `preamble.whatJustHappened`. | `ct-alert-post-mortem`, `ct-chat`, `ct-curiosity`, `ct-daily-brief`, `ct-debate-outcome-scorer` +13 more | LIVE |
| `analogsContext` (`analogs`) | `ct_session_embeddings (via RPC `search_ct_session_analogs`)` | none (universal) | none | Top-k similar past sessions by embedding distance — regime memory. | `ct-alert-post-mortem`, `ct-chat`, `ct-curiosity`, `ct-daily-brief`, `ct-debate-outcome-scorer` +13 more | CONDITIONAL |
| `detectorContext` (`detector`) | `ct_flags (where source = detector)` | none (universal) | none | Today's detector portfolio firings: which detectors fired, with confidence + lifecycle stage. | `ct-alert-post-mortem`, `ct-chat`, `ct-curiosity`, `ct-daily-brief`, `ct-debate-outcome-scorer` +13 more | LIVE |

## Per-organ detail

### `flowHeatmapContext` → organ `flow_heatmap`

- **Source tables**: `ct_flow_alerts (via RPC `ct_flow_heatmap_live`)`
- **Audience filter**: none — every audience sees this organ
- **Cache TTL**: 60 s
- **Summary**: Live heatmap of stacked flow alerts per ticker × strike × DTE.
- **Consumers** (18): `ct-alert-post-mortem`, `ct-chat`, `ct-curiosity`, `ct-daily-brief`, `ct-debate-outcome-scorer`, `ct-eod-report`, `ct-eod-specialist-narrative`, `ct-eod-summary`, `ct-hypothesis-health-check`, `ct-hypothesis-proposer`, `ct-lessons-curator`, `ct-news-sweep`, `ct-playbook-curator`, `ct-self-grader`, `ct-tape-reader`, `ct-trade-advisories`, `ct-trade-idea-generator`, `ct-watcher`
- **Note**: cached 60s. RPC-based — no direct table query. Drives `ct-news-sweep`, `ct-playbook-curator`, `ct-alert-post-mortem` etc.

### `pulseContext` → organ `pulse`

- **Source tables**: `ct_config`, `ct_flow_pulse_ticks`
- **Audience filter**: none — every audience sees this organ
- **Cache TTL**: 30 s
- **Summary**: Net premium velocity / pulse curve for QQQ + IWM.
- **Consumers** (18): `ct-alert-post-mortem`, `ct-chat`, `ct-curiosity`, `ct-daily-brief`, `ct-debate-outcome-scorer`, `ct-eod-report`, `ct-eod-specialist-narrative`, `ct-eod-summary`, `ct-hypothesis-health-check`, `ct-hypothesis-proposer`, `ct-lessons-curator`, `ct-news-sweep`, `ct-playbook-curator`, `ct-self-grader`, `ct-tape-reader`, `ct-trade-advisories`, `ct-trade-idea-generator`, `ct-watcher`

### `tapeContext` → organ `tape`

- **Source tables**: `ct_tape_commentary`
- **Audience filter**: none — every audience sees this organ
- **Cache TTL**: none s
- **Summary**: Latest running commentary from `ct-tape-reader`.
- **Consumers** (18): `ct-alert-post-mortem`, `ct-chat`, `ct-curiosity`, `ct-daily-brief`, `ct-debate-outcome-scorer`, `ct-eod-report`, `ct-eod-specialist-narrative`, `ct-eod-summary`, `ct-hypothesis-health-check`, `ct-hypothesis-proposer`, `ct-lessons-curator`, `ct-news-sweep`, `ct-playbook-curator`, `ct-self-grader`, `ct-tape-reader`, `ct-trade-advisories`, `ct-trade-idea-generator`, `ct-watcher`

### `specialistContext` → organ `specialist`

- **Source tables**: `ct_specialist_reads`
- **Audience filter**: none — every audience sees this organ
- **Cache TTL**: none s
- **Summary**: Per-ticker specialist read for the active session.
- **Consumers** (18): `ct-alert-post-mortem`, `ct-chat`, `ct-curiosity`, `ct-daily-brief`, `ct-debate-outcome-scorer`, `ct-eod-report`, `ct-eod-specialist-narrative`, `ct-eod-summary`, `ct-hypothesis-health-check`, `ct-hypothesis-proposer`, `ct-lessons-curator`, `ct-news-sweep`, `ct-playbook-curator`, `ct-self-grader`, `ct-tape-reader`, `ct-trade-advisories`, `ct-trade-idea-generator`, `ct-watcher`

### `specialistRecallContext` → organ `specialist_recall`

- **Source tables**: `ct_specialist_reads`, `ct_flags`, `ct_flag_grades`
- **Audience filter**: cotrader
- **Cache TTL**: none s
- **Summary**: Each per-ticker specialist's last 5 flagged + last 5 unflagged-conv-≥50 reads on the ticker. Three-state outcome rendering.
- **Consumers** (16): `ct-alert-post-mortem`, `ct-chat`, `ct-curiosity`, `ct-daily-brief`, `ct-debate-outcome-scorer`, `ct-eod-report`, `ct-eod-specialist-narrative`, `ct-eod-summary`, `ct-lessons-curator`, `ct-news-sweep`, `ct-playbook-curator`, `ct-self-grader`, `ct-tape-reader`, `ct-trade-advisories`, `ct-trade-idea-generator`, `ct-watcher`
- **Note**: 10th and newest organ (commit `afbcfd7`). Strict `cotrader`-only audience filter — preserves the research-firewall isolation experiment.

### `jamesFlagsContext` → organ `james_flags`

- **Source tables**: `ct_flags (filtered to source = james)`
- **Audience filter**: cotrader, analyst
- **Cache TTL**: none s
- **Summary**: James's hand-labeled signals — the human supervisor's training dataset.
- **Consumers** (16): `ct-alert-post-mortem`, `ct-chat`, `ct-curiosity`, `ct-daily-brief`, `ct-debate-outcome-scorer`, `ct-eod-report`, `ct-eod-specialist-narrative`, `ct-eod-summary`, `ct-lessons-curator`, `ct-news-sweep`, `ct-playbook-curator`, `ct-self-grader`, `ct-tape-reader`, `ct-trade-advisories`, `ct-trade-idea-generator`, `ct-watcher`
- **Note**: `paper_claude` blocked by D3 firewall — preserves the post-2026-04-25 paper-Claude isolation experiment.

### `newsCausalityContext` → organ `news_causality`

- **Source tables**: `ct_breaking_news`, `ct_news_analyses`, `ct_news_causality`
- **Audience filter**: none — every audience sees this organ
- **Cache TTL**: none s
- **Summary**: News headlines paired with measured market reaction.
- **Consumers** (18): `ct-alert-post-mortem`, `ct-chat`, `ct-curiosity`, `ct-daily-brief`, `ct-debate-outcome-scorer`, `ct-eod-report`, `ct-eod-specialist-narrative`, `ct-eod-summary`, `ct-hypothesis-health-check`, `ct-hypothesis-proposer`, `ct-lessons-curator`, `ct-news-sweep`, `ct-playbook-curator`, `ct-self-grader`, `ct-tape-reader`, `ct-trade-advisories`, `ct-trade-idea-generator`, `ct-watcher`

### `eventRecencyContext` → organ `event_recency`

- **Source tables**: `ct_events`, `ct_breaking_news`, `ct_earnings_moves`, `ct_central_bank_rates`
- **Audience filter**: none — every audience sees this organ
- **Cache TTL**: none s
- **Summary**: What just happened in the last 72h. Source for `preamble.whatJustHappened`.
- **Consumers** (18): `ct-alert-post-mortem`, `ct-chat`, `ct-curiosity`, `ct-daily-brief`, `ct-debate-outcome-scorer`, `ct-eod-report`, `ct-eod-specialist-narrative`, `ct-eod-summary`, `ct-hypothesis-health-check`, `ct-hypothesis-proposer`, `ct-lessons-curator`, `ct-news-sweep`, `ct-playbook-curator`, `ct-self-grader`, `ct-tape-reader`, `ct-trade-advisories`, `ct-trade-idea-generator`, `ct-watcher`

### `analogsContext` → organ `analogs`

- **Source tables**: `ct_session_embeddings (via RPC `search_ct_session_analogs`)`
- **Audience filter**: none — every audience sees this organ
- **Cache TTL**: none s
- **Summary**: Top-k similar past sessions by embedding distance — regime memory.
- **Consumers** (18): `ct-alert-post-mortem`, `ct-chat`, `ct-curiosity`, `ct-daily-brief`, `ct-debate-outcome-scorer`, `ct-eod-report`, `ct-eod-specialist-narrative`, `ct-eod-summary`, `ct-hypothesis-health-check`, `ct-hypothesis-proposer`, `ct-lessons-curator`, `ct-news-sweep`, `ct-playbook-curator`, `ct-self-grader`, `ct-tape-reader`, `ct-trade-advisories`, `ct-trade-idea-generator`, `ct-watcher`
- **Note**: depends out-of-band on `ct-session-analog` cron writing `ct_session_embeddings`. First real row builds tonight 2026-05-01 21:30 UTC. Returns `meta.warning = no_current_embedding` until then. Warden invariant `ct_session_analog_deployed` watches.

### `detectorContext` → organ `detector`

- **Source tables**: `ct_flags (where source = detector)`
- **Audience filter**: none — every audience sees this organ
- **Cache TTL**: none s
- **Summary**: Today's detector portfolio firings: which detectors fired, with confidence + lifecycle stage.
- **Consumers** (18): `ct-alert-post-mortem`, `ct-chat`, `ct-curiosity`, `ct-daily-brief`, `ct-debate-outcome-scorer`, `ct-eod-report`, `ct-eod-specialist-narrative`, `ct-eod-summary`, `ct-hypothesis-health-check`, `ct-hypothesis-proposer`, `ct-lessons-curator`, `ct-news-sweep`, `ct-playbook-curator`, `ct-self-grader`, `ct-tape-reader`, `ct-trade-advisories`, `ct-trade-idea-generator`, `ct-watcher`

## Audience system

Defined in `_shared/contextHelper.ts:43-49`. Each consumer declares its audience; each organ declares which audiences see it.

| audience | purpose |
| --- | --- |
| `cotrader` | operational amplifier for James (default) |
| `paper_claude` | research-layer firewall (no James-owned data) |
| `analyst` | terminal-Claude analysis sessions |
| `voice` | ElevenLabs voice surface (brevity-optimized) |
| `slack` | Slack response context |
| `agent_internal` | Co-Trader subsystem-to-subsystem |

## Read-set firewall (`BLOCKED_READS_PAPER`)

Per-audience block-list surfaced in the prompt context (`claudeReadSurface.ts:766-773`). Applied for `paper_claude` audience only:
- `ct_trades WHERE trader='james'`
- `ct_book WHERE trader='james'`
- `ct_custom_rules WHERE trader='james'`
- `ct_james_reviews` (entire table)
- `ct_notes` (entire table)
- `ct_flags WHERE source='james_star'`

All other audiences (`cotrader` / `analyst` / `voice` / `slack` / `agent_internal`) get an empty block-list — they see all James-owned data.

## `buildClaudeContext` consumer matrix

Total consumers: **18** functions. Every consumer currently requests `'all'` organs and relies on audience filtering for gating.

| consumer | requested organs | declared audience |
| --- | --- | --- |
| `ct-alert-post-mortem` | all | `cotrader` |
| `ct-chat` | all | `cotrader` |
| `ct-curiosity` | all | `cotrader` |
| `ct-daily-brief` | all | `cotrader` |
| `ct-debate-outcome-scorer` | all | `cotrader` |
| `ct-eod-report` | all | `cotrader` |
| `ct-eod-specialist-narrative` | all | `cotrader` |
| `ct-eod-summary` | all | `cotrader` |
| `ct-hypothesis-health-check` | all | `paper_claude` |
| `ct-hypothesis-proposer` | all | `paper_claude` |
| `ct-lessons-curator` | all | `cotrader` |
| `ct-news-sweep` | all | `cotrader` |
| `ct-playbook-curator` | all | `cotrader` |
| `ct-self-grader` | all | `cotrader` |
| `ct-tape-reader` | all | `cotrader` |
| `ct-trade-advisories` | all | `cotrader` |
| `ct-trade-idea-generator` | all | `cotrader` |
| `ct-watcher` | all | `cotrader` |