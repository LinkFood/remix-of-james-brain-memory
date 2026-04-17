import { useDisagreements, type Disagreement } from '@/hooks/useCoTraderData';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Swords } from 'lucide-react';

function fmtAgo(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function resolutionVariant(res: Disagreement['resolution']): { label: string; cls: string } {
  switch (res) {
    case 'pending':      return { label: 'pending',      cls: 'bg-muted text-muted-foreground' };
    case 'claude_right': return { label: 'claude right', cls: 'bg-blue-500/20 text-blue-300' };
    case 'james_right':  return { label: 'james right',  cls: 'bg-emerald-500/20 text-emerald-300' };
    case 'both_wrong':   return { label: 'both wrong',   cls: 'bg-red-500/20 text-red-300' };
    case 'both_right':   return { label: 'both right',   cls: 'bg-amber-500/20 text-amber-200' };
    case 'ambiguous':    return { label: 'ambiguous',    cls: 'bg-muted text-muted-foreground' };
    default:             return { label: res,            cls: 'bg-muted text-muted-foreground' };
  }
}

function dirColor(dir: string): string {
  if (dir === 'bullish')    return 'text-emerald-400';
  if (dir === 'bearish')    return 'text-red-400';
  if (dir === 'volatility') return 'text-amber-300';
  return 'text-muted-foreground';
}

export function DisagreementPanel() {
  const { data: rows, isLoading } = useDisagreements(20);

  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <Swords className="w-4 h-4 text-primary" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground">Disagreements</h3>
        {rows && rows.length > 0 && (
          <span className="text-[10px] text-muted-foreground ml-auto">
            {rows.length} tracked
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground">loading…</div>
      ) : !rows || rows.length === 0 ? (
        <div className="text-sm text-muted-foreground">no disagreements yet — materializer runs every 10 min during market hours</div>
      ) : (
        <div className="space-y-2">
          {rows.map(d => {
            const r = resolutionVariant(d.resolution);
            return (
              <div key={d.id} className="border border-border/60 rounded-md p-2 text-xs">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-semibold text-foreground">{d.instrument}</span>
                  <span className="text-[10px] text-muted-foreground">{d.horizon}</span>
                  <Badge className={`ml-auto text-[10px] ${r.cls}`} variant="secondary">{r.label}</Badge>
                </div>
                <div className="flex items-center gap-3 text-[11px]">
                  <span>
                    <span className="text-muted-foreground">james: </span>
                    <span className={`font-medium ${dirColor(d.james_direction)}`}>{d.james_direction}</span>
                  </span>
                  <span className="text-muted-foreground">vs</span>
                  <span>
                    <span className="text-muted-foreground">claude: </span>
                    <span className={`font-medium ${dirColor(d.claude_direction)}`}>{d.claude_direction}</span>
                  </span>
                </div>
                <div className="text-[10px] text-muted-foreground mt-1">{fmtAgo(d.created_at)}</div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
