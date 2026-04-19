/**
 * DecisionLogFeed — row 4 of Claude's State dashboard.
 *
 * Scrolling list of the last N ct_claude_decisions rows. Each entry gets a
 * color-coded decision_type chip, model_tier, 1-line reasoning, and a link
 * to the linked entity where relevant.
 *
 * This is the Day-3 tenet made visible: every decision Claude makes is
 * captured and glanceable.
 */
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Activity, ExternalLink } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useRecentDecisions, type ClaudeDecisionRow } from '@/hooks/useClaudeState';

function chipClass(decisionType: string): string {
  switch (decisionType) {
    case 'propose_hypothesis':
    case 'update_hypothesis':
    case 'promote_playbook':
      return 'bg-blue-500/15 text-blue-400 border-blue-500/40';
    case 'arm_trade_idea':
      return 'bg-amber-500/15 text-amber-400 border-amber-500/40';
    case 'no_trade':
    case 'size_override':
      return 'bg-muted/50 text-muted-foreground border-muted';
    case 'fill_trade':
      return 'bg-green-500/15 text-green-400 border-green-500/40';
    case 'close_trade':
      return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/40';
    case 'hallucination_flagged':
    case 'circuit_breaker_tripped':
    case 'invalidate_hypothesis':
      return 'bg-red-500/15 text-red-400 border-red-500/40';
    case 'circuit_breaker_cleared':
      return 'bg-green-500/15 text-green-400 border-green-500/40';
    case 'brief_generated':
    case 'brief_rebriefed':
    case 'breaking_news_processed':
      return 'bg-violet-500/15 text-violet-400 border-violet-500/40';
    case 'reflection':
    case 'stress_check':
    case 'evidence_tagged':
    case 'trade_journal':
    case 'retire_hypothesis':
    default:
      return 'bg-card text-muted-foreground border-border';
  }
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

function linkTarget(d: ClaudeDecisionRow): { label: string; kind: string } | null {
  if (d.linked_hypothesis_id) return { label: 'thesis', kind: 'hypothesis' };
  if (d.linked_trade_idea_id) return { label: 'idea', kind: 'trade_idea' };
  if (d.linked_trade_id) return { label: 'trade', kind: 'trade' };
  if (d.linked_brief_id) return { label: 'brief', kind: 'brief' };
  return null;
}

export function DecisionLogFeed() {
  const { data: decisions = [], isLoading } = useRecentDecisions(15);
  const navigate = useNavigate();

  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground mb-3">
        <Activity className="w-3 h-3" />
        <span>Decision log</span>
        <span className="ml-auto font-mono">{decisions.length}</span>
        <button
          type="button"
          onClick={() => navigate('/workspace?view=decisions')}
          className="text-[10px] text-primary hover:underline flex items-center gap-0.5"
        >
          see all <ExternalLink className="w-2.5 h-2.5" />
        </button>
      </div>

      {isLoading ? (
        <div className="text-xs text-muted-foreground">loading...</div>
      ) : decisions.length === 0 ? (
        <div className="text-xs text-muted-foreground italic">
          No decisions recorded yet. The journal fills as Claude runs.
        </div>
      ) : (
        <div className="divide-y divide-border max-h-[420px] overflow-y-auto">
          {decisions.map((d) => {
            const link = linkTarget(d);
            return (
              <div key={d.id} className="py-1.5 flex items-start gap-2 text-[11px]">
                <span className="font-mono text-muted-foreground shrink-0 w-8">
                  {timeAgo(d.created_at)}
                </span>
                <Badge
                  variant="outline"
                  className={`text-[9px] px-1 py-0 h-4 shrink-0 ${chipClass(d.decision_type)}`}
                  title={d.decision_type}
                >
                  {d.decision_type.replace(/_/g, ' ')}
                </Badge>
                <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 shrink-0 uppercase font-mono">
                  {d.model_tier}
                </Badge>
                {d.hallucination_flag && (
                  <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 shrink-0 bg-red-500/15 text-red-400 border-red-500/40">
                    halluc
                  </Badge>
                )}
                <span className="text-muted-foreground leading-snug line-clamp-2 flex-1">
                  {d.reasoning}
                </span>
                {link && (
                  <span className="text-[10px] text-muted-foreground shrink-0">
                    → {link.label}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
