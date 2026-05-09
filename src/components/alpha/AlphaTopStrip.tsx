/**
 * AlphaTopStrip — slim header for the v2 alpha surface.
 *
 * Compresses regime + consensus + VIX + news count into one strip so the
 * page surface stays focused on the four leading-indicator surfaces below.
 * Per the brief: "non-alpha signals push, not render." Anything that
 * deserves captain's attention beyond glance comes via Slack emission.
 *
 * Iter #1: regime pill (existing useRegimeState) + tape-commentary VIX
 * (existing useTapeReader) + alarm count (existing useAlarmRealtime).
 * Refines as data sources mature.
 */

import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { Activity, Bell, Brain } from 'lucide-react';
import { useRegimeState } from '@/hooks/useRegimeState';
import { useTapeReader } from '@/hooks/useTapeReader';
import { useAlarmRealtime } from '@/hooks/useAlarmRealtime';

function regimeColor(classification: string | null | undefined): string {
  if (!classification) return 'text-muted-foreground';
  if (classification.includes('up') || classification.includes('bull')) return 'text-emerald-300';
  if (classification.includes('down') || classification.includes('bear')) return 'text-red-300';
  return 'text-amber-300';
}

function tideColor(tide: string | null | undefined): string {
  if (tide === 'bullish') return 'text-emerald-300';
  if (tide === 'bearish') return 'text-red-300';
  return 'text-muted-foreground';
}

export function AlphaTopStrip() {
  const { marketLatest } = useRegimeState();
  const { latest: tapeLatest } = useTapeReader({ priorCount: 0 });
  const { recentAlarms } = useAlarmRealtime();

  const regimeText = marketLatest?.classification ?? '—';
  const vixText = tapeLatest?.vix_level != null ? tapeLatest.vix_level.toFixed(2) : '—';
  const tideText = tapeLatest?.market_tide ?? null;
  const alarmCount = recentAlarms.length;

  return (
    <Card className="px-3 py-1.5">
      <div className="flex items-center gap-4 text-[10px] font-mono flex-wrap">
        <span className="inline-flex items-center gap-1.5">
          <Activity className="w-3 h-3 text-primary" />
          <span className="uppercase tracking-wider text-muted-foreground">regime</span>
          <span className={cn('uppercase font-semibold', regimeColor(marketLatest?.classification))}>
            {regimeText}
          </span>
        </span>

        {tideText && (
          <span className="inline-flex items-center gap-1.5">
            <span className="uppercase tracking-wider text-muted-foreground">tide</span>
            <span className={cn('uppercase font-semibold', tideColor(tideText))}>
              {tideText}
            </span>
          </span>
        )}

        <span className="inline-flex items-center gap-1.5">
          <span className="uppercase tracking-wider text-muted-foreground">vix</span>
          <span className="font-semibold text-foreground/90">{vixText}</span>
        </span>

        <span className="inline-flex items-center gap-1.5 ml-auto">
          <Bell className="w-3 h-3 text-amber-400" />
          <span className="text-foreground/90">{alarmCount} push{alarmCount === 1 ? '' : 'es'} · last hour</span>
        </span>

        <span className="inline-flex items-center gap-1.5 text-primary/70">
          <Brain className="w-3 h-3" />
          <span className="uppercase tracking-wider">v2 alpha · iter #1</span>
        </span>
      </div>
    </Card>
  );
}
