/**
 * BriefSummaryCard — row 2 of Claude's State dashboard.
 *
 * Surfaces the latest ct_daily_briefs row. Shows macro narrative, per-ticker
 * tilt chips (horizontal scroll), convergent view, high-conviction ideas and
 * a "generated X min ago" freshness indicator with urgency badge.
 *
 * If no brief has ever been generated, renders a muted empty state. If the
 * latest brief is past its expires_at, stamps it "stale" — the brief is still
 * the best context we have, we just note it.
 */
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Newspaper, Flame, Clock, Zap } from 'lucide-react';
import { useLatestBrief } from '@/hooks/useClaudeState';

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function urgencyClass(u: string): string {
  switch (u) {
    case 'acute': return 'bg-red-500/15 text-red-400 border-red-500/40';
    case 'high': return 'bg-orange-500/15 text-orange-400 border-orange-500/40';
    case 'elevated': return 'bg-amber-500/15 text-amber-400 border-amber-500/40';
    default: return 'bg-muted text-muted-foreground border-muted';
  }
}

function getString(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  return typeof v === 'string' ? v : null;
}
function getNumber(o: Record<string, unknown>, k: string): number | null {
  const v = o[k];
  return typeof v === 'number' ? v : null;
}

export function BriefSummaryCard() {
  const { data: brief, isLoading } = useLatestBrief();

  if (isLoading) {
    return (
      <Card className="p-4 text-xs text-muted-foreground">Loading today's brief...</Card>
    );
  }

  if (!brief) {
    return (
      <Card className="p-4 space-y-2">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
          <Newspaper className="w-3 h-3" /> Today's Brief
        </div>
        <div className="text-xs text-muted-foreground italic">
          No brief generated yet. ct-daily-brief runs pre-market weekdays.
        </div>
      </Card>
    );
  }

  const stale = new Date(brief.expires_at).getTime() < Date.now();

  return (
    <Card className="p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center gap-2 flex-wrap">
        <Newspaper className="w-3.5 h-3.5 text-primary" />
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Today's Brief</span>
        <Badge variant="outline" className={`text-[9px] px-1.5 py-0 h-4 ${urgencyClass(brief.urgency)}`}>
          <Flame className="w-2.5 h-2.5 mr-0.5" />
          {brief.urgency}
        </Badge>
        {brief.macro_regime && (
          <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4">
            {brief.macro_regime}
          </Badge>
        )}
        {brief.triggered_by !== 'scheduled' && (
          <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4">
            {brief.triggered_by.replace(/_/g, ' ')}
          </Badge>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground flex items-center gap-1">
          <Clock className="w-3 h-3" />
          {timeAgo(brief.created_at)}
          {stale && <span className="text-amber-400">· stale</span>}
        </span>
      </div>

      {/* Macro narrative */}
      <div className="text-xs leading-relaxed text-foreground/90 line-clamp-3">
        {brief.macro_narrative}
      </div>

      {/* Per-ticker tilt chips */}
      {Array.isArray(brief.per_ticker) && brief.per_ticker.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
          {brief.per_ticker.map((raw, i) => {
            const t = raw as Record<string, unknown>;
            const ticker = getString(t, 'ticker') ?? '?';
            const tilt = getString(t, 'tilt') ?? getString(t, 'tape_vs_narrative') ?? '';
            const confMult = getNumber(t, 'confidence_multiplier');
            const focus = getString(t, 'focus_level') ?? getString(t, 'focus');
            const avoid = (brief.skip_today ?? []).includes(ticker);
            const focusHard = (brief.watchlist_focus ?? []).includes(ticker);
            return (
              <div
                key={`${ticker}-${i}`}
                className={`shrink-0 rounded-md border px-2 py-1 text-[10px] min-w-[110px] ${
                  avoid ? 'border-red-500/40 bg-red-500/5' :
                  focusHard ? 'border-primary/40 bg-primary/5' :
                  'border-border bg-card'
                }`}
                title={JSON.stringify(t)}
              >
                <div className="flex items-center gap-1 font-mono font-semibold">
                  <span>{ticker}</span>
                  {avoid && <span className="text-red-400">✗</span>}
                  {focusHard && <Zap className="w-2.5 h-2.5 text-primary" />}
                </div>
                {tilt && <div className="text-muted-foreground truncate">{tilt}</div>}
                {(confMult != null || focus) && (
                  <div className="flex items-center gap-1 text-muted-foreground">
                    {confMult != null && <span>×{confMult.toFixed(2)}</span>}
                    {focus && <span>· {focus}</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Convergent view */}
      {brief.convergent_view && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
            Convergent view
          </div>
          <div className="text-xs leading-snug text-foreground/90 line-clamp-4">
            {brief.convergent_view}
          </div>
        </div>
      )}

      {/* High-conviction ideas */}
      {Array.isArray(brief.high_conviction_ideas) && brief.high_conviction_ideas.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            High-conviction ideas
          </div>
          <ul className="space-y-1">
            {brief.high_conviction_ideas.map((raw, i) => {
              const idea = raw as Record<string, unknown>;
              const instrument = getString(idea, 'instrument') ?? '?';
              const direction = getString(idea, 'direction') ?? '';
              const entry = getNumber(idea, 'entry') ?? getString(idea, 'entry');
              const stop = getNumber(idea, 'stop') ?? getString(idea, 'stop');
              const target = getNumber(idea, 'target') ?? getString(idea, 'target');
              const size = getNumber(idea, 'size_pct');
              const reasoning = getString(idea, 'reasoning') ?? getString(idea, 'rationale') ?? '';
              return (
                <li key={i} className="text-[11px] leading-snug flex items-start gap-2">
                  <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 font-mono uppercase shrink-0">
                    {direction}
                  </Badge>
                  <span className="font-mono font-semibold shrink-0">{instrument}</span>
                  <span className="text-muted-foreground shrink-0">
                    e:{entry ?? '—'} · s:{stop ?? '—'} · t:{target ?? '—'}
                    {size != null && ` · ${size}%`}
                  </span>
                  <span className="text-muted-foreground truncate">{reasoning}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Card>
  );
}
