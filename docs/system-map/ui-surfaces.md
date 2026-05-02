# UI Surfaces — Pages and Hooks

Generated 2026-05-01.
- Pages: 33
- Hooks: 105

## Pages

| page | route | hooks_used | tables_queried (transitively) | status |
| --- | --- | --- | --- | --- |
| ActivityLog | `-` | useActivityLog | `agent_tasks` | WIRED |
| Agents | `-` | useAgentStats | `agent_tasks` | WIRED |
| Alarms | `-` | useAlarms, useSlackToggleStatus | - | WIRED |
| Auth | `-` | use-toast | - | STATIC |
| BrainInspector | `-` | useBrainEntities, useBrainGraph, usePrinciples | `entries` | WIRED |
| Budget | `-` | - | - | EMPTY-PAGE (no hooks; renders only static or sub-components) |
| Calendar | `-` | use-toast, useCalendarEntries, useEntryActions | `entries` | WIRED |
| CodeWorkspace | `-` | useCodeWorkspace | `agent_tasks` | WIRED |
| CostDashboard | `-` | useCostDashboard | `ct_chat_tokens`, `ct_claude_usage`, `ct_grades`, `ct_trades`, `ct_uw_usage`, `ct_uw_usage_latest` | WIRED |
| CronJobs | `-` | useCronJobs, useWatches | `agent_tasks`, `user_settings` | WIRED |
| CtSettings | `-` | - | - | EMPTY-PAGE (no hooks; renders only static or sub-components) |
| Dashboard | `-` | useSandboxLayout | - | WIRED |
| Detectors | `-` | useDetectorScoreboard | - | WIRED |
| Edge | `-` | useContractTracks, useDteEligibility, useEdge | `ct_config` | WIRED |
| Eod | `-` | - | - | EMPTY-PAGE (no hooks; renders only static or sub-components) |
| EodReport | `-` | useEodReport | - | WIRED |
| Flags | `-` | - | - | EMPTY-PAGE (no hooks; renders only static or sub-components) |
| Health | `-` | useHealthData, useWatcherObservability | `ct_alerts`, `ct_attention_stream`, `ct_book`, `ct_claude_usage_today`, `ct_heartbeats`, +4 more | WIRED |
| Heatmap | `-` | useFlowHeatmap | - | WIRED |
| Jac | `-` | - | - | EMPTY-PAGE (no hooks; renders only static or sub-components) |
| Landing | `-` | - | - | STATIC |
| MorningBrief | `-` | useMorningBrief | - | WIRED |
| NotFound | `-` | - | - | STATIC |
| Patterns | `-` | - | - | EMPTY-PAGE (no hooks; renders only static or sub-components) |
| Privacy | `-` | - | - | STATIC |
| Pulse | `-` | - | - | EMPTY-PAGE (no hooks; renders only static or sub-components) |
| Reports | `-` | useReports | - | WIRED |
| Search | `-` | useSearchPage | - | WIRED |
| Settings | `-` | - | - | EMPTY-PAGE (no hooks; renders only static or sub-components) |
| Specialists | `-` | useSpecialistScoreboard | - | WIRED |
| Tape | `-` | useAlarmRealtime, useContractStacking, useContractTracks, useDteEligibility, useTickerIntradayContext | `ct_config` | WIRED |
| TapeReader | `-` | - | - | EMPTY-PAGE (no hooks; renders only static or sub-components) |
| Terms | `-` | - | - | STATIC |

## Hooks

