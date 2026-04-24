/**
 * /patterns — Mined flow signatures + graded outcomes per specialist.
 *
 * Reads ct_flag_patterns. Each row = one (specialist_ticker, signature_hash)
 * bucket with n_observations, hit_rate, avg_alpha_pct, and last_seen_at.
 *
 * Click a row to expand and see the last 5 flag IDs sharing that signature
 * with their grades — the receipts for the hit-rate number.
 *
 * Patterns emerge after 3+ graded flags share the same signature; default
 * list filter is n >= 5 to show only statistically meaningful rows.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Slider } from '@/components/ui/slider';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { Target, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';

const SPECIALISTS = ['SPY','QQQ','IWM','AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA'];

type SortKey = 'hit_rate' | 'n_observations' | 'avg_alpha_pct' | 'last_seen_at';

interface FlagPattern {
  id: string;
  specialist_ticker: string;
  signature_hash: string;
  signature: {
    specialist_ticker?: string;
    direction?: string;
    tags?: string[];
    score_bucket?: number;
  } | null;
  n_observations: number;
  n_wins: number;
  n_partials: number;
  n_losses: number;
  hit_rate: number | null;
  avg_alpha_pct: number | null;
  last_seen_at: string | null;
  updated_at: string;
}

interface RecentFlag {
  id: string;
  created_at: string;
  direction: string | null;
  status: string | null;
  score: number | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  grade?: { outcome: string | null; alpha_pct: number | null } | null;
}

function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v == null) return '—';
  const s = v >= 0 ? '+' : '';
  return `${s}${v.toFixed(digits)}%`;
}

function fmtHitRate(v: number | null | undefined): string {
  if (v == null) return '—';
  // hit_rate stored 0..1
  return `${(v * 100).toFixed(0)}%`;
}

function hitRateColor(v: number | null): string {
  if (v == null) return 'text-muted-foreground';
  const pct = v * 100;
  if (pct >= 60) return 'text-emerald-400 font-semibold';
  if (pct >= 40) return 'text-amber-400';
  return 'text-red-400';
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return '—';
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

function decodeSignature(sig: FlagPattern['signature']): string {
  if (!sig) return '(no signature)';
  const parts: string[] = [];
  if (sig.direction) parts.push(sig.direction);
  if (sig.tags && sig.tags.length > 0) parts.push(sig.tags.join(' + '));
  if (typeof sig.score_bucket === 'number') {
    const lo = sig.score_bucket;
    const hi = lo + 9;
    parts.push(`score ${lo}-${hi}`);
  }
  return parts.length > 0 ? parts.join(' · ') : '(empty signature)';
}

function directionBadge(dir: string | null | undefined): { label: string; className: string } {
  if (dir === 'bullish') return { label: 'bull', className: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' };
  if (dir === 'bearish') return { label: 'bear', className: 'bg-red-500/15 text-red-400 border-red-500/30' };
  return { label: dir ?? '—', className: 'bg-muted text-muted-foreground border-border' };
}

function outcomeColor(outcome: string | null | undefined): string {
  if (outcome === 'win') return 'text-emerald-400';
  if (outcome === 'partial') return 'text-amber-400';
  if (outcome === 'loss') return 'text-red-400';
  return 'text-muted-foreground';
}

/**
 * Last 5 flags sharing this signature + their grades. Rendered lazily when
 * the user expands a row — we don't want to pull recent flags for every row
 * on initial load.
 */
