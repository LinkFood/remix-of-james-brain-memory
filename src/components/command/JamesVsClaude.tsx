/**
 * JamesVsClaude — head-to-head comparison view.
 * Replaces DisagreementPanel. Pairs each ct_disagreement with both sides'
 * rationale, conviction, and grade (if horizon has closed). Scoreboard on top.
 *
 * James = blue. Claude = teal. Winning side gets a highlight ring.
 */
import { ChartSafe } from '@/components/ChartSafe';
import { useMemo } from 'react';
import {
  useDisagreementsDetailed,
  useDisagreementScoreboard,
  useTodayJamesViews,
  type DisagreementPair,
  type DisagreementGrade,
} from '@/hooks/useCoTraderData';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Swords, Trophy, Minus, Clock, AlertTriangle } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Cell, Tooltip } from 'recharts';
import { finiteOr } from '@/lib/chartSanitize';

function fmtAgo(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function dirColor(dir: string): string {
  if (dir === 'bullish')    return 'text-emerald-400';
  if (dir === 'bearish')    return 'text-red-400';
  if (dir === 'volatility') return 'text-amber-300';
  return 'text-muted-foreground';
}

function dirBadge(dir: string): string {
  if (dir === 'bullish')    return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
  if (dir === 'bearish')    return 'bg-red-500/15 text-red-300 border-red-500/30';
  if (dir === 'volatility') return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
  return 'bg-muted text-muted-foreground border-border';
}

function verdictBadge(v: DisagreementGrade['verdict']): string {
  switch (v) {
    case 'right':     return 'bg-green-500/15 text-green-300 border-green-500/30';
    case 'partial':   return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
    case 'wrong':     return 'bg-red-500/15 text-red-300 border-red-500/30';
    case 'ambiguous': return 'bg-muted text-muted-foreground border-border';
  }
}

export interface JamesVsClaudeProps {
  /** Context for the header shortcut. Default 'command'. On scorecard page
   *  we hide the "post a view" nudge to avoid duplication with the dedicated
   *  form. */
  variant?: 'command' | 'scorecard';
  /** Days back for the pair list. Defaults to 7. */
  daysBack?: number;
  /** Handler for "Post your view" click — scrolls to or opens the form. */
  onPostView?: () => void;
}

export function JamesVsClaude({ variant = 'command', daysBack = 7, onPostView }: JamesVsClaudeProps) {
  const { data: pairs, isLoading } = useDisagreementsDetailed(daysBack, 50);
  const { data: scoreboard } = useDisagreementScoreboard(30);
  const { data: todayViews } = useTodayJamesViews();

  const chartData = useMemo(() => {
    if (!scoreboard) return [];
    // Coerce each to a finite number — a NaN in a BarChart value field
    // collapses the axis domain and trips decimal.js LN10.
    return [
      { name: 'James', value: finiteOr(scoreboard.james_wins, 0), fill: '#60a5fa' },
      { name: 'Claude', value: finiteOr(scoreboard.claude_wins, 0), fill: '#2dd4bf' },
      { name: 'Ties', value: finiteOr(scoreboard.ties, 0), fill: '#a3a3a3' },
    ];
  }, [scoreboard]);

  const hasNoViewToday = (todayViews?.length ?? 0) === 0;
  const hasPairs = (pairs?.length ?? 0) > 0;

  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <Swords className="w-4 h-4 text-primary" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground">
          James vs Claude
        </h3>
        <span className="text-[10px] text-muted-foreground">
          · disagreements, last {daysBack}d
        </span>
        {variant === 'command' && onPostView && (
          <button
            type="button"
            onClick={onPostView}
            className="ml-auto text-[10px] px-2 py-0.5 rounded-md border border-blue-500/40 text-blue-300 hover:bg-blue-500/10 transition-colors"
          >
            Post your view →
          </button>
        )}
      </div>

      {/* Scoreboard row */}
      {scoreboard && scoreboard.total > 0 && (
        <div className="mb-3 border border-border/60 rounded-md p-3 bg-muted/20">
          <div className="flex items-center gap-3 text-[11px]">
            <span className="flex items-center gap-1">
              <Trophy className="w-3 h-3 text-blue-400" />
              <span className="uppercase tracking-wider text-muted-foreground">30d</span>
            </span>
            <span className="text-blue-300 font-semibold">James {scoreboard.james_wins}</span>
            <span className="text-muted-foreground">·</span>
            <span className="text-teal-300 font-semibold">Claude {scoreboard.claude_wins}</span>
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground">{scoreboard.ties} tie{scoreboard.ties === 1 ? '' : 's'}</span>
            {scoreboard.both_wrong > 0 && (
              <>
                <span className="text-muted-foreground">·</span>
                <span className="text-red-300/80">{scoreboard.both_wrong} both-wrong</span>
              </>
            )}
            <span className="ml-auto text-[10px] text-muted-foreground">
              {scoreboard.pending} pending · {scoreboard.total} total
            </span>
          </div>
          {chartData.some(d => d.value > 0) && (
            <div className="mt-2 h-12">
              <ChartSafe><ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} layout="vertical" margin={{ top: 0, right: 8, bottom: 0, left: 0 }}>
                  <XAxis type="number" hide />
                  <YAxis type="category" dataKey="name" hide />
                  <Tooltip
                    cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                    contentStyle={{ background: '#0a0a0a', border: '1px solid #333', fontSize: 11 }}
                    labelStyle={{ color: '#aaa' }}
                  />
                  <Bar dataKey="value" radius={[2, 2, 2, 2]}>
                    {chartData.map((d, i) => <Cell key={i} fill={d.fill} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer></ChartSafe>
            </div>
          )}
        </div>
      )}

      {/* No-view nudge (only on command, not scorecard) */}
      {variant === 'command' && hasNoViewToday && (
        <div className="mb-3 border border-dashed border-blue-500/30 rounded-md p-3 text-[11px] text-muted-foreground bg-blue-500/5">
          No views posted this session.{' '}
          {onPostView ? (
            <button type="button" onClick={onPostView} className="text-blue-300 underline underline-offset-2 hover:text-blue-200">
              Post one →
            </button>
          ) : (
            <span>Scroll to the post-a-view form below.</span>
          )}
        </div>
      )}

      {/* Pairs list */}
      {isLoading ? (
        <div className="text-sm text-muted-foreground">loading…</div>
      ) : !hasPairs ? (
        <div className="text-xs text-muted-foreground leading-relaxed">
          No disagreements in the last {daysBack} days. When you post a view that differs from Claude&apos;s current
          read on the same ticker + horizon, they land here — with a paired grade at horizon close.
        </div>
      ) : (
        <div className="space-y-2">
          {pairs!.map(pair => <PairCard key={pair.disagreement.id} pair={pair} />)}
        </div>
      )}
    </Card>
  );
}

function PairCard({ pair }: { pair: DisagreementPair }) {
  const { disagreement: d, james, claude, winner, actual_return_pct } = pair;

  const jamesHighlight =
    winner === 'james' ? 'ring-1 ring-blue-400/50 border-blue-500/40'
    : 'border-blue-500/20';
  const claudeHighlight =
    winner === 'claude' ? 'ring-1 ring-teal-400/50 border-teal-500/40'
    : 'border-teal-500/20';

  return (
    <div className="border border-border/60 rounded-md p-3 bg-muted/10">
      {/* Row header: ticker · horizon · status */}
      <div className="flex items-center gap-2 mb-2 text-[11px]">
        <span className="font-mono font-semibold text-foreground text-sm">{d.instrument}</span>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{d.horizon}</span>
        <span className="text-[10px] text-muted-foreground">
          opened {fmtAgo(d.created_at)} · horizon {new Date(d.horizon_end).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
        </span>
        <span className="ml-auto">
          <WinnerBadge winner={winner} />
        </span>
      </div>

      {/* Three-column grid: James | Center | Claude */}
      <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-stretch">
        {/* James — blue */}
        <div className={`rounded-md border ${jamesHighlight} p-2 bg-blue-500/5`}>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] uppercase tracking-wider text-blue-300/80 font-semibold">James</span>
            {james && (
              <Badge variant="outline" className={`text-[9px] px-1 py-0 ${dirBadge(james.direction)}`}>
                {james.direction}
              </Badge>
            )}
            {james && (
              <span className="text-[10px] text-muted-foreground">conv {james.conviction}</span>
            )}
          </div>
          {james?.rationale ? (
            <p className="text-[11px] leading-snug text-foreground/90 line-clamp-4">{james.rationale}</p>
          ) : (
            <p className="text-[11px] italic text-muted-foreground">no rationale</p>
          )}
          <div className="mt-1 flex items-center gap-2 text-[9px] text-muted-foreground">
            {james ? fmtAgo(james.created_at) : '—'}
            {james?.grade && (
              <Badge variant="outline" className={`text-[9px] px-1 py-0 ${verdictBadge(james.grade.verdict)}`}>
                {james.grade.verdict}
              </Badge>
            )}
          </div>
        </div>

        {/* Center — outcome */}
        <div className="flex flex-col items-center justify-center min-w-[80px] px-1">
          {winner === 'pending' ? (
            <>
              <Clock className="w-4 h-4 text-muted-foreground mb-1" />
              <span className="text-[9px] uppercase tracking-wider text-muted-foreground">awaiting</span>
              <span className="text-[9px] text-muted-foreground">outcome</span>
            </>
          ) : (
            <>
              <div className={`text-sm font-mono font-semibold ${
                actual_return_pct == null ? 'text-muted-foreground'
                : actual_return_pct > 0 ? 'text-emerald-400'
                : actual_return_pct < 0 ? 'text-red-400'
                : 'text-muted-foreground'
              }`}>
                {actual_return_pct != null
                  ? `${actual_return_pct >= 0 ? '+' : ''}${actual_return_pct.toFixed(2)}%`
                  : '—'}
              </div>
              <span className="text-[9px] uppercase tracking-wider text-muted-foreground mt-0.5">
                actual
              </span>
              {claude?.grade?.actual_direction && (
                <span className={`text-[10px] mt-0.5 ${dirColor(claude.grade.actual_direction)}`}>
                  {claude.grade.actual_direction}
                </span>
              )}
            </>
          )}
        </div>

        {/* Claude — teal */}
        <div className={`rounded-md border ${claudeHighlight} p-2 bg-teal-500/5`}>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] uppercase tracking-wider text-teal-300/80 font-semibold">Claude</span>
            {claude && (
              <Badge variant="outline" className={`text-[9px] px-1 py-0 ${dirBadge(claude.direction)}`}>
                {claude.direction}
              </Badge>
            )}
            {claude && (
              <span className="text-[10px] text-muted-foreground">conv {claude.conviction}</span>
            )}
          </div>
          {claude?.glance?.[0] ? (
            <p className="text-[11px] leading-snug text-foreground/90 line-clamp-4">{claude.glance[0]}</p>
          ) : claude?.full_reasoning ? (
            <p className="text-[11px] leading-snug text-foreground/90 line-clamp-4">
              {claude.full_reasoning.slice(0, 220)}
              {claude.full_reasoning.length > 220 ? '…' : ''}
            </p>
          ) : (
            <p className="text-[11px] italic text-muted-foreground">no reasoning</p>
          )}
          <div className="mt-1 flex items-center gap-2 text-[9px] text-muted-foreground">
            {claude ? fmtAgo(claude.created_at) : '—'}
            {claude?.grade && (
              <Badge variant="outline" className={`text-[9px] px-1 py-0 ${verdictBadge(claude.grade.verdict)}`}>
                {claude.grade.verdict}
              </Badge>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function WinnerBadge({ winner }: { winner: DisagreementPair['winner'] }) {
  switch (winner) {
    case 'james':
      return (
        <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-blue-500/15 text-blue-300 border-blue-500/40">
          <Trophy className="w-2.5 h-2.5 mr-1" /> James
        </Badge>
      );
    case 'claude':
      return (
        <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-teal-500/15 text-teal-300 border-teal-500/40">
          <Trophy className="w-2.5 h-2.5 mr-1" /> Claude
        </Badge>
      );
    case 'tie':
      return (
        <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-amber-500/15 text-amber-300 border-amber-500/30">
          <Minus className="w-2.5 h-2.5 mr-1" /> Tie
        </Badge>
      );
    case 'both_wrong':
      return (
        <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-red-500/15 text-red-300 border-red-500/30">
          <AlertTriangle className="w-2.5 h-2.5 mr-1" /> Both wrong
        </Badge>
      );
    case 'pending':
    default:
      return (
        <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-muted text-muted-foreground border-border">
          <Clock className="w-2.5 h-2.5 mr-1" /> awaiting outcome
        </Badge>
      );
  }
}
