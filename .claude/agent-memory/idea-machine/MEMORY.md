# Idea Machine Memory -- JAC Agent OS

## Project Context
- Location: `/Users/jameschellis/jac-agent-os`
- Stack: React 18, TS, Vite, Tailwind, ShadCN, Supabase (realtime), Supabase edge functions
- UI: Command Center at `/jac` -- AgentRoster, JacChat, ActivityFeed, AgentResultsFeed
- Agents: JAC (dispatcher), research, save, search, code agents
- Data flow: useJacAgent hook -> Supabase realtime -> tasks/logs/conversations
- Agent output shape: `{ brief, sources, brainEntryId }` on task.output

## Key Data Infrastructure (for dashboard ideas)
- `brain_insights` table: AI cron (10AM + 8PM Central) generates pattern/overdue/stale/schedule/suggestion insights via Claude Haiku; 3-day expiry; up to 5 per run
- `entry_relationships`: semantic similarity links between entries (similarity_score float, relationship_type)
- `useProactiveInsights`: fetches top insight, shows ONE banner, dismissible per day via localStorage
- `useJacDashboard`: sends NL query -> returns insightCard, surfaceEntryIds, highlightEntryIds, connections, clusters -- "Jac takes over" mode dims normal dashboard
- Importance scoring (1-10), content type classification (code/list/idea/link/contact/event/reminder/note)
- Tags, starred, archived flags on entries
- QuickStats: total thoughts, streak, days active this week, hot tag, stale important count
- StatsGrid: total entries, today count, important count, starred count
- Currently only 1 insight shown at a time, rest buried

## Key User Phrases / Intent
- "OpenClaw office" -- wants agents to feel spatially present, not just badges
- "Build like Claude Code" -- streaming text, visible reasoning, step-by-step trace
- "Drive like Subaru but Ferrari engine" -- calm reliable UI, wild power underneath
- "Agents need their own dump" -- agents showing their work, not task metadata
- "There's no intelligence to it; it's just where stuff gets dumped in" -- re: dashboard
- "JAC should synthesize what I've been saying or doing" -- wants AI-first dashboard

## Session: UX Unification (2026-02-28)
- Problem: siloed tabs (/jac, /code, /dashboard, /settings) require constant switching
- UX Overhaul SHIPPED: Nerve Center (split layout), Ticker (bottom bar), Artifacts (inline chat cards)
- Key insight: "The chat IS the navigation" -- context panel reacting to conversation content

## Session: Smart Dashboard (2026-02-28)
- Problem: /dashboard is a "dumb filing cabinet" -- dump box, stat cards, chronological sections
- Current layout top-to-bottom: JacInsightCard (if active) -> ProactiveInsightBanner (1 max) -> DumpInput (sticky mobile) -> ReminderBanner -> QuickStats -> StatsGrid -> TagFilter -> Sections (Upcoming, Today, Important, Lists, Code, Ideas, Recent)
- 7 collapsible sections, each showing filtered entries by type/date/importance
- brain_insights generates up to 5 per cron run, but only 1 shown via useProactiveInsights
- entry_relationships exist in DB but NOT surfaced anywhere in dashboard UI
- "Jac takes over" mode exists but requires explicit NL query via chat bubble
- User wants: intelligence front-and-center, less dead space, keep dump box + filing cabinet accessible

## Ideas That Landed (track reactions here)
- Nerve Center, Ticker, Artifacts all shipped from UX Unification session

## Ideas Pitched (2026-03-01, post-Brain Evolution session)
- JAC Morning Brief (daily Slack synthesis cron)
- Conversation Threads as Brain Objects (auto-save sessions to entries, type "session")
- Drift Detection (weekly entity-level decay cron, surfaces abandoned projects)
- Agent Show Your Work Trace Panel (live activity_log stream in ContextPanel)
- JAC Asks You Questions Back (post-task Haiku hook + inline Yes/No/Later card)
- Situation Room widget (JAC self-awareness: cost, principles violations, topic analysis)
- Slack as Voting Booth (Slack Block Kit interactive buttons for JAC's proactive decisions)

## Ideas Dismissed
- Velocity Heatmap, Ghost Mode (user dropped them)

## Co-Trader Pivot (Apr 2026)
- JAC Agent OS paused; repo now hosts Co-Trader at linkjac.cloud
- [Co-Trader state snapshot](project_cotrader_state_2026_04_17.md) — what's already built, don't re-pitch
- [Co-Trader idea themes](feedback_cotrader_idea_themes.md) — self-awareness, commitment devices, ghost P&L, analogy memory

## Ideas Pitched (2026-04-17, Co-Trader pre-market session)
- Pre-Bell Gauntlet (locked 9:25 predictions graded at 10/11/close)
- Ghost Positions (auto paper book shadowing every Trade Card)
- "Why Am I Different Today?" Panel (embedding-analogy to past setups)
- Conviction Decay Curve (15min restated conviction vs price path)
- Slack Whisper Mode (tap-to-log ALERT replies feed ct_disagreements)
- Calendar Hook (AFK-aware alert escalation via JAC calendar)
- Bias Confession Booth (weekly structural-wrongness injected as SYSTEM context)
- Counterfactual Replay (post-miss Claude re-read with hindsight)
- Cross-Source "Who Else Sees This?" (Tavily/UW social corroboration filter)
- Voice Trading Journal as Brain Object (ElevenLabs dictation, embedded)
- Red Team Agent (adversarial Claude in Trade Cards)
- DCD Environmental Crossover (pipe market as domain into DCD narrator)
- "What Would You Ask For?" Loop (ct_wishlist of missing data)

## Session: Rounding Off (2026-03-04)
- User wants to "round everything else off" before adding new codebases
- Key gaps found in code review:
  - CompactDumpInput on Dashboard ONLY saves to brain -- no JAC dispatch path
  - GlobalSearch (Cmd+K) only searches entries, not JAC commands
  - Voice input exists in old DumpInput but NOT in JacChat or CompactDumpInput
  - Insights are dismiss-only -- no action buttons ("Research this", "Remind me", etc.)
  - entry_relationships surfaced in TheWireWidget + BrainInspector but no action hooks
  - DriftRadar has onNavigate but no "nudge" or "remind me" actions
  - Calendar has no quick-add from anywhere except the Calendar page itself
  - useKeyboardShortcuts has 4 bindings only (K, N, /, ?)
  - Settings page is bare -- no JAC personality config, no model preferences, no notification scheduling
  - Conversational memory Phase 1 done but no session boundaries or episode UI
  - 20 widgets but layout is localStorage-only, no cloud sync/sharing

## Aesthetic Signals
- Likes: dark terminal feel, functional density, real-time feedback
- Dislikes: gimmicky office metaphors (wants practical not literal)
- Claude Code reference = streaming output with visible reasoning steps is the gold standard
