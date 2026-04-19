/**
 * StatusStrip — row 1 of Claude's State dashboard.
 *
 * Always-visible compact strip: heartbeat, circuit breaker, hallucinations
 * today, open position count + total unrealized P&L, armed ideas count +
 * nearest trigger distance, paper balance + YTD change.
 *
 * Every cell degrades to an explicit muted placeholder when the underlying
 * query returns nothing (weekend, cold start, etc). Nothing throws.
 */
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Activity, ShieldAlert, AlertTriangle, Briefcase, Target, Wallet,
} from 'lucide-react';
import {
  useClaudeHeartbeatStatus,
  useCircuitBreakerStatus,
  useTodaysHallucinationCount,
  useOpenClaudeTrades,
  useArmedTradeIdeas,
  useClaudeTodayBook,
  type HeartbeatLiveness,
} from '@/hooks/useClaudeState';
import { useGenerationProgress } from '@/hooks/useClaudeGeneration';

function heartbeatLabel(status: HeartbeatLiveness, mins: number | null): string {
  switch (status) {
    case 'alive': return mins != null ? `alive · ${mins.toFixed(0)}m` : 'alive';
    case 'stale': return mins != null ? `stale · ${mins.toFixed(0)}m` : 'stale';
    case 'dead': return 'dead';
    case 'off_hours': return 'off hours';
    case 'unknown':
    default: return 'unknown';
  }
}

function heartbeatDotClass(status: HeartbeatLiveness): string {
  switch (status) {
    case 'alive': return 'bg-green-400';
    case 'stale': return 'bg-amber-400';
    case 'dead': return 'bg-red-400';
    case 'off_hours': return 'bg-blue-400';
    default: return 'bg-muted-foreground';
  }
}

export function StatusStrip() {
  const { data: heartbeat } = useClaudeHeartbeatStatus();
  const { data: breakers = [] } = useCircuitBreakerStatus();
  const { data: hallucinations = 0 } = useTodaysHallucinationCount();
  const { data: openTrades = [] } = useOpenClaudeTrades();
  const { data: armedIdeas = [] } = useArmedTradeIdeas();
  const { data: book } = useClaudeTodayBook();
  const genProgress = useGenerationProgress();

  const unrealized = openTrades.reduce((sum, t) => sum + (t.live_pnl_usd ?? 0), 0);

  // Nearest trigger distance — surface the soonest-expiring armed idea.
  // "Distance" in the armed idea is conceptual (price to trigger). We surface
  // the friendliest thing we have without fabricating data: expiry time.
  const nearest = armedIdeas[0];
  const nearestMinsToExpiry = nearest
    ? Math.max(0, Math.round((new Date(nearest.expires_at).getTime() - Date.now()) / 60_000))
    : null;

  const todayBalance = book?.today?.ending_balance ?? book?.today?.starting_balance ?? null;
  const firstBalance = book?.firstOfYear?.starting_balance ?? null;
  const ytdPct =
    todayBalance != null && firstBalance && firstBalance > 0
      ? ((todayBalance - firstBalance) / firstBalance) * 100
      : null;

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
      {/* Heartbeat */}
      <Card className="p-2.5 flex items-center gap-2">
        <Activity className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Heartbeat</div>
          <div className="flex items-center gap-1.5 text-xs">
            <span
              className={`w-1.5 h-1.5 rounded-full ${heartbeatDotClass(heartbeat?.status ?? 'unknown')}`}
            />
            <span className="truncate">{heartbeatLabel(heartbeat?.status ?? 'unknown', heartbeat?.minutesSinceDecision ?? null)}</span>
          </div>
        </div>
      </Card>

      {/* Circuit breaker */}
      <Card className="p-2.5 flex items-center gap-2">
        <ShieldAlert className={`w-3.5 h-3.5 shrink-0 ${breakers.length > 0 ? 'text-red-400' : 'text-green-400'}`} />
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Circuit</div>
          <div className="text-xs truncate" title={breakers[0]?.reason}>
            {breakers.length === 0 ? (
              <span className="text-green-400">clear</span>
            ) : (
              <span className="text-red-400">
                {breakers[0].breakerType.replace(/_/g, ' ')}
              </span>
            )}
          </div>
        </div>
      </Card>

      {/* Hallucinations today */}
      <Card className="p-2.5 flex items-center gap-2">
        <AlertTriangle className={`w-3.5 h-3.5 shrink-0 ${hallucinations > 0 ? 'text-red-400' : 'text-muted-foreground'}`} />
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Hallucinations</div>
          <div className="flex items-center gap-1.5">
            <span className={`text-xs font-mono ${hallucinations > 0 ? 'text-red-400 font-semibold' : ''}`}>
              {hallucinations}
            </span>
            <span className="text-[10px] text-muted-foreground">today</span>
            {hallucinations > 0 && (
              <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 text-red-400 border-red-500/40">
                !
              </Badge>
            )}
          </div>
        </div>
      </Card>

      {/* Open positions + unrealized */}
      <Card className="p-2.5 flex items-center gap-2">
        <Briefcase className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Open</div>
          <div className="flex items-center gap-1.5 text-xs">
            <span className="font-mono">{openTrades.length}</span>
            <span className="text-muted-foreground">·</span>
            <span className={`font-mono ${unrealized >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {unrealized >= 0 ? '+' : ''}{unrealized.toFixed(0)}$
            </span>
          </div>
        </div>
      </Card>

      {/* Armed ideas */}
      <Card className="p-2.5 flex items-center gap-2">
        <Target className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Armed</div>
          <div className="flex items-center gap-1.5 text-xs">
            <span className="font-mono">{armedIdeas.length}</span>
            {nearest && nearestMinsToExpiry != null && (
              <>
                <span className="text-muted-foreground">·</span>
                <span className="text-muted-foreground">{nearestMinsToExpiry}m</span>
              </>
            )}
          </div>
        </div>
      </Card>

      {/* Paper balance + delta to target (YTD in tooltip) */}
      <Card
        className="p-2.5 flex items-center gap-2"
        title={
          ytdPct != null
            ? `YTD: ${ytdPct >= 0 ? '+' : ''}${ytdPct.toFixed(1)}%`
            : 'YTD: —'
        }
      >
        <Wallet className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Paper</div>
          <div className="flex items-center gap-1.5 text-xs">
            <span className="font-mono truncate">
              {todayBalance != null ? `$${Math.round(todayBalance).toLocaleString()}` : '—'}
            </span>
            {genProgress.distanceToTarget != null && genProgress.generation && (
              <span
                className={`font-mono ${
                  genProgress.distanceToTarget === 0
                    ? 'text-green-400'
                    : 'text-muted-foreground'
                }`}
                title={`Target: $${Math.round(genProgress.generation.target_balance_usd).toLocaleString()}`}
              >
                {genProgress.distanceToTarget === 0
                  ? 'target hit'
                  : `−$${Math.round(genProgress.distanceToTarget).toLocaleString()}`}
              </span>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
