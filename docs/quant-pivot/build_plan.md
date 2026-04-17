# Co-Trader Build Plan — 7-8 days

**Target:** linkjac.cloud pivot from paused personal OS → Claude co-trader command station.
**Thesis doc:** see `project_jac_pivot_co_trader_thesis_2026_04_16.md` in memory.
**Sibling docs:** `system_prompt_v1.md`, `schema.md`, `memory_recall.md`.

---

## Pre-flight (before Day 1)

- [ ] Confirm TrendSpider tier supports `request.http()` in custom indicators (for phase 2, not blocking MVP)
- [ ] **Sign up Unusual Whales API Basic, monthly billing, $150/mo** (NOT the $50/week trial — trial only makes sense for ≤2 weeks; monthly is cheaper for any real validation window). Capture `UW_API_KEY`.
- [ ] Add `UW_API_KEY` to Supabase Vault
- [ ] Verify existing JAC Vault keys are live: `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`
- [ ] `cd /Users/jameschellis/jac-agent-os && df -h /` — disk check
- [ ] Read `jac-agent-os/CLAUDE.md` one more time for project conventions

**After month 1 of live running:** if co-trader earns its keep, switch UW to annual ($1500 upfront, locks in $125/mo, saves $300/year). If not working, cancel, $150 total sunk.

---

## Day 1 — Schema + UW MCP connection

**Goal:** tables live, MCP wired, first successful data pull.

Files touched:
- `supabase/migrations/20260417000001_ct_schema.sql` — all tables from schema.md
- `supabase/migrations/20260417000002_ct_indexes.sql` — indexes from schema.md
- `supabase/functions/_shared/uwClient.ts` — thin wrapper over UW MCP (or UW REST if MCP client in Deno is messy)
- `supabase/functions/ct-watcher/index.ts` — stub cron function (just pulls state, logs, returns)
- `supabase/config.toml` — add `[functions.ct-watcher]` with `verify_jwt = false`

End-of-day verification:
- [ ] All `ct_*` tables visible via REST
- [ ] `ct-watcher` deployed, invokable
- [ ] One successful UW pull for all 13 instruments logged
- [ ] Heartbeat row written to `ct_heartbeats`

---

## Day 2 — Watcher cron + voice v1

**Goal:** Claude actually makes decisions. Slack dripping flags.

Files touched:
- `supabase/functions/_shared/memoryRecall.ts` — per memory_recall.md
- `supabase/functions/_shared/systemPromptV1.ts` — export the v1 prompt as a constant
- `supabase/functions/_shared/ctEmbed.ts` — Voyage wrapper for ct_embeddings
- `supabase/functions/ct-watcher/index.ts` — full implementation
  - Pull live state (13 instruments)
  - Build memory bundle per instrument
  - Call Claude with v1 prompt
  - Parse state (HEARTBEAT/OBSERVATION/FLAG/ALERT)
  - Write to appropriate table + ct_embeddings
  - Slack push for FLAG conv≥3 or ALERT
- `supabase/functions/_shared/slackPush.ts` — adapt existing JAC slack bot for ct channel
- `pg_cron` schedule: `ct-watcher` every 30min during 13:00-21:00 UTC on weekdays

End-of-day verification:
- [ ] Run watcher manually, full output to DB
- [ ] At least one of each state (heartbeat/obs/flag/alert) produced on demand
- [ ] Slack channel `#claude-cotrader` receiving pushes
- [ ] Voice sounds right — review 3-5 outputs, compare against system_prompt_v1.md calibration examples

---

## Day 3 — Grader + thesis history

**Goal:** every flag gets scored. Thesis evolution logged.

