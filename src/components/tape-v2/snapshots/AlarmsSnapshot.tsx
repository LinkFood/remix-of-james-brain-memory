/**
 * AlarmsSnapshot — count + top-3 fires for the v2 Tape command-center right
 * rail.
 *
 * Source: useAlarmRealtime (already in the page hook tree). Realtime channel
 * is shared — no new subscription. Top 3 by recency from `recentAlarms`.
 *
 * The full /alarms page handles tier filtering + replay/live + bronze rows;
 * snapshot focuses on glanceable fire status.
 */

import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { Bell, ArrowUpRight } from 'lucide-react';
import { useAlarmRealtime } from '@/hooks/useAlarmRealtime';

const TIER_PILL: Record<string, string> = {
  gold: 'bg-amber-500/20 border-amber-500/40 text-amber-200',
  silver: 'bg-slate-400/20 border-slate-400/40 text-slate-200',
  bronze: 'bg-orange-700/20 border-orange-700/40 text-orange-300',
  unknown: 'bg-muted/20 border-muted/30 text-muted-foreground',
};

const TIER_EMOJI: Record<string, string> = {
  gold: '🥇',
  silver: '🥈',
  bronze: '🥉',
  unknown: '·',
};

function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (ms < 60_000) return 'now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return '1d+';
}

export function AlarmsSnapshot() {
  const { recentAlarms } = useAlarmRealtime();

  // Top 3 by recency (recentAlarms already DESC). Count is total in-window.
  const top3 = recentAlarms.slice(0, 3);
  const goldCount = recentAlarms.filter((a) => a.tier === 'gold').length;
  const silverCount = recentAlarms.filter((a) => a.tier === 'silver').length;

  return (
    <Card className="p-2.5">
      <div className="flex items-center justify-between mb-1.5">
        <span className="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
          <Bell className="w-3 h-3" />
          Alarms
          <span className="ml-1 font-normal normal-case tracking-normal">
            {goldCount > 0 && <span className="text-amber-300">🥇{goldCount}</span>}
            {silverCount > 0 && <span className="text-slate-300 ml-1">🥈{silverCount}</span>}
            {goldCount === 0 && silverCount === 0 && (
              <span className="text-muted-foreground/60">{recentAlarms.length}</span>
            )}
          </span>
        </span>
        <Link
          to="/alarms"
          className="inline-flex items-center gap-0.5 text-[10px] text-primary/70 hover:text-primary transition-colors"
        >
          full <ArrowUpRight className="w-3 h-3" />
        </Link>
      </div>

      {top3.length === 0 && (
        <div className="text-[10px] text-muted-foreground italic px-1 py-2">no recent fires</div>
      )}

      <div className="space-y-1">
        {top3.map((alarm) => (
          <Link
            key={alarm.id}
            to={`/alarms?tier=${alarm.tier}`}
            className={cn(
              'flex items-center justify-between gap-2 px-2 py-1 rounded border transition-colors hover:opacity-80',
              TIER_PILL[alarm.tier] ?? TIER_PILL.unknown,
            )}
          >
            <div className="flex items-baseline gap-1.5 min-w-0">
              <span className="text-[10px]">{TIER_EMOJI[alarm.tier] ?? '·'}</span>
              <span className="text-[11px] font-mono font-semibold tracking-wider">
                {alarm.ticker}
              </span>
              {alarm.direction && (
                <span className="text-[9px] font-mono opacity-70 uppercase">
                  {alarm.direction}
                </span>
              )}
            </div>
            <span className="text-[9px] font-mono opacity-70">{timeAgo(alarm.firedAt)}</span>
          </Link>
        ))}
      </div>
    </Card>
  );
}
