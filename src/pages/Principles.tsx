/**
 * Principles — Viewer for Claude's distilled operating principles.
 *
 * jac_principles is written weekly by distill-principles (Sonnet, Sunday
 * 3 AM UTC) from rolling jac_reflections. Each row is a compound lesson
 * across multiple reflections. The memory-recall layer pulls these into
 * every watcher / morning-brief tick — so what shows up here is what
 * Claude is ACTIVELY weighing on its next call.
 *
 * Read-only except for two actions:
 *   acknowledge — James confirms he's read & agrees. UI-only flag.
 *   retire      — Soft-delete. Sets retired_at=now(); watcher stops
 *                 weighing it on the next tick.
 *
 * Complements /scorecard's BiasesPanel. Biases = what to AVOID.
 * Principles = what to DO. Cross-link at page bottom.
 */

import { useMemo, useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Compass, Search, X, AlertOctagon, CheckCircle2, ExternalLink,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  usePrinciplesFull,
  useAcknowledgePrinciple,
  useRetirePrinciple,
  type JacPrinciple,
} from '@/hooks/usePrinciples';

type FilterMode = 'all' | 'unread' | 'severe';

function dotsColor(sev: number): string {
  if (sev >= 5) return 'text-red-400';
  if (sev === 4) return 'text-orange-400';
  if (sev === 3) return 'text-amber-400';
  if (sev === 2) return 'text-muted-foreground';
  return 'text-muted-foreground/50';
}

function SeverityDots({ sev }: { sev: number | null }) {
  const filled = Math.max(0, Math.min(5, sev ?? 3));
  return (
    <span className={`font-mono text-[11px] ${dotsColor(sev ?? 3)}`} title={`severity ${sev ?? 3}/5`}>
      {'\u25CF'.repeat(filled)}
      <span className="text-muted-foreground/30">{'\u25CB'.repeat(5 - filled)}</span>
    </span>
  );
}

