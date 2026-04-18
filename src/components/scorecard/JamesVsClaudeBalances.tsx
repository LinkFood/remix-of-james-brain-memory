/**
 * JamesVsClaudeBalances — compact divergence header for the Scorecard.
 *
 * Shows current balance for James + Claude, last-7d P&L for each, and
 * correlation between their daily returns. Hard cap: under 150 lines.
 * If we need the full chart, link out to /workspace → Divergence tab.
 */
import { useMemo } from 'react';
import { Card } from '@/components/ui/card';
import { Link } from 'react-router-dom';
import { Users, ArrowRight, TrendingUp, TrendingDown } from 'lucide-react';
import { useClaudeBook, useJamesBook } from '@/hooks/useClaudeBook';
import type { CtBookRow } from '@/hooks/useCoTraderData';

function balanceOf(row: CtBookRow): number {
  return row.ending_balance
    ?? row.starting_balance + (row.realized_pnl ?? 0) + (row.unrealized_pnl ?? 0);
}

function last7dPct(history: CtBookRow[]): number | null {
  if (history.length === 0) return null;
  const cutoff = Date.now() - 7 * 86400_000;
  const window = history.filter(b => new Date(b.session_date).getTime() >= cutoff);
  if (window.length === 0) return null;
  const first = window[0];
  const last = window[window.length - 1];
  const startBal = first.starting_balance;
  const endBal = balanceOf(last);
  return startBal > 0 ? ((endBal - startBal) / startBal) * 100 : null;
}

/**
 * Pearson correlation between daily return % series. If we only have one
 * overlapping session it returns null — nothing to correlate.
 */
function dailyReturnCorrelation(james: CtBookRow[], claude: CtBookRow[]): number | null {
  const jMap = new Map<string, number>();
  for (const b of james) {
    const end = balanceOf(b);
    const ret = b.starting_balance > 0 ? (end - b.starting_balance) / b.starting_balance : 0;
    jMap.set(b.session_date, ret);
  }
  const cMap = new Map<string, number>();
  for (const b of claude) {
    const end = balanceOf(b);
    const ret = b.starting_balance > 0 ? (end - b.starting_balance) / b.starting_balance : 0;
    cMap.set(b.session_date, ret);
  }
  const common: Array<[number, number]> = [];
  for (const [d, j] of jMap.entries()) {
    const c = cMap.get(d);
    if (c != null) common.push([j, c]);
  }
  if (common.length < 2) return null;
  const n = common.length;
  const meanJ = common.reduce((s, p) => s + p[0], 0) / n;
  const meanC = common.reduce((s, p) => s + p[1], 0) / n;
  let num = 0, dJ = 0, dC = 0;
  for (const [j, c] of common) {
    const xj = j - meanJ;
    const xc = c - meanC;
    num += xj * xc;
    dJ += xj * xj;
    dC += xc * xc;
  }
  const denom = Math.sqrt(dJ * dC);
  if (!Number.isFinite(denom) || denom === 0) return null;
  return num / denom;
}

function fmtUsd(n: number): string {
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function fmtPct(n: number | null): string {
  if (n == null) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

export function JamesVsClaudeBalances() {
  const { data: james = [] } = useJamesBook();
  const { data: claude = [] } = useClaudeBook();

  const stats = useMemo(() => {
    const jLast = james[james.length - 1] ?? null;
    const cLast = claude[claude.length - 1] ?? null;
    return {
      jamesBal: jLast ? balanceOf(jLast) : null,
      claudeBal: cLast ? balanceOf(cLast) : null,
      james7d: last7dPct(james),
      claude7d: last7dPct(claude),
      corr: dailyReturnCorrelation(james, claude),
    };
  }, [james, claude]);

  const delta = (stats.claude7d ?? 0) - (stats.james7d ?? 0);

  return (
    <Card className="p-3">
      <div className="flex items-center gap-2 mb-2">
        <Users className="w-3.5 h-3.5 text-primary" />
        <span className="text-xs font-semibold">James vs Claude</span>
        <Link
          to="/workspace"
          className="ml-auto text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-0.5"
          title="Full chart + stats in Workspace > Divergence"
        >
          Divergence tab <ArrowRight className="w-3 h-3" />
        </Link>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
        <Tile title="James balance" value={stats.jamesBal == null ? '—' : fmtUsd(stats.jamesBal)} sub="current" />
        <Tile title="Claude balance" value={stats.claudeBal == null ? '—' : fmtUsd(stats.claudeBal)} sub="paper" />
        <Tile
          title="7d P&L"
          value={`${fmtPct(stats.james7d)} / ${fmtPct(stats.claude7d)}`}
          sub={`Δ ${fmtPct(delta)}`}
          toneValue={delta}
        />
        <Tile
          title="Return correlation"
          value={stats.corr == null ? '—' : stats.corr.toFixed(2)}
          sub={stats.corr == null
            ? 'need ≥2 overlap days'
            : stats.corr > 0.5 ? 'highly aligned'
            : stats.corr > 0 ? 'loosely aligned'
            : stats.corr > -0.5 ? 'mostly uncorrelated'
            : 'anti-correlated'}
        />
      </div>
    </Card>
  );
}

function Tile({ title, value, sub, toneValue }: {
  title: string;
  value: string;
  sub: string;
  toneValue?: number;
}) {
  const toneClass = toneValue == null
    ? 'text-foreground'
    : toneValue >= 0 ? 'text-green-400' : 'text-red-400';
  return (
    <div className="bg-muted/20 rounded px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
        {toneValue != null && (toneValue >= 0
          ? <TrendingUp className="w-3 h-3 text-green-400" />
          : <TrendingDown className="w-3 h-3 text-red-400" />)}
        {title}
      </div>
      <div className={`font-mono font-semibold text-sm ${toneClass}`}>{value}</div>
      <div className="text-[10px] text-muted-foreground">{sub}</div>
    </div>
  );
}
