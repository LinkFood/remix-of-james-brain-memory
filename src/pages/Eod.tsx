/**
 * /eod — End-of-day journal (Co-Trader v2).
 *
 * One entry per trading day. Generated 30 min after RTH close by
 * ct-eod-summary edge function. Each entry shows the Sonnet-written
 * narrative + collapsible JSON view of specialist_stats / ticker_stats /
 * market_stats.
 *
 * Top entry expanded by default, others collapsed. Pulls last 30 days
 * via TanStack Query. Refetches every 5 min so the day's summary lands
 * automatically when the cron fires at 20:30 UTC.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ClipboardList, Calendar, ChevronDown, ChevronRight, DollarSign, Activity } from 'lucide-react';

interface EodRow {
  id: number;
  session_date: string;
  summary_text: string;
  specialist_stats: Record<string, unknown> | null;
  ticker_stats: Record<string, unknown> | null;
  market_stats: Record<string, unknown> | null;
  generated_at: string | null;
  model: string | null;
  cost_usd: number | null;
}

function formatDateET(dateStr: string): string {
  try {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dateObj = new Date(y, m - 1, d);
    return dateObj.toLocaleDateString('en-US', {
      weekday: 'long', month: 'short', day: 'numeric', year: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

function formatGenAt(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-US', {
      timeZone: 'America/New_York',
      month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
  } catch {
    return iso;
  }
}

interface MarketStats {
  total_flags?: number;
  total_reads?: number;
  total_stacks?: number;
  unusual_pulse_count?: number;
  total_grades?: number;
  market_premium_open?: number | null;
  market_premium_close?: number | null;
  market_premium_delta?: number | null;
  grade_breakdown?: { win?: number; loss?: number; partial?: number; invalidated_early?: number };
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  const sign = v >= 0 ? '+' : '-';
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function StatsBlock({ label, data }: { label: string; data: Record<string, unknown> | null }) {
  const [open, setOpen] = useState(false);
  const isEmpty = !data || Object.keys(data).length === 0;
  return (
    <div className="border border-border/60 rounded-md bg-muted/10">
      <button
        onClick={() => setOpen(o => !o)}
        disabled={isEmpty}
        className={cn(
          'w-full flex items-center justify-between gap-2 px-3 py-2 text-left',
          'text-[11px] uppercase tracking-wider text-muted-foreground hover:bg-muted/20',
          isEmpty && 'cursor-not-allowed opacity-60',
        )}
      >
        <span className="flex items-center gap-1.5">
          {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          {label}
        </span>
        <span className="text-[10px]">
          {isEmpty ? 'empty' : `${Object.keys(data!).length} keys`}
        </span>
      </button>
      {open && data && (
        <pre className="text-[11px] font-mono leading-relaxed p-3 overflow-x-auto text-foreground/80 max-h-96 overflow-y-auto border-t border-border/60">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}

function EodEntry({ row, defaultOpen }: { row: EodRow; defaultOpen: boolean }) {
  const [expanded, setExpanded] = useState(defaultOpen);
  const market = (row.market_stats ?? {}) as MarketStats;
  const grades = market.grade_breakdown ?? {};

  return (
    <Card className="p-4 space-y-3">
      <header className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-muted-foreground" />
            <h2 className="text-base font-semibold tracking-tight">{formatDateET(row.session_date)}</h2>
          </div>
          <div className="text-[10px] text-muted-foreground flex items-center gap-2">
            <span>generated {formatGenAt(row.generated_at)}</span>
            {row.model && (
              <>
                <span className="text-muted-foreground/40">·</span>
                <span className="font-mono">{row.model}</span>
              </>
            )}
            {row.cost_usd != null && (
              <>
                <span className="text-muted-foreground/40">·</span>
                <span className="font-mono inline-flex items-center gap-0.5">
                  <DollarSign className="w-2.5 h-2.5" />
                  {Number(row.cost_usd).toFixed(4)}
                </span>
              </>
            )}
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded(e => !e)}
          className="text-[11px]"
        >
          {expanded ? (
            <><ChevronDown className="w-3 h-3 mr-1" /> Collapse</>
          ) : (
            <><ChevronRight className="w-3 h-3 mr-1" /> Expand</>
          )}
        </Button>
      </header>

      {/* Stat strip — visible whether collapsed or open */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-center">
        <div className="rounded bg-muted/15 p-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Flags</div>
          <div className="text-base font-bold tabular-nums">{market.total_flags ?? 0}</div>
        </div>
        <div className="rounded bg-muted/15 p-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Reads</div>
          <div className="text-base font-bold tabular-nums">{market.total_reads ?? 0}</div>
        </div>
        <div className="rounded bg-muted/15 p-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Stacks</div>
          <div className="text-base font-bold tabular-nums">{market.total_stacks ?? 0}</div>
        </div>
        <div className="rounded bg-muted/15 p-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Grades</div>
          <div className="text-base font-bold tabular-nums">
            <span className="text-emerald-400">{grades.win ?? 0}</span>
            <span className="text-muted-foreground/50">/</span>
            <span className="text-red-400">{grades.loss ?? 0}</span>
          </div>
          <div className="text-[10px] text-muted-foreground">W/L</div>
        </div>
        <div className="rounded bg-muted/15 p-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Net Δ</div>
          <div className="text-base font-bold tabular-nums">{fmtUsd(market.market_premium_delta)}</div>
        </div>
      </div>

      {expanded && (
        <>
          <div className="text-sm leading-relaxed whitespace-pre-wrap text-foreground/90 border-l-2 border-primary/40 pl-3">
            {row.summary_text}
          </div>

          <div className="space-y-2 pt-1">
            <StatsBlock label="Specialist stats" data={row.specialist_stats} />
            <StatsBlock label="Ticker stats" data={row.ticker_stats} />
            <StatsBlock label="Market stats" data={row.market_stats} />
          </div>
        </>
      )}
    </Card>
  );
}

