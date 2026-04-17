# Memory Recall — Pre-Flag Context Assembly

**Purpose:** Before each watcher cron cycle invokes Claude, the system assembles a memory bundle so Claude writes with historical self-awareness. This is HOW the corpus becomes useful — not just accumulated, but retrieved.

Runs inside `_shared/memoryRecall.ts`. Returns a structured context object passed to Claude alongside live market state.

---

## What gets retrieved, per cron cycle

For each instrument in scope (typically all 13 on the half-hour cron):

### 1. Current thesis
```sql
select * from ct_theses where instrument = $1;
```
Returns the active thesis. Gives Claude his own prior read to update from.

### 2. Recent activity (last 4 hours)
```sql
select 'observation' as type, id, instrument, observation, glance, created_at, prompt_version
from ct_observations
where $1 = any(instrument) and created_at > now() - interval '4 hours'
union all
select 'flag' as type, id, instrument, full_reasoning as observation, glance, created_at, prompt_version
from ct_flags
where $1 = any(instrument) and created_at > now() - interval '4 hours'
order by created_at desc;
```
Keeps Claude from repeating himself. Recency is cheap — read it directly.

### 3. Similar past setups (embedding search)
Build a query string describing the current state of the instrument:
```
"{instrument} {direction_of_move} {flow_condition} {gex_condition} {dp_condition}"
e.g. "NVDA intraday uptrend call flow 2x average above gamma flip dark pool neutral"
```
Embed via Voyage 512-dim. Search:
```sql
select e.item_type, e.item_id, e.metadata, e.embedding <=> $query_emb as distance
from ct_embeddings e
where e.item_type in ('observation', 'flag', 'alert')
  and (e.metadata->>'instrument') = $instrument
order by e.embedding <=> $query_emb
limit 8;
```
For each returned item, join its grade (if any) from `ct_grades`.

### 4. Graded outcomes of those similar setups
```sql
select g.*, f.direction as claimed_direction, f.conviction
from ct_grades g
join ct_flags f on f.id = g.subject_id
where f.id = any($similar_flag_ids);
```
Summarized into: "In N similar past setups, M were right (claimed direction hit), K were wrong, resolved returns ranged X% to Y%."

### 5. Relevant lessons
```sql
select l.*
from ct_lessons l
join ct_embeddings e on e.item_id = l.id and e.item_type = 'lesson'
where l.active = true
  and ($instrument = any(l.instruments) or l.instruments is null)
order by e.embedding <=> $query_emb
limit 3;
```

---

## Output shape passed to Claude

```json
{
  "instruments": ["SPY", "NVDA", ...],
  "timestamp": "2026-04-16T18:30:00Z",
  "live_state": { /* UW MCP live data */ },
  "memory": {
    "SPY": {
      "thesis": { /* ct_theses row */ },
      "recent_activity": [
        { "type": "observation", "created_at": "...", "glance": [...], "summary": "..." },
        ...
      ],
      "similar_past_setups": [
        {
          "created_at": "...",
          "summary": "...",
          "claimed_direction": "bullish",
          "conviction": 3,
          "outcome": { "verdict": "right", "actual_return": 0.8 }
        },
        ...
      ],
      "similar_summary": "4 of 7 similar setups resolved in claimed direction. Avg return on hit: +0.9%. Avg return on miss: -0.4%.",
      "relevant_lessons": [
        { "lesson": "...", "instruments": [...], "created_at": "..." },
        ...
      ]
    },
    "NVDA": { ... },
    ...
  }
}
```

Claude receives this bundle + the system prompt + the live UW MCP state. System prompt instructs him to cite retrieved items in the `### Memory recall` section of any OBSERVATION/FLAG/ALERT output.

---

## Query-description generation

The query string that gets embedded for similarity search must be generated before the embedding call. Two options:

**Option A (cheap, deterministic):** template fill from live state.
```
f"{instrument} {pct_change_bucket} intraday {flow_vs_avg}x flow {call_or_put_skewed} {'above' if price > gamma_flip else 'below'} gamma flip {dp_tape_summary}"
```
Example: `"NVDA +1-2% intraday 1.8x flow call-skewed above gamma flip dark pool neutral"`

**Option B (better, more expensive):** short Haiku call to summarize live state in one line. Costs ~$0.001/call.

**Use A for heartbeat/observation cycles. Use B for flag/alert decisions.**

---

## Historical recall endpoint (chat-driven)

Separate from the cron-time recall. Powers James's chat queries like *"what did you think about NVDA last Thursday at 2pm?"*

```
GET /api/recall?instrument=NVDA&at=2026-04-09T18:00:00Z&window=1h
```

Returns:
- Thesis at that moment (from `ct_thesis_history`)
- All observations/flags in window
- Full reasoning blocks
- Grades (if graded)

Also supports semantic queries:
```
GET /api/recall?q=every+bearish+SPY+flag+that+was+wrong
```

Resolves via embedding search + metadata filter on grades.

---

## Budget

Memory recall runs every cron cycle (minimum 30-min cadence = 48 cycles/day × 22 trading days = ~1,050 cycles/month). Each cycle:
- ~13 instruments queried
- ~8 embedding searches per instrument
- ~3 lesson lookups per instrument

Supabase reads are essentially free. Embedding generation is the cost:
- ~1,050 cycles × 13 instruments × 1 query embedding = ~13,650 embeddings/month
- Voyage voyage-3-lite is ~$0.02/1M tokens, ~20 tokens/query = ~$0.01/month

Memory recall is essentially free. Do not optimize further.
