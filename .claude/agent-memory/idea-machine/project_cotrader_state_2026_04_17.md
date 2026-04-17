---
name: Co-Trader state snapshot (2026-04-17)
description: What exists in linkjac.cloud Co-Trader as of Apr 17 market-open prep — don't re-pitch these
type: project
---

Co-Trader (linkjac.cloud) is the active build. JAC Agent OS proper is paused; the repo now hosts Co-Trader.

**Already built (do NOT re-pitch):**
- ct-watcher (15min cron, HEARTBEAT discipline, OBSERVATION/FLAG/ALERT)
- ct-flow-ingester (3min), ct-news-ingester (20min), ct-event-watcher (1min trigger)
- GEX timeseries, NOPE minute, Greek flow, dark pool, IV rank, max pain
- ct-grader (15min), ct-self-grader (2h), ct-news-causality (15min)
- ct-disagreement-materializer (10min), ct-morning-brief, ct-eod-recap/positioning, ct-lessons-curator (Sundays)
- Voyage 512-dim embeddings on every OBSERVATION/FLAG
- Command Station UI fully laid out (hero, 8-col left, 4-col right, bottom 2-col)
- Docked chat with live UW MCP access + MCP call inspector panel
- Scorecard page with calibration, ghost trade tape, breakdowns
- Voice toggle (ElevenLabs)

**Why:** User calls these out as "already built, don't suggest" — re-pitching burns credibility.

**How to apply:** When brainstorming, build ON TOP of this infra rather than suggesting it. Tables `ct_observations`, `ct_grades`, `ct_self_regrades`, `ct_disagreements`, `ct_heartbeats`, `ct_flow_alerts`, `ct_news_analyses`, GEX timeseries are the primitives available for remixing.

**Constraints locked:** Same Supabase, single repo, no new vendors, no new DBs, solo dev.

**Core edge thesis:** (1) live MCP access to UW during chat, (2) persistent memory of past observations so Claude learns its own biases, (3) event-triggered watcher within 90s, (4) cross-pollination with JAC brain (calendar, code, research, Slack, voice).