function PrincipleCard({
  p,
  onToggleAck,
  onRetire,
  ackPending,
  retirePending,
}: {
  p: JacPrinciple;
  onToggleAck: (id: string, value: boolean) => void;
  onRetire: (id: string, preview: string) => void;
  ackPending: boolean;
  retirePending: boolean;
}) {
  const [showSources, setShowSources] = useState(false);
  const sourceCount = p.source_reflection_ids?.length ?? 0;
  const ack = p.acknowledged === true;

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-start gap-3">
        <div className="pt-0.5">
          <Checkbox
            checked={ack}
            disabled={ackPending}
            onCheckedChange={(v) => onToggleAck(p.id, v === true)}
            aria-label={ack ? 'Mark as unread' : 'Acknowledge principle'}
          />
        </div>

        <div className="flex-1 min-w-0 space-y-2">
          <p className={`text-sm font-semibold leading-snug ${ack ? 'text-muted-foreground' : 'text-foreground'}`}>
            {p.principle}
          </p>

          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            {p.category && (
              <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
                {p.category}
              </Badge>
            )}
            <SeverityDots sev={p.severity} />
            <button
              type="button"
              onClick={() => setShowSources((prev) => !prev)}
              className="text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1"
              disabled={sourceCount === 0}
              title={sourceCount === 0 ? 'No source reflections' : 'Show source reflection IDs'}
            >
              derived from {sourceCount} reflection{sourceCount === 1 ? '' : 's'}
              {sourceCount > 0 && <ExternalLink className="w-3 h-3" />}
            </button>
            <span className="text-muted-foreground/70 font-mono">
              conf {(p.confidence ?? 0).toFixed(2)} · applied {p.times_applied ?? 0}x
            </span>
            <span className={`ml-auto inline-flex items-center gap-1 text-[10px] ${ack ? 'text-emerald-400' : 'text-amber-400'}`}>
              {ack ? <CheckCircle2 className="w-3 h-3" /> : null}
              {ack ? 'read' : 'unread'}
            </span>
          </div>

          {showSources && sourceCount > 0 && (
            <div className="rounded-md bg-muted/30 p-2 space-y-1">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                source reflections
              </div>
              <ul className="space-y-0.5">
                {p.source_reflection_ids!.map((rid) => (
                  <li key={rid}>
                    <Link
                      to={`/brain?reflectionId=${rid}`}
                      className="font-mono text-[10px] text-foreground/70 hover:text-primary transition-colors"
                    >
                      {rid}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="pt-1">
            <Button
              size="sm"
              variant="outline"
              onClick={() => onRetire(p.id, p.principle.slice(0, 80))}
              disabled={retirePending}
              className="h-7 text-[10px]"
            >
              <X className="w-3 h-3 mr-1" />
              {retirePending ? 'retiring…' : 'retire'}
            </Button>
            <span className="ml-2 text-[10px] text-muted-foreground/70 italic">
              watcher stops weighing it on next tick
            </span>
          </div>
        </div>
      </div>
    </Card>
  );
}

function EmptyState({ reason }: { reason: string }) {
  return (
    <Card className="p-8 text-center space-y-2">
      <Compass className="w-6 h-6 mx-auto text-muted-foreground/60" />
      <p className="text-sm text-muted-foreground">{reason}</p>
    </Card>
  );
}

export default function Principles() {
  const navigate = useNavigate();
  const [userId, setUserId] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterMode>('all');

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session?.user) {
        navigate('/auth');
        return;
      }
      setUserId(session.user.id);
    });
  }, [navigate]);

  const { data: principles, isLoading } = usePrinciplesFull(userId);
  const ack = useAcknowledgePrinciple();
  const retire = useRetirePrinciple();

  const filtered = useMemo(() => {
    if (!principles) return [];
    const q = query.trim().toLowerCase();
    return principles.filter((p) => {
      if (filter === 'unread' && p.acknowledged === true) return false;
      if (filter === 'severe' && (p.severity ?? 0) < 4) return false;
      if (q && !p.principle.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [principles, query, filter]);

  /** Group filtered principles by category. Uncategorized under "General". */
  const grouped = useMemo(() => {
    const map = new Map<string, JacPrinciple[]>();
    for (const p of filtered) {
      const cat = p.category?.trim() || 'General';
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(p);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  const totalActive = principles?.length ?? 0;
  const unreadCount = principles?.filter((p) => p.acknowledged !== true).length ?? 0;

  const handleToggleAck = async (id: string, value: boolean) => {
    try {
      await ack.mutateAsync({ id, value });
    } catch (e) {
      toast.error('Update failed', {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const handleRetire = async (id: string, preview: string) => {
    try {
      await retire.mutateAsync(id);
      toast.success('Principle retired', { description: preview });
    } catch (e) {
      toast.error('Retire failed', {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
        {/* Header */}
        <header className="space-y-2">
          <div className="flex items-center gap-2">
            <Compass className="w-5 h-5 text-primary" />
            <h1 className="text-xl font-semibold">Principles</h1>
            <span className="text-xs text-muted-foreground ml-2">
              {totalActive} active · {unreadCount} unread
            </span>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed max-w-2xl">
            Compound lessons distilled weekly from your reflections. These principles are
            actively informing Claude's decisions — the watcher pulls them into every tick.
            Retire one and it stops weighing it on the next call.
          </p>
        </header>

        {/* Controls */}
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search principles…"
              className="pl-8 h-8 text-xs"
            />
          </div>
          <div className="flex gap-1">
            {(['all', 'unread', 'severe'] as FilterMode[]).map((f) => (
              <Button
                key={f}
                type="button"
                size="sm"
                variant={filter === f ? 'default' : 'outline'}
                onClick={() => setFilter(f)}
                className="h-8 text-[11px] capitalize"
              >
                {f === 'severe' ? 'severity ≥ 4' : f}
              </Button>
            ))}
          </div>
        </div>

        {/* Body */}
        {isLoading ? (
          <Card className="p-6 text-xs text-muted-foreground">loading…</Card>
        ) : !principles || principles.length === 0 ? (
          <EmptyState reason="No principles yet. The distiller runs weekly — check back after Sunday 3 AM UTC once you have reflections to distill from." />
        ) : filtered.length === 0 ? (
          <EmptyState reason="No principles match the current filter." />
        ) : (
          <div className="space-y-6">
            {grouped.map(([category, items]) => (
              <section key={category} className="space-y-2">
                <h2 className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-2">
                  <span>{category}</span>
                  <span className="text-muted-foreground/50">· {items.length}</span>
                </h2>
                <div className="space-y-2">
                  {items.map((p) => (
                    <PrincipleCard
                      key={p.id}
                      p={p}
                      onToggleAck={handleToggleAck}
                      onRetire={handleRetire}
                      ackPending={ack.isPending && ack.variables?.id === p.id}
                      retirePending={retire.isPending && retire.variables === p.id}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}

        {/* Cross-link to Biases */}
        <Card className="p-4 bg-muted/20 border-dashed">
          <div className="flex items-start gap-3">
            <AlertOctagon className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
            <div className="text-xs text-muted-foreground leading-relaxed">
              <span className="font-medium text-foreground">Related: </span>
              Principles are what to DO. <Link to="/scorecard" className="text-primary hover:underline">Biases</Link> are
              what to AVOID — Claude's self-identified blindspots, surfaced weekly on the
              Scorecard page. Both feed the watcher prompt on every tick.
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