| hook | tables_queried | rpcs_called | pages | components |
| --- | --- | --- | --- | --- |
| `use-toast` | - | - | Auth, Calendar | JacChat, toaster, use-toast |
| `useActivityLog` | `agent_tasks` | - | ActivityLog | - |
| `useActivityTracker` | - | - | - | ActivityTrackingProvider |
| `useAgentStats` | `agent_tasks` | - | Agents | - |
| `useAlarmRealtime` | - | - | Tape | AlarmBanner |
| `useAlarms` | - | - | Alarms | - |
| `useAlertPostMortems` | `ct_alert_post_mortems` | - | - | AlertPostMortemsPanel |
| `useAttentionLeaderboard` | `ct_alerts`, `ct_flags`, `ct_observations` | - | - | - |
| `useAxisAttribution` | `ct_alerts`, `ct_flags`, `ct_grades` | - | - | AlertPostMortemsPanel, AxisAttributionPanel |
| `useBiases` | - | - | - | - |
| `useBookEquityCurve` | `ct_book`, `ct_trades` | `current_claude_generation` | - | - |
| `useBrainEntities` | - | - | BrainInspector | - |
| `useBrainGraph` | `entries` | - | BrainInspector | - |
| `useBreakingNews` | - | - | - | NewsFeed |
| `useBulkSelection` | - | - | - | - |
| `useCalendarEntries` | `entries` | - | Calendar | CalendarWidget, CreateEventModal |
| `useCalibration` | `ct_alerts`, `ct_flags`, `ct_grades` | - | - | CalibrationChart |
| `useCellAnalogs` | - | `ct_cell_analogs` | - | FlowHeatmapDrill |
| `useClaudeBook` | `ct_book`, `ct_trade_ideas`, `ct_trades` | - | - | ClaudesBookTab, DivergenceTab, JamesVsClaudeBalances, LiveActionStrip, TradeLogTab |
| `useClaudeGeneration` | `ct_claude_generations` | `current_claude_generation` | - | DecisionLogFeed, GenerationStatusCard, LineageTab, StatusStrip |
| `useClaudeState` | `ct_book`, `ct_claude_circuit_breakers`, `ct_claude_decisions`, `ct_claude_heartbeat`, `ct_daily_briefs`, `ct_hypotheses`, `ct_james_reviews`, `ct_trade_ideas`, `ct_trades` | - | - | BriefSummaryCard, DecisionLogFeed, LiveActionStrip, ReviewQueueCompact, StatusStrip |
| `useClaudesSurprises` | `ct_grades` | - | - | ClaudesSurprises |
| `useClock` | - | - | - | TopNav |
| `useCoTraderData` | `ct_alerts`, `ct_attention_stream`, `ct_book`, `ct_daily_recaps`, `ct_dark_pool_prints`, `ct_disagreements`, `ct_dp_clusters`, `ct_events`, `ct_flags`, `ct_flow_alerts`, `ct_ghost_pnl`, `ct_grades`, `ct_greek_flow_minute`, `ct_heartbeats`, `ct_iv_rank_daily`, `ct_iv_shifts`, `ct_james_views`, `ct_max_pain_daily`, `ct_morning_briefs`, `ct_net_premium_ticks`, `ct_news_analyses`, `ct_observations`, `ct_pre_bell_predictions`, `ct_regime_inversions`, `ct_reports`, `ct_self_regrades`, `ct_sweep_clusters`, `ct_theses`, `ct_trade_actions`, `ct_trades` | `ct_gex_heatmap` | - | BookSparkline, ClaudesBookTab, CommandPalette, DivergenceTab, JamesVsClaudeBalances, LiveActionStrip, TradeLogTab |
| `useCodeWorkspace` | `agent_tasks` | - | CodeWorkspace | - |
| `useColdOpen` | `ct_uw_usage_latest` | - | - | - |
| `useConcentration` | `ct_book`, `ct_trades` | `ct_config_get` | - | - |
| `useContractQuotes` | - | - | - | ContractDrillSheet |
| `useContractStacking` | - | - | Tape | StackingPatterns |
| `useContractTracks` | - | - | Edge, Tape | ContractDrillSheet, ContractGradeChips, ContractPnLChip |
| `useCostDashboard` | `ct_chat_tokens`, `ct_claude_usage`, `ct_grades`, `ct_trades`, `ct_uw_usage`, `ct_uw_usage_latest` | `ct_config_get` | CostDashboard | - |
| `useCronJobs` | - | `get_cron_status`, `toggle_cron_job` | CronJobs | - |
| `useCtKillSwitch` | `ct_kill_switch` | `ct_killswitch_disarm`, `ct_killswitch_engage` | - | KillSwitchButton |
| `useDarkPoolChart` | `ct_dark_pool_prints` | - | - | - |
| `useDashboardActivity` | `agent_tasks`, `code_sessions`, `entries` | - | - | AgentActivityWidget, AgentStatusWidget, SystemPulseWidget |
| `useDetectorFlags` | `ct_flags` | - | - | FlowHeatmapDrill, FlowHeatmapGrid |
| `useDetectorScoreboard` | - | - | Detectors | - |
| `useDrawdownAlerts` | `ct_drawdown_alerts` | - | - | - |
| `useDteEligibility` | `ct_config` | - | Edge, Tape | - |
| `useEdge` | - | `ct_contract_threshold_distribution`, `ct_signature_magnitude_stats` | Edge | - |
| `useEffectiveSessionDate` | `ct_heartbeats` | - | - | - |
| `useEntries` | `entries` | - | - | BrainEntriesWidget, TimelineView, TriageQueueWidget |
| `useEntries.test` | - | - | - | - |
| `useEntryActions` | `entries` | - | Calendar | BrainEntriesWidget, CalendarWidget, RemindersWidget, Ticker, TriageQueueWidget |
| `useEntryActions.test` | - | - | - | - |
| `useEodReport` | - | - | EodReport | - |
| `useEvLadder` | - | - | - | - |
| `useEventRecency` | `ct_breaking_news`, `ct_central_bank_rates`, `ct_earnings_moves`, `ct_events` | - | - | - |
| `useFlowHeatmap` | - | `ct_flow_heatmap_diff`, `ct_flow_heatmap_strikes` | Heatmap | FlowHeatmapDrill, FlowHeatmapGrid, FlowHeatmapPerTicker, HeatmapToolbar, heatmapColors |
| `useFlowPulse` | - | - | - | FlowHeatmapDrill, FlowHeatmapGrid, FlowPulse, FlowPulseChart, FlowPulseSparkline |
| `useFreshness` | - | - | - | FreshnessChip |
| `useGexRadar` | - | - | - | - |
| `useHealthData` | `ct_attention_stream`, `ct_book`, `ct_claude_usage_today`, `ct_mcp_calls`, `ct_trades`, `ct_uw_usage`, `ct_uw_usage_latest` | `get_cron_status` | Health | - |
| `useHeatmapMultiModeAgreement` | - | - | - | FlowHeatmapGrid |
| `useHourlyPerformance` | `ct_alerts`, `ct_flags`, `ct_grades` | - | - | HourlyPerformancePanel |
| `useHypotheses` | `ct_alerts`, `ct_flags`, `ct_grades`, `ct_hypotheses`, `ct_hypothesis_events`, `ct_hypothesis_evidence`, `ct_james_reviews` | - | - | TradeLogTab |
| `useHypothesisScorecard` | - | `ct_hypothesis_scorecard` | - | PerThesisPanel |
| `useJacAgent` | `agent_tasks` | - | - | - |
| `useJacDashboard` | - | - | - | ConnectionLines, JacInsightCard |
| `useJamesFlags` | `ct_flags` | - | - | FlowHeatmapDrill, FlowHeatmapGrid |
| `useKillSwitch` | - | - | - | TopNav |
| `useLinkGexDeep` | - | - | - | LinkGexDeep |
| `useMacroSparklines` | - | - | - | MacroBanner, MacroTile |
| `useMarketBreadth` | - | - | - | - |
| `useMarketHoursTrigger` | - | - | - | - |
| `useMonteCarloInputs` | `ct_book` | - | - | - |
| `useMorningBrief` | - | - | MorningBrief | - |
| `useNetPremiumCumulative` | - | - | - | - |
| `useNewsCausality` | `ct_breaking_news`, `ct_news_analyses`, `ct_news_causality` | - | - | FlowHeatmapDrill, FlowHeatmapGrid |
| `useOfflineQueue` | - | - | - | useDumpSave |
| `useOvernightPositioning` | - | - | - | OvernightPositioning, TickerSheet |
| `usePositionSizing` | - | - | - | - |
| `usePreBellReadiness` | `ct_biases`, `ct_book`, `ct_premarket_gaps`, `ct_reports`, `ct_trades`, `ct_ui_errors`, `ct_uw_usage_latest` | `ct_killswitch_active` | - | - |
| `usePreflightChecks` | `ct_config`, `ct_heartbeats`, `ct_kill_switch`, `ct_news_analyses`, `ct_uw_usage_latest` | `get_cron_status` | - | PreflightChip |
| `usePrinciples` | - | - | BrainInspector | PrincipleTickerWidget |
| `useProactiveInsights` | `brain_insights`, `entries` | - | - | InsightsWidget, SystemPulseWidget, TriageQueueWidget |
| `usePromptAbTest` | `ct_alerts`, `ct_flags`, `ct_grades`, `ct_heartbeats` | - | - | - |
| `useRealtimeSubscription` | - | - | - | - |
| `useRealtimeSubscription.test` | - | - | - | - |
| `useRegimeAnalogs` | `ct_events`, `ct_grades`, `ct_iv_rank_daily`, `ct_session_embeddings` | - | - | - |
| `useRegimeConditionalPerformance` | `ct_alerts`, `ct_flags`, `ct_grades`, `ct_heartbeats`, `ct_iv_rank_daily`, `ct_news_analyses` | - | - | RegimeConditionalPanel |
| `useRelatedEntries` | - | - | - | RelatedEntries |
| `useReports` | - | - | Reports | ReportsWidget |
| `useRiskMetrics` | `ct_book`, `ct_grades`, `ct_spy_daily`, `ct_trades` | - | - | - |
| `useSandboxLayout` | - | - | Dashboard | SandboxHeader |
| `useSearch` | - | - | Search | GlobalSearch |
| `useSearch.test` | - | - | - | - |
| `useSearchPage` | - | - | Search | - |
| `useSidebarState` | - | - | - | - |
| `useSlackToggleStatus` | - | - | Alarms | - |
| `useSpecialistReads` | - | - | - | FlowHeatmapDrill, TickerSheet |
| `useSpecialistScoreboard` | - | - | Specialists | - |
| `useStreaks` | `ct_grades`, `ct_trades` | - | - | StreakPanel, StreakPill |
| `useStressScenarios` | `ct_trades` | - | - | - |
| `useSubscription` | - | - | - | - |
| `useTapeReader` | `ct_tape_commentary` | - | - | - |
| `useTickerData` | `agent_tasks`, `code_sessions`, `entries` | - | - | Ticker, TopNav |
| `useTokenCounter` | `agent_tasks`, `ct_claude_usage` | - | - | TopNav |
| `useTradeAdvisories` | `ct_trade_advisories` | - | - | - |
| `useTradeJournal` | `ct_trades` | - | - | - |
| `useUpcomingReminders` | `entries` | - | - | ReminderBanner, SystemPulseWidget |
| `useVoiceAlerts` | - | - | - | - |
| `useWardenHealth` | `ct_invariant_log` | `get_warden_health` | - | SystemWardenCard |
| `useWatcherObservability` | `ct_alerts`, `ct_heartbeats` | - | Health | - |
| `useWatches` | `agent_tasks`, `user_settings` | - | CronJobs | CreateWatchDialog |