Files touched:
- `supabase/functions/ct-grader/index.ts` — cron, runs every 15min
  - Find `ct_flags` + `ct_alerts` + `ct_james_views` with `horizon_end < now()` and `grade_id is null`
  - Pull actual outcome via UW quote history (or Tradier free if UW doesn't have historical bars)
  - Compute % return over horizon
  - Compare to claimed direction
  - Write `ct_grades` row, update `grade_id`
- `supabase/functions/_shared/thesisUpdate.ts` — called from watcher when thesis changes
  - Writes to `ct_thesis_history` before in-place update of `ct_theses`
- `supabase/functions/ct-disagreement-materializer/index.ts` — cron, every 30min
  - Find overlapping james+claude active views on same instrument+horizon with different directions
  - Insert `ct_disagreements` row
  - Flag for grading at horizon_end

End-of-day verification:
- [ ] Manually insert a flag with 1h horizon, wait 1h, verify grader scores it
- [ ] Update a thesis manually, verify history row written
- [ ] Post a james_view via SQL that disagrees with an active flag, verify disagreement row materialized

---

## Day 4 — News + lessons + EOD recap

**Goal:** corpus enrichment + curation + daily summary.

Files touched:
- `supabase/functions/ct-news-ingester/index.ts` — cron, every 15min
  - Pull news from UW news endpoint for 13 instruments
  - For each new item: send to Claude for analysis (separate lighter prompt)
  - Write `ct_news_analyses` + embedding
- `supabase/functions/ct-lessons-curator/index.ts` — cron, weekly (Sunday evening)
  - Pull all `ct_observations` + graded `ct_flags` from past week
  - Call Claude with lessons-curation prompt (ADD/SUPERSEDE/SKIP pattern)
  - Write `ct_lessons` entries
  - Supersede prior lessons where applicable
- `supabase/functions/ct-eod-recap/index.ts` — cron, 21:30 UTC weekdays
  - Pull today's flags + observations + grades + key news
  - Call Claude with recap prompt (Doc's-style: summary + decomposition + rabbit hole)
  - Write `ct_reports` entry
  - Slack push with glance summary + link to full on linkjac
- `docs/quant-pivot/prompt_lessons_curator.md` — the lessons prompt
- `docs/quant-pivot/prompt_eod_recap.md` — the recap prompt

End-of-day verification:
- [ ] Trigger news ingest manually, at least 1 ticker with news analysis
- [ ] Trigger lessons curation with last week's data (even if sparse)
- [ ] Trigger EOD recap, verify structured output + Slack push

---

## Day 5 — Command station UI (Part 1)

**Goal:** the site shows Claude's current state.

Files touched:
- `src/pages/CommandStation.tsx` — new primary route (replace old dashboard)
- `src/components/command/MarketBanner.tsx` — top strip, regime read + SPX GEX chart
- `src/components/command/GexProfileChart.tsx` — Recharts bar chart
- `src/components/command/TickerCard.tsx` — with glance/expand
- `src/components/command/TickerGrid.tsx` — 13-card grid layout
- `src/hooks/useCommandStation.ts` — data fetching + realtime subscription
- `src/lib/queries/ct.ts` — Supabase queries for ct_* tables
- Routing: `/` routes to CommandStation, old dashboard moved to `/legacy`

End-of-day verification:
- [ ] Open linkjac.cloud in browser, see market banner + 13 ticker cards
- [ ] Each card shows current thesis + glance bullets + expand button
- [ ] Expand reveals full reasoning block
- [ ] Realtime: manually insert a flag via SQL, see it appear on card within 2s

---

## Day 6 — Command station UI (Part 2) + chat

**Goal:** intraday feed, chat with memory, historical recall.

Files touched:
- `src/components/command/IntradayFeed.tsx` — sidebar feed of observations/flags/alerts
- `src/components/command/ChatBox.tsx` — persistent bottom chat, integrated with existing JAC chat dispatcher
- `supabase/functions/ct-chat/index.ts` — chat handler with full MCP + memory recall context
- `supabase/functions/ct-recall/index.ts` — historical recall endpoint (semantic + time-based)
- `src/hooks/useChat.ts` — adapt existing chat hook for co-trader context
- `src/components/command/AlertBanner.tsx` — pops to top when ALERT row inserted

End-of-day verification:
- [ ] Intraday feed scrolls new events as they arrive
- [ ] Chat box works: ask "what did you think about NVDA at 10am?" returns historical reasoning
- [ ] Chat box works: ask "how's your record on bearish SPY flags?" returns scorecard slice
- [ ] Insert ALERT row, verify top banner pops

---

## Day 7 — Scorecard + recap views

**Goal:** the review surfaces.

Files touched:
- `src/pages/Scorecard.tsx` — `/scorecard` route
  - Overall precision (claimed direction hit rate)
  - Confidence calibration chart (stated odds vs actual hit rate per bucket)
  - Per-instrument precision
  - Per-regime precision (if we have regime tagging — stub for now)
  - Recent blind spots (Claude's self-identified patterns of error)
- `src/pages/Recaps.tsx` — `/recap` route
  - List of EOD reports
  - Weekly report summary
  - Disagreement log (james vs claude resolutions)
- `src/components/scorecard/CalibrationChart.tsx`
- `src/components/scorecard/PrecisionTable.tsx`
- Update navigation: CommandStation `/` + Scorecard `/scorecard` + Recaps `/recap` + Chat `/chat` (existing) + Legacy `/legacy`

End-of-day verification:
- [ ] Scorecard page renders with real data (will be thin after 1 week but structure should work)
- [ ] Calibration chart shows stated odds buckets vs actuals
- [ ] Recap page lists EOD entries, click to expand full report

---

## Day 8 (buffer) — System prompt iteration + polish

**Goal:** one day of running live, review voice drift, fix what's off.

- Review ~50 outputs from the first day of running
- Check voice consistency against calibration examples
- Check state distribution (heartbeat should dominate; flags rare; alerts very rare)
- Check memory recall usage — is Claude actually citing past setups?
- Adjust system prompt if needed → bump to v1.1, update version tag
- Add `docs/quant-pivot/prompt_changelog.md` entry
- Polish any rough UI edges
- Set up backups + retention crons per schema.md

---

## Deferred (not in MVP)

- TrendSpider custom JS indicator (push GEX + flags to his charts) — phase 2
- Voice alerts via ElevenLabs — phase 2 if desired (ElevenLabs key exists)
- Quarterly self-assessment reports — schedule after 3 months of data
- Options chain visualization on site — probably never (TrendSpider has it)
- Mobile-optimized UI — desktop-first, mobile later

---

## Gotchas to respect (from CLAUDE.md + memory)

- Pin `@supabase/supabase-js@2.84.0` — unpinned crashes Deno isolates
- `verify_jwt = false` in `config.toml` for every new function
- Default import only from `npm:` packages in Deno
- Never batch embed more than 20 entries — Voyage times out
- pg_cron delimiters: `$cron$` outer, `$body$` inner — never `$$`
- Never use `vector(512)` directly — `extensions.vector(512)` with `SET search_path = public, extensions`
- `vault.decrypted_secrets` for pg_cron auth, not string concat
- Always redeploy all functions importing `_shared/*` when a shared module changes
- Respect THE EMBEDDING LAW: every new fusion item → Voyage → ct_embeddings

---

## Success criteria after Day 8

- Watcher cron has been running for 1+ day, ~96 cycles
- Distribution: ~70-80% heartbeat, ~15-25% observations, ~3-8% flags, 0-2 alerts
- At least one flag has been graded (horizon close reached)
- At least one observation has been retrieved via memory recall inside a subsequent watcher cycle
- Claude's voice sounds consistent with calibration examples
- James can read the command station in 30s and understand state
- James can chat with Claude about current state AND historical state via memory recall

If all of the above → greenlight week 2 of operation, evaluate tweaks, commit to longer run.
If not → diagnose, fix, don't move on until the foundation is solid.

---

## After Day 8 — the compound phase

The build is "done." The product gets better by running. Each week:
- Lessons compendium grows and curates
- Grader backlog fills with scored calls
- Memory recall gets richer (more similar setups to retrieve)
- Claude's self-assessment reports identify patterns

**This is the whole thesis.** The system compounds because Claude writes his own history, and that history becomes his teacher.
