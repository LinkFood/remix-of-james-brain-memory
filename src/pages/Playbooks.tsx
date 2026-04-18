/**
 * Playbooks — Claude's proven, repeated setups.
 *
 * Curated weekly by ct-playbook-curator (Sunday 6:45pm ET). Each card
 * surfaces win rate, sample size, avg return, setup_criteria breakdown,
 * and a Retire button to kill a playbook whose edge has decayed.
 *
 * Sort: active rows by quality score (win_rate × sample_size) descending.
 * Retired rows are hidden (use the DB for history — not surfaced here).
 */

import { useMemo } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { BookOpen, Target, TrendingUp, Clock, Hash } from 'lucide-react';
import { toast } from 'sonner';

interface Playbook {
  id: string;
  name: string;
  description: string;
  setup_criteria: Record<string, unknown>;
  historical_win_rate: number | null;
  sample_size: number;
  avg_return_pct: number | null;
  avg_r_multiple: number | null;
  first_seen_at: string;
  last_confirmed_at: string;
  status: 'active' | 'dormant' | 'retired';
}

function fmtPct(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(digits)}%`;
}

function fmtReturn(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function fmtR(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}R`;
}

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    const now = Date.now();
    const diffDays = Math.floor((now - d.getTime()) / 86400_000);
    if (diffDays === 0) return 'today';
    if (diffDays === 1) return '1d ago';
    if (diffDays < 7) return `${diffDays}d ago`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
    if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
    return `${Math.floor(diffDays / 365)}y ago`;
  } catch {
    return iso;
  }
}

/**
 * Flatten setup_criteria into a list of { label, value } rows. Unknown /
 * malformed keys are still surfaced (debug-friendly). Arrays render as
 * comma-joined strings; nested objects get JSON-stringified as a fallback.
 */
function criteriaBullets(criteria: Record<string, unknown>): Array<{ label: string; value: string }> {
  if (!criteria || typeof criteria !== 'object') return [];
  const order = ['direction', 'regime', 'session', 'evidence_axes', 'instruments', 'catalyst', 'iv_tier', 'extras'];
  const seen = new Set<string>();
  const rows: Array<{ label: string; value: string }> = [];

  const push = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    const v = criteria[key];
    if (v == null) return;
    let value: string;
    if (Array.isArray(v)) value = v.map((x) => String(x)).join(', ');
    else if (typeof v === 'object') value = JSON.stringify(v);
    else value = String(v);
    if (!value) return;
    rows.push({ label: key, value });
  };

  for (const k of order) push(k);
  for (const k of Object.keys(criteria)) push(k);
  return rows;
}

function qualityScore(pb: Playbook): number {
  const win = pb.historical_win_rate ?? 0;
  return win * pb.sample_size;
}

function directionColor(direction: string | undefined): string {
  if (direction === 'bullish') return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30';
  if (direction === 'bearish') return 'bg-red-500/15 text-red-400 border-red-500/30';
  return 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30';
}

