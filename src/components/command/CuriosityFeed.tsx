/**
 * CuriosityFeed — Proactive Claude findings panel.
 *
 * Shows the last 20 ct_curiosity_findings rows — each one a self-directed
 * investigation where Claude decided the tape was worth a deeper look beyond
 * what the scheduled watcher pulled. Timeline cards: time, question, finding
 * (truncated, click to expand), attention_score badge, actionable flag.
 *
 * Refreshes every 60s. Sits alongside EventFeed/NewsFeed as a peer feed.
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ChevronDown, ChevronUp, Lightbulb, Zap } from 'lucide-react';

interface CuriosityFinding {
  id: string;
  created_at: string;
  question: string;
  finding: string;
  attention_score: number | null;
  mcp_calls: number;
  actionable: boolean;
  related_instruments: string[];
  cost_usd: number;
}

function relTime(iso: string): string {
  const d = Date.now() - Date.parse(iso);
  const m = Math.floor(d / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function attentionColor(score: number | null): string {
  if (score == null) return 'bg-muted text-muted-foreground';
  if (score >= 80) return 'bg-red-500/15 text-red-400 border-red-500/30';
  if (score >= 60) return 'bg-amber-500/15 text-amber-400 border-amber-500/30';
  if (score >= 40) return 'bg-sky-500/15 text-sky-400 border-sky-500/30';
  return 'bg-muted/50 text-muted-foreground border-muted';
}

function leftBorder(score: number | null): string {
  if (score == null) return 'border-l-muted-foreground';
  if (score >= 80) return 'border-l-red-500';
  if (score >= 60) return 'border-l-amber-500';
  if (score >= 40) return 'border-l-sky-500';
  return 'border-l-muted-foreground';
}

function FindingRow({ f }: { f: CuriosityFinding }) {
  const [expanded, setExpanded] = useState(false);
  const truncated = f.finding.length > 220 ? f.finding.slice(0, 217) + '…' : f.finding;

  return (
    <div className={`p-3 border-l-2 ${leftBorder(f.attention_score)} hover:bg-muted/30 transition-colors`}>
      <div className="flex items-start gap-2">
        <Lightbulb className="w-3 h-3 text-primary mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-xs mb-1 flex-wrap">
            <span className="font-mono font-semibold text-foreground uppercase text-[10px]">curiosity</span>
            {f.related_instruments.length > 0 && (
              <span className="font-semibold text-foreground">{f.related_instruments.join(', ')}</span>
            )}
            {f.attention_score != null && (
              <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${attentionColor(f.attention_score)}`}>
                attn {f.attention_score}
              </Badge>
            )}
            {f.actionable && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-green-500/15 text-green-400 border-green-500/30">
                <Zap className="w-2.5 h-2.5 mr-0.5" /> actionable
              </Badge>
            )}
            <span className="text-[10px] text-muted-foreground ml-auto">{relTime(f.created_at)}</span>
          </div>

          <div className="text-xs text-foreground/90 font-medium italic mb-1">
            Q: {f.question}
          </div>

          <div className="text-xs text-foreground/80 whitespace-pre-wrap leading-relaxed">
            {expanded ? f.finding : truncated}
          </div>

          <div className="mt-1 flex items-center gap-3">
            {f.finding.length > 220 && (
              <button
                onClick={() => setExpanded((v) => !v)}
                className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-0.5"
              >
                {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                {expanded ? 'collapse' : 'expand'}
              </button>
            )}
            <span className="text-[9px] text-muted-foreground font-mono ml-auto">
              {f.mcp_calls} MCP · ${f.cost_usd.toFixed(4)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function CuriosityFeed() {
  const { data: findings, isLoading } = useQuery<CuriosityFinding[]>({
    queryKey: ['ct_curiosity_findings'],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ct_curiosity_findings')
        .select('id, created_at, question, finding, attention_score, mcp_calls, actionable, related_instruments, cost_usd')
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as CuriosityFinding[];
    },
  });

  return (
    <Card className="divide-y divide-border">
      <div className="px-3 py-2 border-b border-border bg-muted/30 sticky top-0 z-10 flex items-center gap-2">
        <Lightbulb className="w-3 h-3 text-primary" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground">Curiosity</h3>
        <span className="text-[10px] text-muted-foreground">proactive · :07 / :37 · haiku + UW MCP</span>
      </div>
      {isLoading ? (
        <div className="p-6 text-center text-sm text-muted-foreground">loading…</div>
      ) : !findings || findings.length === 0 ? (
        <div className="p-6 text-center text-sm text-muted-foreground">
          no findings yet — Claude skips cleanly when the tape is quiet
        </div>
      ) : (
        <div className="max-h-[60vh] overflow-y-auto divide-y divide-border">
          {findings.map((f) => (
            <FindingRow key={f.id} f={f} />
          ))}
        </div>
      )}
    </Card>
  );
}
