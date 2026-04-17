/**
 * FlowTape — professional flow dashboard. Richer columns, badges, filters.
 * Canonical pro tool parity: time / ticker / strike-exp / side / size / prem /
 * IV / OI / vol/OI / tags. Row tint by directional bias. Badges for
 * sweep/block/split/golden-sweep/whale.
 */
import { useMemo, useState } from 'react';
import { useFlowAlerts, type FlowAlert } from '@/hooks/useCoTraderData';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Flame, Zap, Square, Triangle, Repeat } from 'lucide-react';

type SideFilter = 'all' | 'calls' | 'puts';
type DteFilter = 'all' | '0dte' | 'week' | 'month' | 'leaps';

function relTime(iso: string | null): string {
  if (!iso) return '—';
  const d = Date.now() - Date.parse(iso);
  const s = Math.floor(d / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
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

function fmtPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(0)}%`;
}

function isCall(side: string | null): boolean {
  return (side ?? '').toLowerCase().startsWith('c');
}

function daysToExpiry(expiry: string | null): number | null {
  if (!expiry) return null;
  const t = Date.parse(expiry);
  if (!Number.isFinite(t)) return null;
  return Math.ceil((t - Date.now()) / 86400000);
}

function dteBucket(dte: number | null): DteFilter {
  if (dte === null) return 'month';
  if (dte === 0) return '0dte';
  if (dte <= 7) return 'week';
  if (dte <= 45) return 'month';
  return 'leaps';
}

function getTags(alert: FlowAlert): string[] {
  const tags: string[] = [];
  const raw = alert.raw ?? {};
  if ((raw as Record<string, unknown>).tags && Array.isArray((raw as { tags: unknown[] }).tags)) {
    for (const t of (raw as { tags: string[] }).tags) if (typeof t === 'string') tags.push(t);
  }
  if ((raw as Record<string, unknown>).rule_name && Array.isArray((raw as { rule_name: unknown[] }).rule_name)) {
    for (const t of (raw as { rule_name: string[] }).rule_name) if (typeof t === 'string') tags.push(t);
  }
  return tags;
}

function hasTag(alert: FlowAlert, needle: string): boolean {
  const hay = [alert.alert_type?.toLowerCase(), ...getTags(alert).map(t => t.toLowerCase())];
  return hay.some(s => s?.includes(needle));
}

function isSweep(alert: FlowAlert): boolean { return hasTag(alert, 'sweep'); }
function isBlock(alert: FlowAlert): boolean { return hasTag(alert, 'block'); }
function isSplit(alert: FlowAlert): boolean { return hasTag(alert, 'split'); }
function isFloor(alert: FlowAlert): boolean { return hasTag(alert, 'floor'); }
function isGoldenSweep(alert: FlowAlert): boolean {
  return isSweep(alert) && (alert.premium ?? 0) >= 100_000 && alert.is_ask === true && alert.is_otm === true;
}

function iv(alert: FlowAlert): number | null {
  const raw = alert.raw as Record<string, unknown> | undefined;
  const v = raw?.iv ?? raw?.implied_volatility;
  if (v === undefined || v === null) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function openInterest(alert: FlowAlert): number | null {
  const raw = alert.raw as Record<string, unknown> | undefined;
  const v = raw?.open_interest ?? raw?.oi;
  if (v === undefined || v === null) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function volume(alert: FlowAlert): number | null {
  const raw = alert.raw as Record<string, unknown> | undefined;
  const v = raw?.volume ?? raw?.total_volume;
  if (v === undefined || v === null) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

export function FlowTape() {
  const { data: alerts, isLoading } = useFlowAlerts(100);
  const [minPremium, setMinPremium] = useState(0);
  const [sideFilter, setSideFilter] = useState<SideFilter>('all');
  const [dteFilter, setDteFilter] = useState<DteFilter>('all');
  const [sweepOnly, setSweepOnly] = useState(false);
  const [whaleOnly, setWhaleOnly] = useState(false);
  const [tickerFilter, setTickerFilter] = useState('');

  const filtered = useMemo(() => {
    return (alerts ?? []).filter(a => {
      if ((a.premium ?? 0) < minPremium) return false;
      if (sideFilter === 'calls' && !isCall(a.side)) return false;
      if (sideFilter === 'puts' && isCall(a.side)) return false;
      if (sweepOnly && !isSweep(a)) return false;
      if (whaleOnly && (a.premium ?? 0) < 1_000_000) return false;
      if (tickerFilter && !a.ticker.toLowerCase().includes(tickerFilter.toLowerCase())) return false;
      if (dteFilter !== 'all') {
        const dte = daysToExpiry(a.expiry);
        if (dteBucket(dte) !== dteFilter) return false;
      }
      return true;
    });
  }, [alerts, minPremium, sideFilter, dteFilter, sweepOnly, whaleOnly, tickerFilter]);

  return (
    <Card className="flex flex-col">
      <div className="px-3 py-2 border-b border-border bg-muted/30 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-foreground">Flow Tape</span>
          <span className="text-[10px] text-muted-foreground">{filtered.length}/{alerts?.length ?? 0}</span>
        </div>
      </div>

      {/* Filter stack */}
      <div className="px-3 py-2 border-b border-border bg-muted/10 flex items-center gap-2 flex-wrap text-[10px]">
        <Input
          value={tickerFilter}
          onChange={(e) => setTickerFilter(e.target.value)}
          placeholder="ticker"
          className="h-6 w-20 text-[11px]"
        />
        <select
          value={sideFilter}
          onChange={(e) => setSideFilter(e.target.value as SideFilter)}
          className="h-6 px-2 rounded bg-background border border-border text-[10px]"
        >
          <option value="all">all</option>
          <option value="calls">calls</option>
          <option value="puts">puts</option>
        </select>
        <select
          value={dteFilter}
          onChange={(e) => setDteFilter(e.target.value as DteFilter)}
          className="h-6 px-2 rounded bg-background border border-border text-[10px]"
        >
          <option value="all">all DTE</option>
          <option value="0dte">0DTE</option>
          <option value="week">≤7d</option>
          <option value="month">≤45d</option>
          <option value="leaps">LEAPS</option>
        </select>
        <Button
          size="sm"
          variant={sweepOnly ? 'default' : 'outline'}
          className="h-6 text-[10px] px-2"
          onClick={() => setSweepOnly(!sweepOnly)}
        >
          <Zap className="w-3 h-3 mr-0.5" />sweep
        </Button>
        <Button
          size="sm"
          variant={whaleOnly ? 'default' : 'outline'}
          className="h-6 text-[10px] px-2"
          onClick={() => setWhaleOnly(!whaleOnly)}
        >
          <Flame className="w-3 h-3 mr-0.5" />whale
        </Button>
        <select
          value={minPremium}
          onChange={(e) => setMinPremium(Number(e.target.value))}
          className="h-6 px-2 rounded bg-background border border-border text-[10px]"
        >
          <option value="0">min $0</option>
          <option value="50000">$50K+</option>
          <option value="100000">$100K+</option>
          <option value="250000">$250K+</option>
          <option value="500000">$500K+</option>
          <option value="1000000">$1M+</option>
        </select>
      </div>

      {isLoading ? (
        <div className="p-4 text-center text-xs text-muted-foreground">loading…</div>
      ) : filtered.length === 0 ? (
        <div className="p-4 text-center text-xs text-muted-foreground">
          {alerts?.length ? 'no flow matches filter' : 'no flow yet — ingester polls every 3min'}
        </div>
      ) : (
        <div className="max-h-[55vh] overflow-y-auto font-mono text-[10.5px]">
          {filtered.map(a => <FlowRow key={a.id} alert={a} />)}
        </div>
      )}
    </Card>
  );
}

function Badge({ icon, color, label }: { icon: React.ReactNode; color: string; label: string }) {
  return (
    <span className={`inline-flex items-center px-1 py-0 rounded text-[9px] gap-0.5 ${color}`} title={label}>
      {icon}
    </span>
  );
}

function FlowRow({ alert }: { alert: FlowAlert }) {
  const call = isCall(alert.side);
  const whale = (alert.premium ?? 0) >= 1_000_000;
  const aggressive = alert.is_ask === true;
  const sweep = isSweep(alert);
  const block = isBlock(alert);
  const split = isSplit(alert);
  const floor = isFloor(alert);
  const golden = isGoldenSweep(alert);
  const dte = daysToExpiry(alert.expiry);
  const oi = openInterest(alert);
  const vol = volume(alert);
  const volOi = vol && oi ? vol / oi : null;
  const implVol = iv(alert);
  const bias = call ? (aggressive ? 'bull' : 'soft-bull') : (aggressive ? 'bear' : 'soft-bear');
  const bgTint =
    golden ? 'bg-amber-500/10 border-l-2 border-l-amber-500' :
    whale ? 'bg-primary/5 border-l-2 border-l-primary' :
    bias === 'bull' ? 'bg-green-500/[0.03]' :
    bias === 'bear' ? 'bg-red-500/[0.03]' : '';
  const sideColor = call ? 'text-green-400' : 'text-red-400';

  return (
    <div className={`grid grid-cols-[42px_48px_1fr_auto_44px_56px_48px_52px_auto] items-center gap-1.5 px-3 py-1 hover:bg-muted/20 transition-colors ${bgTint}`}>
      <span className="text-muted-foreground">{relTime(alert.ingested_at)}</span>
      <span className="font-bold text-foreground">{alert.ticker}</span>
      <span className="truncate flex items-center gap-1">
        <span className={`font-semibold ${sideColor}`}>${alert.strike ?? '—'}{call ? 'C' : 'P'}</span>
        <span className="text-muted-foreground/70 text-[10px]">{alert.expiry ? alert.expiry.slice(5) : ''}</span>
        {dte !== null && dte <= 1 && <Badge icon={<Flame className="w-2.5 h-2.5" />} color="bg-red-500/20 text-red-400" label="0DTE" />}
        {alert.is_otm === true && <span className="text-muted-foreground/50 text-[9px]">OTM</span>}
      </span>
      <span className="flex items-center gap-0.5">
        {aggressive && <Badge icon={<span className="font-bold">A</span>} color="bg-primary/20 text-primary px-1" label="ask-side (aggressive buy)" />}
        {alert.size_gt_oi && <Badge icon={<span className="font-bold">OP</span>} color="bg-amber-500/20 text-amber-400 px-1" label="opening trade" />}
      </span>
      <span className={`text-right ${sideColor}`}>
        {sweep && <Zap className="w-3 h-3 inline text-orange-400" />}
        {block && <Square className="w-3 h-3 inline text-blue-400" />}
        {split && <Triangle className="w-3 h-3 inline text-yellow-400" />}
        {floor && <Repeat className="w-3 h-3 inline text-purple-400" />}
      </span>
      <span className="text-right text-foreground/70">{fmtSize(alert.size)}</span>
      <span className="text-right text-muted-foreground">
        {implVol !== null ? `${(implVol * 100).toFixed(0)}%` : '—'}
      </span>
      <span className="text-right text-muted-foreground">
        {volOi !== null ? `${volOi.toFixed(1)}x` : '—'}
      </span>
      <span className={`text-right font-semibold ${whale ? 'text-primary' : sideColor}`}>
        {whale && <Flame className="w-3 h-3 inline mr-0.5" />}
        {fmtMoney(alert.premium)}
      </span>
    </div>
  );
}