function PlaybookCard({ pb, onRetire, isRetiring }: {
  pb: Playbook;
  onRetire: (id: string, name: string) => void;
  isRetiring: boolean;
}) {
  const direction = pb.setup_criteria?.direction as string | undefined;
  const bullets = criteriaBullets(pb.setup_criteria ?? {});

  return (
    <Card className="p-4 flex flex-col gap-3 bg-card/50 border-border/60">
      {/* Header — name + direction + retire button */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-foreground truncate">{pb.name}</h3>
            {direction && (
              <Badge variant="outline" className={`text-[10px] uppercase tracking-wider ${directionColor(direction)}`}>
                {direction}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{pb.description}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 h-7 text-[10px] border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-300"
          onClick={() => onRetire(pb.id, pb.name)}
          disabled={isRetiring}
        >
          Retire
        </Button>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Target className="w-3 h-3 text-primary" />
          <span>
            <span className="text-foreground font-medium">{fmtPct(pb.historical_win_rate, 0)}</span>{' '}
            win
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Hash className="w-3 h-3 text-primary" />
          <span>
            <span className="text-foreground font-medium">n={pb.sample_size}</span>
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <TrendingUp className="w-3 h-3 text-primary" />
          <span>
            <span className="text-foreground font-medium">{fmtReturn(pb.avg_return_pct)}</span>
            {pb.avg_r_multiple != null && (
              <span className="text-muted-foreground/70"> · {fmtR(pb.avg_r_multiple)}</span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Clock className="w-3 h-3 text-primary" />
          <span className="truncate" title={`first ${fmtDate(pb.first_seen_at)} · last ${fmtDate(pb.last_confirmed_at)}`}>
            last <span className="text-foreground font-medium">{fmtDate(pb.last_confirmed_at)}</span>
          </span>
        </div>
      </div>

      {/* Setup criteria bullet list */}
      {bullets.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 mb-1.5">
            Setup criteria
          </div>
          <ul className="space-y-1">
            {bullets.map(({ label, value }) => (
              <li key={label} className="text-xs flex gap-2">
                <span className="text-muted-foreground min-w-[90px] shrink-0">{label}</span>
                <span className="text-foreground/80 break-words">{value}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

export function Playbooks() {
  const queryClient = useQueryClient();

  const { data: playbooks, isLoading, error } = useQuery<Playbook[]>({
    queryKey: ['ct_playbooks_active'],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ct_playbooks')
        .select('id, name, description, setup_criteria, historical_win_rate, sample_size, avg_return_pct, avg_r_multiple, first_seen_at, last_confirmed_at, status')
        .eq('status', 'active')
        .order('sample_size', { ascending: false })
        .order('historical_win_rate', { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as Playbook[];
    },
  });

  // Sort client-side by true quality score — DB ordering above is a close
  // approximation but doesn't multiply the two fields.
  const sorted = useMemo(() => {
    if (!playbooks) return [];
    return [...playbooks].sort((a, b) => qualityScore(b) - qualityScore(a));
  }, [playbooks]);

  const retireMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('ct_playbooks')
        .update({ status: 'retired' })
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ct_playbooks_active'] });
    },
  });

  const handleRetire = (id: string, name: string) => {
    if (!confirm(`Retire playbook "${name}"? It will no longer be cited by the watcher.`)) return;
    retireMutation.mutate(id, {
      onSuccess: () => toast.success(`Retired: ${name}`),
      onError: (e) => toast.error(`Retire failed: ${e instanceof Error ? e.message : 'unknown'}`),
    });
  };

  return (
    <div className="min-h-screen bg-background text-foreground p-4">
      <div className="max-w-[1400px] mx-auto space-y-4">
        <header>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <BookOpen className="w-6 h-6 text-primary" />
            <span className="text-primary">Playbooks</span>
            <span className="text-sm text-muted-foreground font-normal">
              Proven setups — curated weekly from graded outcomes
            </span>
          </h1>
          <p className="text-xs text-muted-foreground mt-1.5">
            {sorted.length} active {sorted.length === 1 ? 'playbook' : 'playbooks'}
            {' · sorted by quality score (win_rate × sample_size)'}
          </p>
        </header>

        {isLoading && (
          <div className="text-sm text-muted-foreground">Loading playbooks…</div>
        )}

        {error && (
          <Card className="p-4 border-red-500/30 bg-red-500/5">
            <div className="text-sm text-red-400">
              Failed to load playbooks: {error instanceof Error ? error.message : 'unknown error'}
            </div>
          </Card>
        )}

        {!isLoading && !error && sorted.length === 0 && (
          <Card className="p-6 bg-card/50">
            <div className="text-sm text-muted-foreground">
              No active playbooks yet. The curator mines new ones every Sunday at 6:45pm ET
              from graded trades + flags + alerts over the last 90 days. First runs will
              typically return "insufficient corpus" — patterns emerge as the book accumulates.
            </div>
          </Card>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {sorted.map((pb) => (
            <PlaybookCard
              key={pb.id}
              pb={pb}
              onRetire={handleRetire}
              isRetiring={retireMutation.isPending}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export default Playbooks;
