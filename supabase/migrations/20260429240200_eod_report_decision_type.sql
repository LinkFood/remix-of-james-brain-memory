-- =============================================================================
-- 20260429240200_eod_report_decision_type.sql
--
-- Extend ct_claude_decisions.decision_type CHECK list with 'eod_report_generated'
-- so ct-eod-report can stamp its journal rows with the right semantic kind
-- instead of overloading 'reflection'.
-- =============================================================================
SET search_path = public, extensions;

ALTER TABLE public.ct_claude_decisions
  DROP CONSTRAINT IF EXISTS ct_claude_decisions_decision_type_check;

ALTER TABLE public.ct_claude_decisions
  ADD CONSTRAINT ct_claude_decisions_decision_type_check
  CHECK (decision_type IN (
    'propose_hypothesis','arm_trade_idea','no_trade',
    'fill_trade','close_trade','update_hypothesis',
    'invalidate_hypothesis','promote_playbook',
    'retire_hypothesis','brief_generated','brief_rebriefed',
    'breaking_news_processed','circuit_breaker_tripped',
    'circuit_breaker_cleared','reflection','stress_check',
    'evidence_tagged','trade_journal','size_override',
    'hallucination_flagged','eod_report_generated'
  ));
