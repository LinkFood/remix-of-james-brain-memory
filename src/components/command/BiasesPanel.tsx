/**
 * BiasesPanel — Claude's self-identified structural blindspots.
 *
 * ct_biases is written weekly by ct-bias-booth (Sunday 22:00 UTC) from
 * 30d of grades + self-regrades. The watcher + morning-brief READ these
 * before every call so Claude sees its own blindspots first. Surfacing
 * them here makes the feedback loop visible — and lets James veto any
 * he disagrees with via a retire button (soft-delete → active=false).
 *
 * Sorted severity desc, then last_confirmed desc. Top 10.
 *
 * Source function: only ct-bias-booth writes this table. The `evidence`
 * text on each bias cites the upstream grade IDs and self-regrade quotes
 * that triggered the pattern — we surface that text on row expand.
 */
import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AlertOctagon, ChevronDown, ChevronRight, X } from 'lucide-react';
import { useBiases, useRetireBias, type Bias } from '@/hooks/useBiases';
import { toast } from 'sonner';

/** severity → color class for the row pattern text + dots */
function severityColor(sev: number): string {
  if (sev >= 5) return 'text-red-400';
  if (sev === 4) return 'text-orange-400';
  if (sev === 3) return 'text-amber-400';
  if (sev === 2) return 'text-muted-foreground';
  return 'text-muted-foreground/60';
}

function dotsColor(sev: number): string {
  if (sev >= 5) return 'text-red-400';
  if (sev === 4) return 'text-orange-400';
  if (sev === 3) return 'text-amber-400';
  if (sev === 2) return 'text-muted-foreground';
  return 'text-muted-foreground/50';
}

function Dots({ sev }: { sev: number }) {
  const filled = Math.max(0, Math.min(5, sev));
  return (
    <span className={`font-mono text-[11px] ${dotsColor(sev)}`} title={`severity ${sev}/5`}>
      {'●'.repeat(filled)}
      <span className="text-muted-foreground/30">{'○'.repeat(5 - filled)}</span>
    </span>
  );
}

function formatAge(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return '1d';
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

export function BiasesPanel() {
  const { data: biases, isLoading } = useBiases(10);
  const retire = useRetireBias();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const handleRetire = async (id: string, pattern: string) => {
    try {
      await retire.mutateAsync(id);
      toast.success('Bias retired', { description: pattern.slice(0, 80) });
    } catch (e) {
      toast.error('Retire failed', {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <Card className="divide-y divide-border">
      <div className="px-4 py-3 border-b border-border bg-muted/20 flex items-center gap-2">
        <AlertOctagon className="w-4 h-4 text-primary" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground">Claude's Biases</h3>
        <span className="text-[10px] text-muted-foreground ml-auto">
          self-identified blindspots · weekly
        </span>
      </div>

      {isLoading ? (
        <div className="p-4 text-xs text-muted-foreground">loading…</div>
      ) : !biases || biases.length === 0 ? (
        <div className="p-4 text-xs text-muted-foreground leading-relaxed">
          No active biases. Either Claude's calibrated or hasn't self-audited yet.
        </div>
      ) : (
        <div className="divide-y divide-border">
          {biases.map((b) => (
            <BiasRow
              key={b.id}
              bias={b}
              expanded={expandedId === b.id}
              onToggle={() => setExpandedId((prev) => (prev === b.id ? null : b.id))}
              onRetire={() => handleRetire(b.id, b.pattern)}
              retiring={retire.isPending && retire.variables === b.id}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

interface BiasRowProps {
  bias: Bias;
  expanded: boolean;
  onToggle: () => void;
  onRetire: () => void;
  retiring: boolean;
}

function BiasRow({ bias, expanded, onToggle, onRetire, retiring }: BiasRowProps) {
  // Retire only allowed after a 3-day window — gives Claude a chance to
  // self-correct (supersede or retire via the next bias-booth run)
  // before James overrides.
  const canRetire = bias.active && bias.age_days > 3;

  return (
    <div className="group">
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-3 py-2.5 flex items-start gap-2 text-left hover:bg-muted/30 transition-colors"
      >
        <span className="mt-0.5 text-muted-foreground/60 group-hover:text-foreground transition-colors">
          {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        </span>
        <span className={`flex-1 text-[12px] leading-snug ${severityColor(bias.severity)}`}>
          {bias.pattern}
        </span>
        <span className="flex-shrink-0 flex items-center gap-2 text-[10px] text-muted-foreground font-mono pt-0.5">
          <Dots sev={bias.severity} />
          <span title={`first seen ${new Date(bias.first_seen_at).toLocaleDateString()}`}>
            {formatAge(bias.age_days)}
          </span>
          <span title="observed count across grades + regrades">
            n={bias.observed_count ?? 0}
          </span>
        </span>
      </button>

      {expanded && (
        <div className="px-6 pb-3 space-y-2 text-[11px] leading-relaxed">
          {bias.instruments && bias.instruments.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {bias.instruments.map((sym) => (
                <Badge key={sym} variant="outline" className="font-mono text-[10px]">
                  {sym}
                </Badge>
              ))}
            </div>
          )}

          <div>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Evidence
            </span>
            <p className="mt-0.5 text-foreground/85 whitespace-pre-wrap">{bias.evidence}</p>
          </div>

          <div className="flex items-center gap-3 pt-1 text-[10px] text-muted-foreground">
            <span>
              source: <span className="font-mono text-foreground/70">{bias.source}</span>
            </span>
            <span>·</span>
            <span>
              last confirmed {formatAge(Math.floor((Date.now() - new Date(bias.last_confirmed).getTime()) / 86_400_000))} ago
            </span>
          </div>

          {canRetire ? (
            <div className="pt-1">
              <Button
                size="sm"
                variant="outline"
                onClick={(e) => {
                  e.stopPropagation();
                  onRetire();
                }}
                disabled={retiring}
                className="h-7 text-[10px]"
              >
                <X className="w-3 h-3 mr-1" />
                {retiring ? 'retiring…' : 'retire this bias'}
              </Button>
              <p className="mt-1 text-[10px] text-muted-foreground/70 italic">
                marks inactive — watcher stops seeing it on next tick
              </p>
            </div>
          ) : bias.active ? (
            <p className="pt-1 text-[10px] text-muted-foreground/70 italic">
              retire available after 3 days ({3 - bias.age_days}d left) — giving Claude time to self-correct first
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