## Orphan hooks (not imported by any page or component)

Count: 34

| hook | tables_queried | rpcs_called |
| --- | --- | --- |
| `useAttentionLeaderboard` | `ct_alerts`, `ct_flags`, `ct_observations` | - |
| `useBiases` | - | - |
| `useBookEquityCurve` | `ct_book`, `ct_trades` | `current_claude_generation` |
| `useBulkSelection` | - | - |
| `useColdOpen` | `ct_uw_usage_latest` | - |
| `useConcentration` | `ct_book`, `ct_trades` | `ct_config_get` |
| `useDarkPoolChart` | `ct_dark_pool_prints` | - |
| `useDrawdownAlerts` | `ct_drawdown_alerts` | - |
| `useEffectiveSessionDate` | `ct_heartbeats` | - |
| `useEntries.test` | - | - |
| `useEntryActions.test` | - | - |
| `useEvLadder` | - | - |
| `useEventRecency` | `ct_breaking_news`, `ct_central_bank_rates`, `ct_earnings_moves`, `ct_events` | - |
| `useGexRadar` | - | - |
| `useJacAgent` | `agent_tasks` | - |
| `useMarketBreadth` | - | - |
| `useMarketHoursTrigger` | - | - |
| `useMonteCarloInputs` | `ct_book` | - |
| `useNetPremiumCumulative` | - | - |
| `usePositionSizing` | - | - |
| `usePreBellReadiness` | `ct_biases`, `ct_book`, `ct_premarket_gaps`, `ct_reports`, `ct_trades`, `ct_ui_errors`, `ct_uw_usage_latest` | `ct_killswitch_active` |
| `usePromptAbTest` | `ct_alerts`, `ct_flags`, `ct_grades`, `ct_heartbeats` | - |
| `useRealtimeSubscription` | - | - |
| `useRealtimeSubscription.test` | - | - |
| `useRegimeAnalogs` | `ct_events`, `ct_grades`, `ct_iv_rank_daily`, `ct_session_embeddings` | - |
| `useRiskMetrics` | `ct_book`, `ct_grades`, `ct_spy_daily`, `ct_trades` | - |
| `useSearch.test` | - | - |
| `useSidebarState` | - | - |
| `useStressScenarios` | `ct_trades` | - |
| `useSubscription` | - | - |
| `useTapeReader` | `ct_tape_commentary` | - |
| `useTradeAdvisories` | `ct_trade_advisories` | - |
| `useTradeJournal` | `ct_trades` | - |
| `useVoiceAlerts` | - | - |