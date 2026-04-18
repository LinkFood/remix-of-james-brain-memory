/**
 * ClaudesSurprises — two-column panel of graded calls where Claude's claimed
 * odds diverged most from reality.
 *
 * LEFT: Biggest misses — Claude claimed high odds, it missed (overconfident-wrong).
 * RIGHT: Biggest wins — Claude claimed low odds, it hit (underconfident-right).
 *
 * These are the instructive grades — where intuition was furthest from outcome.
 * Each card links back to the flag/alert/james_view detail by subject_id; if
 * no detail route exists we show an ID + copy button (read-only).
 */
import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TrendingDown, TrendingUp, Copy, Check, ArrowUpRight } from 'lucide-react';
import { useClaudesSurprises, type SurpriseGrade } from '@/hooks/useClaudesSurprises';

function fmtDelta(d: number): string {
  const sign = d >= 0 ? '+' : '';
  return `${sign}${d.toFixed(1)}`;
}

function fmtReturn(r: number): string {
  const sign = r >= 0 ? '+' : '';
  return `${sign}${r.toFixed(2)}%`;
}

function fmtClaimedOdds(g: SurpriseGrade): string {
  // Show whichever odds corresponds to the claimed direction.
  const dir = (g.claimed_direction || '').toLowerCase();
  if (dir.includes('bull') && g.claimed_odds_up != null) {
    return `${Math.round(g.claimed_odds_up)}%`;
  }
  if (dir.includes('bear') && g.claimed_odds_down != null) {
    return `${Math.round(g.claimed_odds_down)}%`;
  }
  // Fallback: whichever side was claimed.
  if (g.claimed_odds_up != null) return `${Math.round(g.claimed_odds_up)}%`;
  if (g.claimed_odds_down != null) return `${Math.round(g.claimed_odds_down)}%`;
  return '—';
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

/** Best-effort detail route. /flag/:id and /alert/:id don't exist in the
 *  router yet, so we link to `/scorecard#grade-<id>` for now — harmless
 *  anchor, gives future-us a target, and we still expose the raw ID + copy. */
function subjectHref(g: SurpriseGrade): string {
  return `/scorecard#${g.subject_type}-${g.subject_id}`;
}

function IdWithCopy({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // swallow — clipboard may be unavailable in some contexts
    }
  };
  return (
    <button
      onClick={onCopy}
      className="inline-flex items-center gap-1 text-[10px] font-mono text-muted-foreground hover:text-foreground transition-colors"
      title={`Copy ${id}`}
    >
      <span className="truncate max-w-[88px]">{id.slice(0, 8)}…</span>
      {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
    </button>
  );
}

interface SurpriseCardProps {
  grade: SurpriseGrade;
  tone: 'miss' | 'win';
}

function SurpriseCard({ grade: g, tone }: SurpriseCardProps) {
  const isMiss = tone === 'miss';
  const borderClass = isMiss
    ? 'border-red-500/30 bg-red-500/5'
    : 'border-green-500/30 bg-green-500/5';
  const deltaClass = isMiss ? 'text-red-400' : 'text-green-400';
  const dirArrow = g.claimed_direction.toLowerCase().includes('bear') ? '↓' : '↑';
  const actualArrow =
    g.actual_direction === 'bearish' ? '↓' : g.actual_direction === 'bullish' ? '↑' : '→';

  return (
    <div className={`rounded border px-2.5 py-2 text-xs ${borderClass}`}>
      <div className="flex items-center gap-2">
        <span className="font-mono font-semibold text-foreground">{g.instrument}</span>
        <Badge
          variant="outline"
          className="text-[9px] px-1 py-0 text-muted-foreground border-muted"
        >
          {g.subject_type}
        </Badge>
        <span className={`ml-auto font-mono font-bold ${deltaClass}`}>
          Δ {fmtDelta(g.calibration_delta)}
        </span>
      </div>

      <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
        <span>
          claimed{' '}
          <span className="text-foreground font-mono">
            {dirArrow} {fmtClaimedOdds(g)}
          </span>
        </span>
        <span className="text-muted-foreground/50">·</span>
        <span>
          actual{' '}
          <span
            className={`font-mono ${g.actual_return_pct >= 0 ? 'text-green-400' : 'text-red-400'}`}
          >
            {actualArrow} {fmtReturn(g.actual_return_pct)}
          </span>
        </span>
      </div>

      <div className="mt-1.5 flex items-center gap-2 text-[10px] text-muted-foreground">
        <a
          href={subjectHref(g)}
          className="inline-flex items-center gap-0.5 hover:text-foreground transition-colors"
          title={`Open ${g.subject_type} detail`}
        >
          open <ArrowUpRight className="w-2.5 h-2.5" />
        </a>
        <span className="text-muted-foreground/50">·</span>
        <IdWithCopy id={g.subject_id} />
        <span className="ml-auto">{fmtDate(g.graded_at)}</span>
      </div>
    </div>
  );
}

function EmptyState({ tone }: { tone: 'miss' | 'win' }) {
  return (
    <div className="rounded border border-dashed border-muted bg-muted/10 px-3 py-6 text-center">
      <p className="text-xs text-muted-foreground leading-relaxed">
        No surprises yet in this category — Claude's{' '}
        {tone === 'miss' ? 'overconfident' : 'underconfident'} calls are
        well-calibrated or too few graded.
      </p>
    </div>
  );
}

export function ClaudesSurprises() {
  const { data, isLoading } = useClaudesSurprises();

  const misses = data?.biggest_misses ?? [];
  const wins = data?.biggest_wins ?? [];

  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
        <TrendingDown className="w-3 h-3" />
        Claude's Surprises
        <span className="normal-case tracking-normal text-muted-foreground/70">
          — where claimed odds diverged most from outcome (last 30d)
        </span>
        {data && (
          <span className="ml-auto normal-case tracking-normal font-mono">
            n={data.sample}
          </span>
        )}
      </div>
      <p className="text-[10px] text-muted-foreground mb-3 leading-relaxed">
        The most instructive grades. Large negative Δ = claimed high odds, missed.
        Large positive Δ = claimed low odds, hit.
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* LEFT — biggest misses (overconfident-wrong) */}
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-red-400">
            <TrendingDown className="w-3 h-3" />
            Biggest misses
            <span className="text-muted-foreground font-normal normal-case">
              — overconfident, wrong
            </span>
            <span className="ml-auto font-mono text-muted-foreground">
              {misses.length}
            </span>
          </div>
          {isLoading ? (
            <div className="text-xs text-muted-foreground py-4 text-center">
              loading…
            </div>
          ) : misses.length === 0 ? (
            <EmptyState tone="miss" />
          ) : (
            <div className="space-y-1.5">
              {misses.map((g) => (
                <SurpriseCard key={g.id} grade={g} tone="miss" />
              ))}
            </div>
          )}
        </div>

        {/* RIGHT — biggest wins (underconfident-right) */}
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-green-400">
            <TrendingUp className="w-3 h-3" />
            Biggest wins
            <span className="text-muted-foreground font-normal normal-case">
              — underconfident, right
            </span>
            <span className="ml-auto font-mono text-muted-foreground">
              {wins.length}
            </span>
          </div>
          {isLoading ? (
            <div className="text-xs text-muted-foreground py-4 text-center">
              loading…
            </div>
          ) : wins.length === 0 ? (
            <EmptyState tone="win" />
          ) : (
            <div className="space-y-1.5">
              {wins.map((g) => (
                <SurpriseCard key={g.id} grade={g} tone="win" />
              ))}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

export default ClaudesSurprises;