export default function Eod() {
  const { data: rows, isLoading } = useQuery<EodRow[]>({
    queryKey: ['ct_eod_summaries_journal'],
    refetchInterval: 5 * 60_000, // 5 min — picks up the 20:30 UTC cron landing
    queryFn: async () => {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 30);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('ct_eod_summaries' as never) as any)
        .select('id, session_date, summary_text, specialist_stats, ticker_stats, market_stats, generated_at, model, cost_usd')
        .gte('session_date', cutoff.toISOString().slice(0, 10))
        .order('session_date', { ascending: false })
        .limit(30);
      if (error) throw error;
      return (data ?? []) as EodRow[];
    },
  });

  const totalCost = useMemo(() => {
    if (!rows) return 0;
    return rows.reduce((sum, r) => sum + (Number(r.cost_usd) || 0), 0);
  }, [rows]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-4xl mx-auto p-4 space-y-4">
        <header>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <ClipboardList className="w-5 h-5 text-primary" />
            <span>EOD Journal</span>
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            One entry per trading day. Sonnet writes the narrative 30 min after RTH close (20:30 UTC). Specialist + ticker + market stats inline; expand for the full read.
          </p>
        </header>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <Card className="p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
              <Calendar className="w-3 h-3" /> Days captured
            </div>
            <div className="text-2xl font-bold tabular-nums">{rows?.length ?? 0}</div>
            <div className="text-[10px] text-muted-foreground">last 30 days</div>
          </Card>
          <Card className="p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
              <Activity className="w-3 h-3" /> Latest entry
            </div>
            <div className="text-base font-bold">
              {rows?.[0]?.session_date ? formatDateET(rows[0].session_date) : '—'}
            </div>
            <div className="text-[10px] text-muted-foreground">most recent close</div>
          </Card>
          <Card className="p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
              <DollarSign className="w-3 h-3" /> 30-day cost
            </div>
            <div className="text-2xl font-bold tabular-nums">${totalCost.toFixed(2)}</div>
            <div className="text-[10px] text-muted-foreground">Sonnet 4.6</div>
          </Card>
        </div>

        {isLoading && !rows ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">Loading EOD journal…</Card>
        ) : !rows || rows.length === 0 ? (
          <Card className="p-6 text-center text-sm text-muted-foreground space-y-2">
            <div>No EOD summaries yet.</div>
            <div className="text-xs">First one fires at 20:30 UTC on the next weekday close. Until then, manually invoke <code className="font-mono">ct-eod-summary</code> to bootstrap today's entry.</div>
          </Card>
        ) : (
          <div className="space-y-3">
            {rows.map((r, idx) => (
              <EodEntry key={r.id} row={r} defaultOpen={idx === 0} />
            ))}
          </div>
        )}

        <div className="text-[10px] text-muted-foreground leading-relaxed">
          Cadence: 30 min after RTH close (20:30 UTC weekdays). Aggregates flags, grades, specialist reads, scored flow, contract stacking, FlowPulse open vs close, tape commentary first vs last, and watchlist underlying day moves into a Sonnet-written narrative + structured stats.
        </div>
      </div>
    </div>
  );
}
