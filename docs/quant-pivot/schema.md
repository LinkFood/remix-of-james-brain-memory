# Co-Trader Schema — Supabase Tables

All tables prefixed `ct_` (co-trader) to namespace cleanly from existing JAC tables.

**Embedding strategy:** Voyage AI 512-dim (matches existing JAC/DCD pattern). One unified `ct_embeddings` table referenced by `(item_type, item_id)`. Keeps raw row tables lean; allows cross-type semantic search.

**Graded items (`ct_flags`, `ct_alerts`, `ct_james_views`) get grades linked via `ct_grades`.**

---

## Tables

### `ct_theses` — current thesis per instrument
One row per instrument, updated in place; history in `ct_thesis_history`.
```
id                 uuid pk
instrument         text (SPY, NVDA, etc.)
direction          text (bullish/bearish/neutral)
conviction         int (1-5)
up_case            text
down_case          text
watching           text (trigger conditions)
rationale          text
updated_at         timestamptz
prompt_version     text
author             text (always 'claude' for now)
```

### `ct_thesis_history` — thesis evolution audit log
Append-only. Every thesis update writes here.
```
id                 uuid pk
instrument         text
previous_direction text
new_direction      text
previous_conviction int
new_conviction     int
reason             text (why it changed)
triggered_by       uuid (fk to ct_observations/ct_flags if relevant)
created_at         timestamptz
prompt_version     text
```

### `ct_observations` — notable but not flag-worthy
Embedded. Feeds memory recall.
```
id                 uuid pk
instrument         text[] (can involve multiple)
observation        text (full reasoning block)
glance             text[] (5 bullets)
up_case_odds       numeric
down_case_odds     numeric
direction          text
prior_read         text
update_note        text
watching           text
memory_recall_used jsonb (which past items retrieved)
prompt_version     text
created_at         timestamptz
```

### `ct_flags` — committed calls
Graded at horizon close. Conviction 1-4.
```
id                 uuid pk
instrument         text[] 
direction          text (bullish/bearish/neutral/volatility)
conviction         int (1-4)
horizon            text (1h/4h/EOD/next-day/weekly)
horizon_end        timestamptz (when to grade)
entry_price        numeric (per instrument, jsonb if multi)
up_case            text
up_case_odds       numeric
down_case          text
down_case_odds     numeric
watching           text
full_reasoning     text
glance             text[]
memory_recall_used jsonb
author             text ('claude')
prompt_version     text
created_at         timestamptz
grade_id           uuid (fk to ct_grades, null until graded)
```

### `ct_alerts` — urgent / time-critical
Conviction 5 or event-triggered. Same shape as `ct_flags` + alert-specific fields.
```
[all ct_flags columns]
alert_trigger      text (regime_shift / thesis_invalidation / news / vol_event)
urgency_window     text (minutes this matters)
acknowledged_at    timestamptz (when james saw it)
```

### `ct_heartbeats` — quiet cycle pings
Not embedded. Rolling window for command station "current state" strip.
```
id                 uuid pk
status_line        text
watching           text[] (instruments being monitored)
current_reads      jsonb (per-instrument brief state)
created_at         timestamptz
prompt_version     text
```

### `ct_james_views` — James's posted views
Captured via Slack slash commands or chat. For disagreement log.
```
id                 uuid pk
instrument         text
direction          text
conviction         int
horizon            text
horizon_end        timestamptz
rationale          text
entry_price        numeric (jsonb if multi)
created_at         timestamptz
grade_id           uuid (fk to ct_grades)
```

### `ct_disagreements` — when james ≠ claude on same instrument/horizon
Materialized when both have active views on same instrument with different directions.
```
id                 uuid pk
instrument         text
horizon            text
horizon_end        timestamptz
james_view_id      uuid (fk ct_james_views)
claude_view_id     uuid (fk ct_flags)
resolution         text (pending / claude_right / james_right / both_wrong / both_right)
resolution_detail  text
created_at         timestamptz
resolved_at        timestamptz
```

