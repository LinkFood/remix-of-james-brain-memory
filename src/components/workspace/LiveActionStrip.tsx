/**
 * LiveActionStrip — row 3 of Claude's State dashboard.
 *
 * Two columns side-by-side on desktop, stacked on mobile:
 *   Left  — Open Claude positions (live unrealized pull from ct_trades).
 *   Right — Armed trade ideas (ct_trade_ideas trader='claude' status='armed').
 *
 * Both read from hooks in useClaudeState; this component never writes.
 * Positions within 0.5% of stop/target get an amber "close" flag.
 */
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TrendingUp, TrendingDown, Target, AlertTriangle } from 'lucide-react';
import { useOpenClaudeTrades, useArmedTradeIdeas } from '@/hooks/useClaudeState';
import type { CtTradeRow } from '@/hooks/useCoTraderData';
import type { CtTradeIdeaRow } from '@/hooks/useClaudeBook';

const CLOSE_TO_LEVEL_PCT = 0.5;

function timeAgo(iso: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

function timeUntil(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff < 0) return 'expired';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

function pctDistance(a: number | null, b: number | null): number | null {
  if (a == null || b == null || b === 0) return null;
  return Math.abs((a - b) / b) * 100;
}

function formatTrigger(entry_trigger: Record<string, unknown>, entry_price_target: number | null): string {
  if (entry_price_target != null) return `@ ${entry_price_target.toFixed(2)}`;
  if (entry_trigger && typeof entry_trigger === 'object') {
    // Try well-known shapes. We don't invent data — we render what's there.
    if (typeof entry_trigger.price === 'number') return `@ ${entry_trigger.price.toFixed(2)}`;
    if (typeof entry_trigger.condition === 'string') return entry_trigger.condition;
    return Object.entries(entry_trigger)
      .slice(0, 2)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(' ');
  }
  return 'trigger tbd';
}

function PositionCard({ t }: { t: CtTradeRow }) {
  const live = t.live_pnl_pct ?? null;
  const current = live != null && t.entry_price
    ? t.entry_price * (1 + (t.side === 'long' ? live : -live) / 100)
    : null;

  const toStopPct = pctDistance(current, t.stop_price);
  const toTargetPct = pctDistance(current, t.target_price);
  const nearStop = toStopPct != null && toStopPct <= CLOSE_TO_LEVEL_PCT;
  const nearTarget = toTargetPct != null && toTargetPct <= CLOSE_TO_LEVEL_PCT;
  const hot = nearStop || nearTarget;

  return (
    <Card className={`p-2.5 space-y-1.5 ${hot ? 'ring-1 ring-amber-500/40' : ''}`}>
      <div className="flex items-center gap-1.5 text-xs">
        <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 uppercase font-mono">
          {t.side}
        </Badge>
        <span className="font-mono font-semibold">{t.instrument}</span>
        {t.contract_type && t.contract_type !== 'underlying' && (
          <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 uppercase">
            {t.contract_type}
          </Badge>
        )}
        <span className={`ml-auto font-mono ${live != null && live >= 0 ? 'text-green-400' : live != null ? 'text-red-400' : 'text-muted-foreground'}`}>
          {live != null ? `${live >= 0 ? '+' : ''}${live.toFixed(2)}%` : '—'}
        </span>
      </div>
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground font-mono">
        <span>e {t.entry_price.toFixed(2)}</span>
        <span>s {t.stop_price != null ? t.stop_price.toFixed(2) : '—'}</span>
        <span>t {t.target_price != null ? t.target_price.toFixed(2) : '—'}</span>
        <span className="ml-auto">{timeAgo(t.opened_at)}</span>
      </div>
      {hot && (
        <div className="flex items-center gap-1 text-[10px] text-amber-400">
          <AlertTriangle className="w-3 h-3" />
          {nearStop && `near stop (${toStopPct!.toFixed(2)}%)`}
          {nearTarget && `near target (${toTargetPct!.toFixed(2)}%)`}
        </div>
      )}
      {t.thesis && (
        <div className="text-[11px] leading-snug line-clamp-2 text-muted-foreground">
          {t.thesis}
        </div>
      )}
    </Card>
  );
}

function IdeaCard({ idea }: { idea: CtTradeIdeaRow }) {
  const expired = new Date(idea.expires_at).getTime() < Date.now();
  return (
    <Card className={`p-2.5 space-y-1.5 ${expired ? 'opacity-60' : ''}`}>
      <div className="flex items-center gap-1.5 text-xs">
        <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 uppercase font-mono">
          {idea.direction}
        </Badge>
        <span className="font-mono font-semibold">{idea.instrument}</span>
        {idea.contract_type !== 'stock' && (
          <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 uppercase">
            {idea.contract_type}{idea.strike ? ` ${idea.strike}` : ''}
          </Badge>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground">
          {expired ? 'expired' : timeUntil(idea.expires_at)}
        </span>
      </div>
      <div className="text-[10px] text-muted-foreground font-mono">
        {formatTrigger(idea.entry_trigger ?? {}, idea.entry_price_target)}
        <span className="ml-2">size {idea.size_pct}%</span>
        <span className="ml-2">stop {idea.stop_pct}%</span>
        <span className="ml-2">tgt {idea.target_pct}%</span>
      </div>
      {idea.rationale && (
        <div className="text-[11px] leading-snug line-clamp-2 text-muted-foreground">
          {idea.rationale}
        </div>
      )}
    </Card>
  );
}

export function LiveActionStrip() {
  const { data: openTrades = [] } = useOpenClaudeTrades();
  const { data: ideas = [] } = useArmedTradeIdeas();

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {/* Open positions */}
      <section className="space-y-2">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground px-1">
          <TrendingUp className="w-3 h-3" />
          <span>Open positions</span>
          <span className="ml-auto font-mono">{openTrades.length}</span>
        </div>
        {openTrades.length === 0 ? (
          <Card className="p-4 text-xs text-muted-foreground italic">
            No open Claude positions.
          </Card>
        ) : (
          <div className="space-y-1.5">
            {openTrades.map((t) => (
              <PositionCard key={t.id} t={t} />
            ))}
          </div>
        )}
      </section>

      {/* Armed ideas */}
      <section className="space-y-2">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground px-1">
          <Target className="w-3 h-3" />
          <span>Armed ideas</span>
          <span className="ml-auto font-mono">{ideas.length}</span>
        </div>
        {ideas.length === 0 ? (
          <Card className="p-4 text-xs text-muted-foreground italic">
            <TrendingDown className="w-3 h-3 inline mr-1" />
            No armed trade ideas. Generator runs through RTH.
          </Card>
        ) : (
          <div className="space-y-1.5">
            {ideas.map((idea) => (
              <IdeaCard key={idea.id} idea={idea} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
