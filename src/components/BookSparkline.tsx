/**
 * BookSparkline — tiny inline chart for TopNav showing today's paper book
 * realized P&L progression. One dot per closed trade's running sum.
 */
import { useTodayTrades, useTodayBook } from '@/hooks/useCoTraderData';

export function BookSparkline() {
  const { data: trades } = useTodayTrades();
  const { data: book } = useTodayBook();

  const closed = (trades ?? []).filter(t => t.status === 'closed' && t.closed_at != null && t.realized_pnl_usd != null);
  closed.sort((a, b) => (a.closed_at as string).localeCompare(b.closed_at as string));

  if (closed.length === 0) return null;

  const starting = book?.starting_balance ?? 10000;
  // Cumulative balance points
  const points: number[] = [starting];
  let running = starting;
  for (const t of closed) {
    running += (t.realized_pnl_usd as number) ?? 0;
    points.push(running);
  }
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const W = 60, H = 16;
  const path = points.map((p, i) => {
    const x = (i / (points.length - 1 || 1)) * W;
    const y = H - ((p - min) / range) * H;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const endBal = points[points.length - 1];
  const lineColor = endBal >= starting ? 'hsl(142 71% 50%)' : 'hsl(0 84% 60%)';
  const endColor = endBal >= starting ? 'text-emerald-400' : 'text-red-400';
  const pnl = endBal - starting;

  return (
    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs">
      <svg width={W} height={H} className="overflow-visible">
        <path d={path} stroke={lineColor} strokeWidth="1.5" fill="none" />
        <line x1="0" x2={W} y1={H - ((starting - min) / range) * H} y2={H - ((starting - min) / range) * H} stroke="hsl(var(--border))" strokeDasharray="2 2" strokeWidth="0.5" />
      </svg>
      <span className={`font-mono ${endColor}`}>
        {pnl >= 0 ? '+' : ''}${pnl.toFixed(0)}
      </span>
    </div>
  );
}
