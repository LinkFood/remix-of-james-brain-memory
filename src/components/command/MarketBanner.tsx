import { useLatestHeartbeat } from '@/hooks/useCoTraderData';
import { Card } from '@/components/ui/card';
import { Activity, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { GexMiniChart } from './GexMiniChart';

interface Wall { strike: number; gex: number; distance_pct: number }

interface CondensedMacro {
  price: number | null;
  call_wall: number | null;
  put_wall: number | null;
  gamma_flip: number | null;
  regime?: 'positive' | 'negative' | 'unknown';
  call_walls?: Wall[];
  put_walls?: Wall[];
  net_gamma_oi: number | null;
  total_call_gamma_oi: number | null;
  total_put_gamma_oi: number | null;
  near_atm_strikes?: Array<{ strike: number; call_gex: number; put_gex: number; net: number }>;
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

  const flipDistPct = macro?.price && macro?.gamma_flip
    ? ((macro.price - macro.gamma_flip) / macro.gamma_flip) * 100
    : null;
  const regime = macro?.regime ?? 'unknown';

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
          {/* Regime banner — big, first thing you see */}
          {regime !== 'unknown' && flipDistPct !== null && (
            <div className={`flex items-center justify-between px-3 py-2 rounded-md text-sm font-semibold ${
              regime === 'positive'
                ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
            }`}>
              <span>
                SPX regime: {regime === 'positive' ? 'POSITIVE Γ — mean-revert / vol-compressed' : 'NEGATIVE Γ — momentum / vol-expanded'}
              </span>
              <span className="text-foreground/70 font-mono text-xs">
                spot {flipDistPct >= 0 ? '+' : ''}{flipDistPct.toFixed(2)}% vs flip
              </span>
            </div>
          )}

          <p className="text-sm text-foreground/90 font-medium leading-relaxed">
            {heartbeat.status_line}
          </p>

          <div className="grid grid-cols-1 lg:grid-cols-[2fr_3fr] gap-4">
            {/* Left: scalar metrics */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
              <div>
                <div className="text-muted-foreground">SPX</div>
                <div className="text-foreground font-semibold text-base">{fmtPrice(macro?.price ?? null)}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Gamma Flip</div>
                <div className="text-foreground font-semibold text-base">{fmtPrice(macro?.gamma_flip ?? null)}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Net Γ</div>
                <div className={`font-semibold text-base ${(macro?.net_gamma_oi ?? 0) >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                  {fmtLarge(macro?.net_gamma_oi ?? null)}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Tide (C-P)</div>
                <div className={`font-semibold text-base flex items-center gap-1 ${tideDirection === 'bull' ? 'text-green-500' : tideDirection === 'bear' ? 'text-red-500' : 'text-muted-foreground'}`}>
                  {tideDirection === 'bull' ? <TrendingUp className="w-3 h-3" /> : tideDirection === 'bear' ? <TrendingDown className="w-3 h-3" /> : <Minus className="w-3 h-3" />}
                  {fmtLarge(netPremium)}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Call Walls</div>
                <div className="text-orange-400 font-medium text-[11px] leading-tight">
                  {(macro?.call_walls ?? []).slice(0, 3).map(w => `$${fmtPrice(w.strike)}`).join(' · ') || '—'}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Put Walls</div>
                <div className="text-blue-400 font-medium text-[11px] leading-tight">
                  {(macro?.put_walls ?? []).slice(0, 3).map(w => `$${fmtPrice(w.strike)}`).join(' · ') || '—'}
                </div>
              </div>
            </div>

            {/* Right: SPX gamma distribution mini-chart */}
            <div>
              <div className="text-[10px] text-muted-foreground mb-1 uppercase tracking-wider">SPX gamma distribution near ATM</div>
              <GexMiniChart
                strikes={macro?.near_atm_strikes ?? []}
                price={macro?.price ?? null}
                flip={macro?.gamma_flip ?? null}
              />
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
