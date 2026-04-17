import { useLatestHeartbeat } from '@/hooks/useCoTraderData';
import { Card } from '@/components/ui/card';
import { Activity, TrendingUp, TrendingDown, Minus } from 'lucide-react';

type GexRow = { strike: string | number; call_gamma_oi?: string | number; put_gamma_oi?: string | number };

interface CondensedMacro {
  price: number | null;
  call_wall: number | null;
  put_wall: number | null;
  net_gamma_oi: number | null;
  total_call_gamma_oi: number | null;
  total_put_gamma_oi: number | null;
}

function fmtLarge(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(2);
}

function fmtPrice(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  return n.toFixed(2);
}

function relativeTime(iso: string): string {
  const d = Date.now() - Date.parse(iso);
  const m = Math.floor(d / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function MarketBanner() {
  const { data: heartbeat, isLoading } = useLatestHeartbeat();

  const snap = (heartbeat?.current_reads as Record<string, unknown> | undefined)?._snapshot as Record<string, unknown> | undefined;
  const spxRaw = (heartbeat?.current_reads as Record<string, unknown> | undefined)?._macro as Record<string, unknown> | undefined;
  const macro = snap?.spx_macro as CondensedMacro | undefined;
  const tide = snap?.market_tide as {
    net_call_premium: number | null;
    net_put_premium: number | null;
    net_volume: number | null;
    timestamp: string | null;
  } | undefined;

  const netPremium = (tide?.net_call_premium ?? 0) - (tide?.net_put_premium ?? 0);
  const tideDirection: 'bull' | 'bear' | 'neutral' =
    Math.abs(netPremium) < 10_000_000 ? 'neutral' : netPremium > 0 ? 'bull' : 'bear';

  return (
    <Card className="p-4 bg-gradient-to-br from-muted/50 to-background border-border">
      <div className="flex items-center gap-2 mb-3">
        <Activity className="w-4 h-4 text-primary" />
        <h2 className="text-sm font-semibold text-foreground">Market State</h2>
        {heartbeat && (
          <span className="text-xs text-muted-foreground ml-auto">
            last pulse: {relativeTime(heartbeat.created_at)}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="text-muted-foreground text-sm">loading…</div>
      ) : !heartbeat ? (
        <div className="text-muted-foreground text-sm">no heartbeat yet — cron fires weekdays 13:00-20:59 UTC</div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-foreground/90 font-medium leading-relaxed">
            {heartbeat.status_line}
          </p>

          <div className="grid grid-cols-2 md:grid-cols-7 gap-3 text-xs">
            <div>
              <div className="text-muted-foreground">SPX</div>
              <div className="text-foreground font-semibold text-base">{fmtPrice(macro?.price ?? null)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Call Wall</div>
              <div className="text-foreground font-semibold text-base">{fmtPrice(macro?.call_wall ?? null)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Put Wall</div>
              <div className="text-foreground font-semibold text-base">{fmtPrice(macro?.put_wall ?? null)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Gamma Flip</div>
              <div className="text-foreground font-semibold text-base">{fmtPrice((macro as unknown as { gamma_flip?: number | null })?.gamma_flip ?? null)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Net Γ (SPX)</div>
              <div className={`font-semibold text-base ${(macro?.net_gamma_oi ?? 0) >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                {fmtLarge(macro?.net_gamma_oi ?? null)}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Tide (C-P prem)</div>
              <div className={`font-semibold text-base flex items-center gap-1 ${tideDirection === 'bull' ? 'text-green-500' : tideDirection === 'bear' ? 'text-red-500' : 'text-muted-foreground'}`}>
                {tideDirection === 'bull' ? <TrendingUp className="w-3 h-3" /> : tideDirection === 'bear' ? <TrendingDown className="w-3 h-3" /> : <Minus className="w-3 h-3" />}
                {fmtLarge(netPremium)}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Watching</div>
              <div className="text-foreground/70 text-xs font-medium">
                {heartbeat.watching?.length ?? 0} tickers
              </div>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