### `ct_grades` — outcomes
Every flag/alert/james_view gets graded at horizon close.
```
id                 uuid pk
subject_type       text (flag/alert/james_view)
subject_id         uuid
instrument         text
claimed_direction  text
claimed_odds_up    numeric
claimed_odds_down  numeric
actual_return      numeric (% move over horizon)
actual_direction   text (bullish/bearish/flat by threshold)
verdict            text (right/wrong/ambiguous/partial)
notes              text
graded_at          timestamptz
```

### `ct_lessons` — curated ADD/SUPERSEDE/SKIP
Weekly consolidation. Embedded.
```
id                 uuid pk
lesson             text
source_items       uuid[] (observations/flags that generated it)
instruments        text[] (applies to)
curation_action    text (ADD/SUPERSEDE)
supersedes_lesson  uuid (fk if SUPERSEDE)
created_at         timestamptz
active             boolean default true
```

### `ct_gex_snapshots` — SPX (primary) + SPY (secondary) GEX
Periodic snapshots for the command station banner + historical context.
```
id                 uuid pk
index_symbol       text (SPX/SPY)
call_wall          numeric
put_wall           numeric
gamma_flip         numeric
zero_gamma         numeric
total_gex          numeric
gex_profile        jsonb (array of {strike, gamma_exposure})
snapshot_at        timestamptz
```

### `ct_news_analyses` — Claude's news take per ticker per event
```
id                 uuid pk
instrument         text
news_headline      text
news_source        text
claude_take        text
impact             text (bullish/bearish/neutral)
significance       int (1-5)
created_at         timestamptz
prompt_version     text
```

### `ct_reports` — EOD / weekly / quarterly recaps
Embedded.
```
id                 uuid pk
report_type        text (eod/weekly/quarterly)
period_start       timestamptz
period_end         timestamptz
summary            text (Doc's-style recap)
decomposition      jsonb (factors + weights + notes)
rabbit_hole        text (curiosity of the day)
scorecard          jsonb (flag precision, conviction calibration, instrument-level accuracy)
self_assessment    text (Claude's own read on his patterns)
created_at         timestamptz
prompt_version     text
```

### `ct_embeddings` — unified semantic index
```
id                 uuid pk
item_type          text (observation/flag/alert/thesis/lesson/report/news/james_view)
item_id            uuid
embedding          vector(512)
metadata           jsonb (instrument, direction, conviction, created_at, graded, etc.)
created_at         timestamptz
```

---

## Indexes

```sql
-- fast memory recall
create index on ct_embeddings using ivfflat (embedding vector_cosine_ops) with (lists = 100);
create index on ct_embeddings (item_type, (metadata->>'instrument'));
create index on ct_embeddings ((metadata->>'instrument'), created_at desc);

-- fast grader lookups
create index on ct_flags (horizon_end) where grade_id is null;
create index on ct_alerts (horizon_end) where grade_id is null;
create index on ct_james_views (horizon_end) where grade_id is null;

-- fast per-instrument lookups
create index on ct_flags ((instrument[1]), created_at desc);
create index on ct_observations ((instrument[1]), created_at desc);
create index on ct_theses (instrument);

-- heartbeat rolling window
create index on ct_heartbeats (created_at desc);
```

---

## Retention

- `ct_heartbeats` — trim to last 7 days (rolling)
- `ct_observations` — keep forever (corpus)
- `ct_flags`, `ct_alerts`, `ct_james_views` — keep forever
- `ct_grades` — keep forever
- `ct_lessons` — keep forever (but inactive ones marked `active=false`)
- `ct_gex_snapshots` — keep last 90 days detailed, daily rollup beyond
- `ct_reports` — keep forever
- `ct_thesis_history` — keep forever
- `ct_embeddings` — matches underlying item retention

---

## Bootstrap SQL location

Migrations go in `/Users/jameschellis/jac-agent-os/supabase/migrations/` with filename `YYYYMMDDHHMMSS_ct_schema.sql`. One migration for tables, one for indexes, one for RLS policies (service-role-only for MVP — linkjac is single-user).