function RecentFlagsForSignature({
  specialist,
  signatureHash,
}: {
  specialist: string;
  signatureHash: string;
}) {
  const navigate = useNavigate();
  const { data: flags, isLoading } = useQuery<RecentFlag[]>({
    queryKey: ['ct_flags_by_signature', specialist, signatureHash],
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await supabase
        .from('ct_flags' as never)
        .select('id, created_at, direction, status, score, ct_flag_grades(outcome, alpha_pct)')
        .eq('specialist_ticker', specialist)
        .eq('signature_hash', signatureHash)
        .order('created_at', { ascending: false })
        .limit(5);
      if (error) throw error;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return ((data ?? []) as any[]).map((r) => ({
        id: r.id,
        created_at: r.created_at,
        direction: r.direction,
        status: r.status,
        score: r.score,
        grade: Array.isArray(r.ct_flag_grades) ? (r.ct_flag_grades[0] ?? null) : (r.ct_flag_grades ?? null),
      }));
    },
    staleTime: 60_000,
  });

  if (isLoading) {
    return <div className="text-xs text-muted-foreground px-3 py-2">Loading recent flags…</div>;
  }
  if (!flags || flags.length === 0) {
    return <div className="text-xs text-muted-foreground px-3 py-2">No recent flags found for this signature.</div>;
  }

  return (
    <div className="border-t border-border/50 bg-muted/10">
      <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground/70">
        last {flags.length} flag{flags.length > 1 ? 's' : ''} for this signature
      </div>
      <div className="divide-y divide-border/50">
        {flags.map((f) => {
          const dirBadge = directionBadge(f.direction);
          return (
            <div
              key={f.id}
              className="px-3 py-1.5 flex items-center gap-3 text-xs hover:bg-muted/20 transition-colors cursor-pointer"
              onClick={() => navigate(`/flags?id=${f.id}`)}
              role="button"
            >
              <span className="font-mono text-muted-foreground w-20 truncate" title={f.id}>
                {f.id.slice(0, 8)}…
              </span>
              <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-mono border', dirBadge.className)}>
                {dirBadge.label}
              </span>
              <span className="text-muted-foreground tabular-nums">
                {f.score != null ? f.score.toFixed(0) : '—'}
              </span>
              <span className="text-muted-foreground">{timeAgo(f.created_at)}</span>
              <span className={cn('ml-auto font-mono', outcomeColor(f.grade?.outcome))}>
                {f.grade?.outcome ?? '(ungraded)'}
              </span>
              {f.grade?.alpha_pct != null && (
                <span className={cn('tabular-nums', outcomeColor(f.grade?.outcome))}>
                  {fmtPct(f.grade.alpha_pct, 2)}
                </span>
              )}
              <ExternalLink className="w-3 h-3 text-muted-foreground/50" />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function Patterns() {
  const [specialist, setSpecialist] = useState<string>('all');
  const [minObs, setMinObs] = useState<number>(5);
  const [sortKey, setSortKey] = useState<SortKey>('hit_rate');
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data: patterns, isLoading } = useQuery<FlagPattern[]>({
    queryKey: ['ct_flag_patterns', specialist, minObs, sortKey],
    queryFn: async () => {
      let q = supabase
        .from('ct_flag_patterns' as never)
        .select('*')
        .gte('n_observations', minObs)
        .order(sortKey, { ascending: false, nullsFirst: false })
        .limit(100);
      if (specialist !== 'all') q = q.eq('specialist_ticker', specialist);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as FlagPattern[];
    },
    refetchInterval: 60_000,
  });

  const totalWithEnoughObs = useMemo(() => patterns?.length ?? 0, [patterns]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-[1400px] mx-auto p-4 space-y-4">
        <header>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Target className="w-5 h-5 text-primary" />
            <span>Patterns</span>
            <span className="text-sm text-muted-foreground font-normal">
              mined flow signatures + graded outcomes per specialist
            </span>
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            {totalWithEnoughObs} pattern{totalWithEnoughObs === 1 ? '' : 's'} with n &gt;= {minObs} observation{minObs === 1 ? '' : 's'}.
            Patterns emerge after 3+ graded flags sharing the same signature.
          </p>
        </header>

        {/* Filter strip */}
        <Card className="p-3 flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Specialist</span>
            <Select value={specialist} onValueChange={setSpecialist}>
              <SelectTrigger className="h-7 w-28 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                {SPECIALISTS.map((t) => (
                  <SelectItem key={t} value={t}>{t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-2 min-w-[180px]">
            <span className="text-xs text-muted-foreground whitespace-nowrap">Min n</span>
            <Slider
              value={[minObs]}
              min={3}
              max={30}
              step={1}
              onValueChange={(v) => setMinObs(v[0] ?? 5)}
              className="w-32"
            />
            <span className="text-xs font-mono tabular-nums w-6">{minObs}</span>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Sort</span>
            <Select value={sortKey} onValueChange={(v) => setSortKey(v as SortKey)}>
              <SelectTrigger className="h-7 w-36 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="hit_rate">Hit rate</SelectItem>
                <SelectItem value="n_observations">Observations</SelectItem>
                <SelectItem value="avg_alpha_pct">Avg alpha</SelectItem>
                <SelectItem value="last_seen_at">Last seen</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </Card>

        {/* Pattern list */}
        {isLoading && !patterns ? (
          <Card className="p-8 text-center text-sm text-muted-foreground">Loading patterns…</Card>
        ) : !patterns || patterns.length === 0 ? (
          <Card className="p-8 text-center text-sm text-muted-foreground">
            No patterns discovered yet. Patterns emerge after 3+ graded flags sharing the same signature.
          </Card>
        ) : (
          <Card className="divide-y divide-border/50 overflow-hidden">
            {patterns.map((p) => {
              const isOpen = expanded === p.id;
              const dir = p.signature?.direction;
              const dirBadge = directionBadge(dir);
              const decoded = decodeSignature(p.signature);
              return (
                <div key={p.id}>
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : p.id)}
                    className="w-full px-3 py-2.5 flex items-center gap-3 hover:bg-muted/20 transition-colors text-left"
                  >
                    {isOpen ? (
                      <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    )}

                    <Badge variant="outline" className="font-mono text-[10px] shrink-0 w-14 justify-center">
                      {p.specialist_ticker}
                    </Badge>

                    <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-mono border shrink-0', dirBadge.className)}>
                      {dirBadge.label}
                    </span>

                    <span className="text-xs truncate flex-1 min-w-0" title={decoded}>
                      {decoded}
                    </span>

                    <div className="flex items-center gap-4 shrink-0 text-xs tabular-nums">
                      <div className="flex flex-col items-end leading-tight">
                        <span className={cn('font-mono', hitRateColor(p.hit_rate))}>
                          {fmtHitRate(p.hit_rate)}
                        </span>
                        <span className="text-[9px] text-muted-foreground">hit</span>
                      </div>

                      <div className="flex flex-col items-end leading-tight">
                        <span className="font-mono text-muted-foreground">
                          {p.n_observations}
                        </span>
                        <span className="text-[9px] text-muted-foreground">
                          {p.n_wins}w/{p.n_partials}p/{p.n_losses}l
                        </span>
                      </div>

                      <div className="flex flex-col items-end leading-tight w-14">
                        <span className={cn(
                          'font-mono',
                          p.avg_alpha_pct == null
                            ? 'text-muted-foreground'
                            : p.avg_alpha_pct > 0 ? 'text-emerald-400' : 'text-red-400'
                        )}>
                          {fmtPct(p.avg_alpha_pct, 2)}
                        </span>
                        <span className="text-[9px] text-muted-foreground">alpha</span>
                      </div>

                      <div className="flex flex-col items-end leading-tight w-12">
                        <span className="font-mono text-muted-foreground">{timeAgo(p.last_seen_at)}</span>
                        <span className="text-[9px] text-muted-foreground">seen</span>
                      </div>
                    </div>
                  </button>

                  {isOpen && (
                    <RecentFlagsForSignature
                      specialist={p.specialist_ticker}
                      signatureHash={p.signature_hash}
                    />
                  )}
                </div>
              );
            })}
          </Card>
        )}

        <div className="text-[10px] text-muted-foreground leading-relaxed">
          Hit rate colors: emerald &gt;= 60%, amber 40-60%, red &lt; 40%. Observations = wins / partials / losses.
          Avg alpha = mean of per-flag alpha vs SPY at horizon. Click a row to see the last 5 flag IDs sharing this signature.
          Refreshes every 60s.
        </div>
      </div>
    </div>
  );
}
