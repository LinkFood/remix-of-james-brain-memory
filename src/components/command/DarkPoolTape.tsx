/**
 * DarkPoolTape — off-exchange block prints. Institutional activity.
 * Sorted by notional, highlighted when >$50M.
 */
import { useDarkPoolPrints, type DarkPoolPrint } from '@/hooks/useCoTraderData';
import { Card } from '@/components/ui/card';

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

function fmtNotional(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtSize(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toFixed(0);
}

export function DarkPoolTape() {
  const { data: prints, isLoading } = useDarkPoolPrints(40);

  return (
    <Card className="divide-y divide-border">
      <div className="px-3 py-2 border-b border-border bg-muted/30 sticky top-0 z-10 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-foreground">Dark Pool</span>
          <span className="text-[10px] text-muted-foreground">off-exchange blocks</span>
        </div>
        {prints && (
          <span className="text-[10px] text-muted-foreground">{prints.length} recent</span>
        )}
      </div>

      {isLoading ? (
        <div className="p-4 text-center text-xs text-muted-foreground">loading…</div>
      ) : !prints || prints.length === 0 ? (
        <div className="p-4 text-center text-xs text-muted-foreground">
          no dark pool prints yet
        </div>
      ) : (
        <div className="max-h-[50vh] overflow-y-auto font-mono text-[11px]">
          {prints.map((p) => (
            <DPRow key={p.id} print={p} />
          ))}
        </div>
      )}
    </Card>
  );
}

function DPRow({ print }: { print: DarkPoolPrint }) {
  const big = print.notional_value >= 50_000_000;
  const huge = print.notional_value >= 500_000_000;
  return (
    <div className={`grid grid-cols-[auto_auto_1fr_auto] items-center gap-2 px-3 py-1.5 text-[11px] leading-tight hover:bg-muted/20 transition-colors ${
      huge ? 'bg-purple-500/10 border-l-2 border-l-purple-500' : big ? 'bg-primary/5' : ''
    }`}>
      <span className="text-muted-foreground">{relTime(print.executed_at ?? print.ingested_at)}</span>
      <span className="font-bold text-foreground">{print.ticker}</span>
      <span className="text-foreground/75">
        {fmtSize(print.size)} @ ${print.price.toFixed(2)}
      </span>
      <span className={`font-semibold ${huge ? 'text-purple-400' : big ? 'text-primary' : 'text-foreground/70'}`}>
        {fmtNotional(print.notional_value)}
      </span>
    </div>
  );
}
