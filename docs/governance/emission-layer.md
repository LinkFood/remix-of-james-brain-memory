# JAC Proactive Emission Layer

## Status

Phase 1 shipped 2026-05-08 — kernel scaffolding + one proof trigger (hot_contract) end-to-end with Slack-only emission. Phase 2+ queued.

## What it is

The system has three modes:

1. **Observation** — organs ingest, brain composes context (always-on, cron-driven)
2. **Consumption** — captain asks chat, system answers (request-response)
3. **Emission** — system proactively says things back unprompted ← **this layer**

Phase 1 ships emission's kernel scaffolding plus the first concrete trigger. Captain framing: *"this system reads and understands and has a brain inside itself, but it's not giving me anything ever."*

## Kernel-vs-application boundary

Per the kernel-vs-limb discipline (JAC OS contains Co-Trader as application limb), this layer respects the boundary throughout.

### Kernel (domain-agnostic, lands in JAC layer)

- **Tables:** `jac_emission_triggers` (registry), `jac_emissions` (event log)
- **Edge functions:**
  - `jac-compose-emission` — wraps `buildClaudeContext`, calls Claude with template, persists row
  - `jac-emit` — dispatches an emission to its targets (slack/feed/...)
  - `jac-emission-detector` — cron-driven runner, iterates enabled triggers, calls compose+emit per detected event
- **Composition templates** — currently inline in `jac-compose-emission`; promotable to `jac_composition_templates` table in Phase 4

### Application (Co-Trader specific)

- **Detection function** `public.detect_hot_contract(p_params jsonb)` — reads `ct_scored_flow`, applies score+premium thresholds, debounces by ticker:option_symbol
- **Trigger registration row** in `jac_emission_triggers` with `application='cotrader'` and `detection_function='detect_hot_contract'`

A future application running on JAC registers its own detection function + trigger row; the kernel scaffolding doesn't change.

## How a new trigger gets added

Adding a trigger is a database INSERT, not a code change (Tenet 25 — kernel evolves in structure, not within structure).

```sql
-- 1. Application defines a detection function
CREATE FUNCTION public.detect_<my_trigger>(p_params JSONB) RETURNS TABLE (
  event_dedup_key TEXT,
  event_payload JSONB,
  severity TEXT,
  ticker_focus TEXT
) AS $$ ... $$;

-- 2. Application or kernel adds a composition template (Phase 1: inline in
--    jac-compose-emission's TEMPLATES map; Phase 4: row in jac_composition_templates)

-- 3. Register the trigger
INSERT INTO jac_emission_triggers (
  trigger_name, application, detection_function, detection_params,
  default_severity, cadence_mode, cadence_params, composition_template,
  emission_targets, enabled
) VALUES (
  'my_trigger', 'cotrader', 'detect_my_trigger',
  '{"some_threshold": 100}',
  'signal', 'debounced',
  '{"debounce_minutes": 60, "per_key": "<key>"}',
  'cotrader_my_trigger_v1',
  ARRAY['slack'], true
);
```

Detection function contract:
- Input: `p_params JSONB` — thresholds and per-trigger config
- Output rows: `(event_dedup_key TEXT, event_payload JSONB, severity TEXT, ticker_focus TEXT)`
- Idempotency: function should filter rows that already produced an emission with matching `event_dedup_key` within the debounce window (use NOT EXISTS against `jac_emissions`)

## Severity → model selection

| Severity | Default model | When to use |
|---|---|---|
| info | haiku | Routine context updates; no captain action needed |
| signal | haiku | Worth a glance; captain may act |
| alert | sonnet | Decision-shaping; captain should act soon |
| critical | sonnet | Time-sensitive; captain should act now |

Per-trigger override via `jac_emission_triggers.model_override`.

## Cadence modes

- `per_event` — every detection-row produces an emission
- `debounced` — skip if `event_dedup_key` was emitted within `cadence_params.debounce_minutes`. Detection function enforces this via NOT EXISTS lookup.
- `rate_limited` — cap to N emissions per window. `cadence_params: {n: 5, window_minutes: 60}`. Runner enforces.

## Emission targets

Phase 1 supported:
- `slack` — `ctSlackPushDirect` with mrkdwn + blocks (severity icon, headline, take, context line, optional links)
- `feed` — no-op, returns `status='deferred'` with note `'site_feed_phase_2_pending'`. Site feed component lands Phase 2.

Adding a new target = add a `dispatch<Target>` function in `jac-emit/index.ts` and a switch case.

## Composition tone

Hot-contract template (`cotrader_hot_contract_v1`) inherits voice from `ct-tape-reader`:
- Senior options-flow reader looking over a day-trader's shoulder
- 2-3 sentences. No hedging. No disclaimers.
- Names ticker, contract specifics, pattern. Calls out regime alignment or contradiction explicitly.
- Strict JSON output: `{headline (≤12 words, no period), take (2-3 sentences), links}`

Templates ossify after first ship — captain's reaction to first emissions tunes wording. Don't change the schema lightly.

## What Phase 1 does NOT include (queued for subsequent phases)

| Phase | Scope |
|---|---|
| 2 | Site event-feed component (in-app feed surface; emissions land in feed AND Slack) |
| 2 | Captain feedback UI (👍👎 buttons → `jac_emission_feedback` table) |
| 3 | Additional triggers: butterfly cross, cross-organ alignment, specialist shift, regime transition |
| 3 | Trigger-quality grader as warden invariant (drift detection on hit-rate by trigger) |
| 4 | `jac_composition_templates` table — templates as data, not code |
| 4 | `jac-heartbeat` unification into the framework (heartbeat becomes a trigger) |
| 4 | Cross-trigger composition — multiple triggers same ticker compose unified emission |

## Phase 1 validation criterion

End-to-end pipeline working:
1. ct-scored-flow row meeting score+premium thresholds appears
2. Detection runner picks it up at next minute (RTH only)
3. Compose function builds context, calls Claude, writes row to `jac_emissions`
4. Emit function dispatches to Slack via `ctSlackPushDirect`
5. Captain receives Slack message with severity icon + headline + take + context line

Phase 1 closes when captain confirms ≥60% useful rate over a sufficient sample of emissions. Tuning loop:
- Too noisy → raise `score_min` or `premium_signal_min` in trigger config (DB UPDATE, no code change)
- Too quiet → lower thresholds
- Wrong tone → revise `cotrader_hot_contract_v1` template in code (single PR)

## Cross-references

- Substrate: `supabase/functions/_shared/claudeReadSurface.ts` (brain composition)
- Slack helper: `supabase/functions/_shared/ctSlack.ts` (`ctSlackPushDirect`)
- Tape-reader voice reference: `supabase/functions/ct-tape-reader/index.ts`
- Migration: `supabase/migrations/20260510030000_jac_emission_layer_phase_1.sql`
- Edge functions: `supabase/functions/jac-{compose-emission,emit,emission-detector}/index.ts`
- _ct_post helper apikey fix: `supabase/migrations/20260507160000_apikey_in_ct_post_helpers.sql`
- Bundle Phase 2 organMetadata pattern (the read-shape sibling): `supabase/functions/_shared/contextHelper.ts:120-152`
