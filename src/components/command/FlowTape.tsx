/**
 * FlowTape — unusual options flow stream. The primary "Unusual Whales" data.
 * Green = call, red = put. Size/premium + ITM/OTM + aggression side.
 */
import { useFlowAlerts, type FlowAlert } from '@/hooks/useCoTraderData';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Flame } from 'lucide-react';

function relTime(iso: string | null): string {
  if (!iso) return '—';
  const d = Date.now() - Date.parse(iso);
  const s = Math.floor(d / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function fmtMoney(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtSize(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toFixed(0);
}

function isCall(side: string | null): boolean {
  return (side ?? '').toLowerCase().startsWith('c');
}

export function FlowTape() {
  const { data: alerts, isLoading } = useFlowAlerts(60);

  return (
    <Card className="divide-y divide-border">
      <div className="px-3 py-2 border-b border-border bg-muted/30 sticky top-0 z-10 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-foreground">Flow Tape</span>
          <span className="text-[10px] text-muted-foreground">unusual options</span>
        </div>
        {alerts && (
          <span className="text-[10px] text-muted-foreground">{alerts.length} recent</span>
        )}
      </div>

      {isLoading ? (
        <div className="p-4 text-center text-xs text-muted-foreground">loading…</div>
      ) : !alerts || alerts.length === 0 ? (
        <div className="p-4 text-center text-xs text-muted-foreground">
          no flow yet — ingester polls every 3min during market hours
        </div>
      ) : (
        <div className="max-h-[50vh] overflow-y-auto font-mono text-[11px]">
          {alerts.map((a) => (
            <FlowRow key={a.id} alert={a} />
          ))}
        </div>
      )}
    </Card>
  );
}

function FlowRow({ alert }: { alert: FlowAlert }) {
  const call = isCall(alert.side);
  const whale = (alert.premium ?? 0) >= 1_000_000;
  const aggressive = alert.is_ask === true;
  return (
    <div
      className={`grid grid-cols-[auto_auto_1fr_auto_auto] items-center gap-2 px-3 py-1.5 text-[11px] leading-tight hover:bg-muted/20 transition-colors ${
        call ? 'text-green-400' : 'text-red-400'
      } ${whale ? 'bg-primary/5' : ''}`}
    >
      <span className="text-muted-foreground">{relTime(alert.ingested_at)}</span>
      <span className="font-bold text-foreground">{alert.ticker}</span>
      <span className="truncate">
        <span>${alert.strike ?? '—'} </span>
        <span className="uppercase">{call ? 'C' : 'P'}</span>
        <span className="text-muted-foreground"> {alert.expiry ? alert.expiry.slice(5) : ''}</span>
        {alert.is_otm === true && <span className="text-muted-foreground/60 ml-1">OTM</span>}
        {alert.is_otm === false && <span className="text-muted-foreground/60 ml-1">ITM</span>}
        {aggressive && <Badge variant="outline" className="ml-1 text-[9px] px-1 py-0 border-primary/50 text-primary">ASK</Badge>}
        {alert.size_gt_oi && <Badge variant="outline" className="ml-1 text-[9px] px-1 py-0 border-amber-500/50 text-amber-400">OPEN</Badge>}
      </span>
      <span className="text-foreground/80">{fmtSize(alert.size)}</span>
      <span className={`font-semibold ${whale ? 'text-primary' : ''}`}>
        {whale && <Flame className="w-3 h-3 inline mr-0.5" />}
        {fmtMoney(alert.premium)}
      </span>
    </div>
  );
}
