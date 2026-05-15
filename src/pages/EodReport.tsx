/**
 * /eod-report — Close-to-open handoff (Co-Trader v2).
 *
 * One entry per trading day. Generated 5 PM ET by the ct-eod-report cron
 * — Sonnet's session close: graded morning brief, regime close, per-ticker
 * close cards, carryover thesis, overnight catalysts, tomorrow setup.
 *
 * UI mode (tenet 26): pure read-only window into ct_eod_reports. No
 * triggers, no analysis controls, no writes. Date-range filter chips
 * mirror /morning-brief (Today / 7d / 30d / All), defaulting to Today.
 *
 * Distinct from /eod (the older daily summary journal). They coexist —
 * /eod is the legacy narrative summary; /eod-report is the structured
 * close-to-open handoff.
 *
 * Schema reference: see useEodReport.ts for the full row shape.
 */

import { useMemo, useState } from 'react';
import {
  useEodReport,
  type EodReportDateRange,
  type EodReportRow,
  type ScorecardEntry,
  type TickerCloseCard as TickerCloseCardT,
  type OvernightCatalyst,
  type TomorrowWatchEntry,
  type SkipTomorrowEntry,
  type BreakingEventToday,
  type ScorecardSummary,
  type FlowRecapEntry,
  type StackRecapEntry,
  type RealizedRecapEntry,
} from '@/hooks/useEodReport';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  Moon,
  Calendar,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  Bell,
  TrendingUp,
  TrendingDown,
  Minus,
  Ban,
  Target,
  Eye,
  Lightbulb,
  ClipboardCheck,
  Sunrise,
  ArrowRight,
  Copy,
  Check,
  FileText,
  Zap,
  Layers,
  Flame,
} from 'lucide-react';

// ---------- formatters ----------

function formatDateET(dateStr: string): string {
  try {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dateObj = new Date(y, m - 1, d);
    return dateObj.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
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
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return iso;
  }
}

function formatPct(n: number | null | undefined, opts?: { sign?: boolean }): string {
  if (n == null || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  const sign = opts?.sign && v > 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}%`;
}

// ---------- color helpers (extracted inline — kept independent of MorningBrief) ----------

function tiltStyle(tilt: string): { card: string; chip: string; label: string } {
  const t = (tilt || '').toLowerCase();
  if (t.includes('long') || t === 'bull' || t === 'bullish') {
    return {
      card: 'border-emerald-500/30',
      chip: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
      label: tilt || 'LONG',
    };
  }
  if (t.includes('short') || t === 'bear' || t === 'bearish') {
    return {
      card: 'border-red-500/30',
      chip: 'bg-red-500/15 text-red-300 border-red-500/40',
      label: tilt || 'SHORT',
    };
  }
  if (t === 'avoid' || t === 'skip') {
    return {
      card: 'border-red-500/60 ring-1 ring-red-500/20',
      chip: 'bg-red-500/20 text-red-200 border-red-500/60',
      label: tilt || 'AVOID',
    };
  }
  return {
    card: 'border-border/60',
    chip: 'bg-slate-500/15 text-slate-300 border-slate-500/40',
    label: tilt || 'NEUTRAL',
  };
}

function severityStyle(sev: number): { ring: string; text: string; label: string } {
  if (sev >= 5) return { ring: 'border-red-500/60 bg-red-500/10', text: 'text-red-300', label: 'sev 5' };
  if (sev >= 4) return { ring: 'border-orange-500/50 bg-orange-500/10', text: 'text-orange-300', label: 'sev 4' };
  if (sev >= 3) return { ring: 'border-amber-500/50 bg-amber-500/10', text: 'text-amber-300', label: 'sev 3' };
  if (sev >= 2) return { ring: 'border-slate-500/40 bg-slate-500/10', text: 'text-slate-300', label: 'sev 2' };
  return { ring: 'border-muted bg-muted/20', text: 'text-muted-foreground', label: 'sev 1' };
}

function directionIcon(dir: string) {
  const d = (dir || '').toLowerCase();
  if (d.includes('long') || d === 'bull' || d === 'bullish') {
    return <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />;
  }
  if (d.includes('short') || d === 'bear' || d === 'bearish') {
    return <TrendingDown className="w-3.5 h-3.5 text-red-400" />;
  }
  if (d === 'avoid' || d === 'skip') return <Ban className="w-3.5 h-3.5 text-red-400" />;
  return <Minus className="w-3.5 h-3.5 text-muted-foreground" />;
}

// ---------- verdict / alignment chips ----------

function verdictStyle(v: ScorecardEntry['verdict']): {
  bg: string;
  text: string;
  border: string;
  label: string;
} {
  switch (v) {
    case 'win':
      return {
        bg: 'bg-emerald-500/15',
        text: 'text-emerald-300',
        border: 'border-emerald-500/40',
        label: 'WIN',
      };
    case 'partial':
      return {
        bg: 'bg-amber-500/15',
        text: 'text-amber-300',
        border: 'border-amber-500/40',
        label: 'PARTIAL',
      };
    case 'loss':
      return {
        bg: 'bg-red-500/15',
        text: 'text-red-300',
        border: 'border-red-500/40',
        label: 'LOSS',
      };
    case 'neutral':
    default:
      return {
        bg: 'bg-slate-500/15',
        text: 'text-slate-300',
        border: 'border-slate-500/40',
        label: 'NEUTRAL',
      };
  }
}

function alignmentStyle(a: TickerCloseCardT['alignment']): {
  bg: string;
  text: string;
  border: string;
  label: string;
} {
  switch (a) {
    case 'aligned':
      return {
        bg: 'bg-emerald-500/15',
        text: 'text-emerald-300',
        border: 'border-emerald-500/40',
        label: 'ALIGNED',
      };
    case 'partial':
      return {
        bg: 'bg-amber-500/15',
        text: 'text-amber-300',
        border: 'border-amber-500/40',
        label: 'PARTIAL',
      };
    case 'missed':
    default:
      return {
        bg: 'bg-red-500/15',
        text: 'text-red-300',
        border: 'border-red-500/40',
        label: 'MISSED',
      };
  }
}

// ---------- sub-components ----------

function ScorecardSummaryChip({ s }: { s: ScorecardSummary }) {
  const total = (s.wins ?? 0) + (s.partials ?? 0) + (s.neutrals ?? 0) + (s.losses ?? 0);
  if (s.score_pct == null) {
    return (
      <Card className="p-3 border-border/60">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
          Morning Brief Scorecard · EOD %
        </div>
        <div className="text-sm text-muted-foreground italic">
          No morning brief yesterday — nothing to grade.
        </div>
      </Card>
    );
  }

  const score = Number(s.score_pct ?? 0);
  let frame: string;
  let textColor: string;
  if (score >= 70) {
    frame = 'border-emerald-500/40 bg-emerald-500/5';
    textColor = 'text-emerald-300';
  } else if (score >= 50) {
    frame = 'border-amber-500/40 bg-amber-500/5';
    textColor = 'text-amber-300';
  } else {
    frame = 'border-red-500/50 bg-red-500/5';
    textColor = 'text-red-300';
  }

  const wp = (s.wins ?? 0) + (s.partials ?? 0);

  return (
    <Card className={cn('p-3 border', frame)}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <ClipboardCheck className={cn('w-4 h-4', textColor)} />
          <span
            className="text-[10px] uppercase tracking-wider text-muted-foreground"
            title="LLM grades morning brief per-ticker theses vs close. Distinct from /alarms tilt-streak (30d grader) + EOD slack contract-WIN-bar hit% (today)."
          >
            Morning Brief Scorecard · EOD %
          </span>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className={cn('text-2xl font-bold tabular-nums', textColor)}>
              {score.toFixed(0)}%
            </div>
            <div className="text-[10px] text-muted-foreground">
              {wp}/{total} hits
            </div>
          </div>
          <div className="flex items-center gap-1.5 text-[11px] font-mono">
            <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
              W {s.wins ?? 0}
            </span>
            <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">
              P {s.partials ?? 0}
            </span>
            <span className="px-1.5 py-0.5 rounded bg-slate-500/15 text-slate-300 border border-slate-500/30">
              N {s.neutrals ?? 0}
            </span>
            <span className="px-1.5 py-0.5 rounded bg-red-500/15 text-red-300 border border-red-500/30">
              L {s.losses ?? 0}
            </span>
          </div>
        </div>
      </div>
    </Card>
  );
}

function ScorecardEntryRow({ e }: { e: ScorecardEntry }) {
  const v = verdictStyle(e.verdict);
  return (
    <div className="rounded border border-border/60 bg-muted/10 p-2.5 space-y-1.5">
      <header className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-bold tracking-tight">{e.ticker}</span>
          <span
            className={cn(
              'text-[9px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded border',
              v.bg,
              v.text,
              v.border,
            )}
          >
            {v.label}
          </span>
          {e.alpha_pct != null && (
            <span
              className={cn(
                'text-[10px] font-mono tabular-nums px-1.5 py-0.5 rounded border',
                Number(e.alpha_pct) >= 0
                  ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                  : 'bg-red-500/10 text-red-300 border-red-500/30',
              )}
            >
              α {formatPct(e.alpha_pct, { sign: true })}
            </span>
          )}
        </div>
      </header>

      {(e.morning_call || e.actual_outcome) && (
        <div className="flex items-center gap-1.5 text-[11.5px] flex-wrap">
          {e.morning_call && (
            <span className="px-1.5 py-0.5 rounded bg-primary/10 border border-primary/25 text-foreground/85 font-mono">
              {e.morning_call}
            </span>
          )}
          {e.morning_call && e.actual_outcome && (
            <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0" />
          )}
          {e.actual_outcome && (
            <span className="px-1.5 py-0.5 rounded bg-muted/30 border border-border/60 text-foreground/85 font-mono">
              {e.actual_outcome}
            </span>
          )}
        </div>
      )}

      {e.morning_thesis && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          <span className="text-muted-foreground/60 uppercase tracking-wider text-[9px] mr-1">
            thesis:
          </span>
          {e.morning_thesis}
        </p>
      )}

      {e.commentary && (
        <p className="text-[12px] leading-relaxed italic text-foreground/80 border-l-2 border-primary/30 pl-2">
          {e.commentary}
        </p>
      )}
    </div>
  );
}

function TickerCloseCard({ tc }: { tc: TickerCloseCardT }) {
  const align = alignmentStyle(tc.alignment);
  const closeTilt = tiltStyle(tc.close_tilt);
  const sessionPct = Number(tc.session_pct ?? 0);
  const conf = Math.max(0, Math.min(1, Number(tc.confidence_close ?? 0)));

  return (
    <Card className={cn('p-3 space-y-2 border', closeTilt.card)}>
      <header className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-base font-bold tracking-tight">{tc.ticker}</span>
          {directionIcon(tc.close_tilt)}
        </div>
        <span
          className={cn(
            'text-[9px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded border shrink-0',
            align.bg,
            align.text,
            align.border,
          )}
        >
          {align.label}
        </span>
      </header>

      <div className="flex items-center gap-2 flex-wrap text-[11px]">
        <span className="text-muted-foreground/70 font-mono">
          {tc.open_tilt || '—'}
        </span>
        <ArrowRight className="w-3 h-3 text-muted-foreground/60" />
        <span
          className={cn(
            'px-1.5 py-0.5 rounded border font-mono',
            closeTilt.chip,
          )}
        >
          {closeTilt.label}
        </span>
        {tc.session_pct != null && (
          <span
            className={cn(
              'px-1.5 py-0.5 rounded border font-mono tabular-nums ml-auto',
              sessionPct > 0
                ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                : sessionPct < 0
                ? 'bg-red-500/10 text-red-300 border-red-500/30'
                : 'bg-muted/30 text-muted-foreground border-border/60',
            )}
          >
            {formatPct(tc.session_pct, { sign: true })}
          </span>
        )}
      </div>

      {(tc.flow_close || tc.specialist_close_read) && (
        <div className="flex items-start gap-3 text-[11px] text-foreground/80 leading-snug flex-wrap">
          {tc.flow_close && (
            <div className="min-w-0">
              <span className="text-muted-foreground/60 uppercase tracking-wider text-[9px] mr-1">
                flow:
              </span>
              <span className="font-mono">{tc.flow_close}</span>
            </div>
          )}
          {tc.specialist_close_read && (
            <div className="min-w-0">
              <span className="text-muted-foreground/60 uppercase tracking-wider text-[9px] mr-1">
                specialist:
              </span>
              <span>{tc.specialist_close_read}</span>
            </div>
          )}
        </div>
      )}

      {tc.carryover_thesis && (
        <p className="text-[12px] leading-relaxed text-foreground/90 italic border-l-2 border-primary/30 pl-2">
          {tc.carryover_thesis}
        </p>
      )}

      <div className="pt-1">
        <div className="flex items-center justify-between text-[9px] uppercase tracking-wider text-muted-foreground/70 mb-1">
          <span>confidence close</span>
          <span className="font-mono tabular-nums">{(conf * 100).toFixed(0)}%</span>
        </div>
        <div className="h-1 bg-muted/30 rounded-full overflow-hidden">
          <div
            className={cn(
              'h-full',
              conf >= 0.7
                ? 'bg-emerald-500/70'
                : conf >= 0.4
                ? 'bg-amber-500/70'
                : 'bg-red-500/70',
            )}
            style={{ width: `${(conf * 100).toFixed(1)}%` }}
          />
        </div>
      </div>
    </Card>
  );
}

function CatalystRow({ c }: { c: OvernightCatalyst }) {
  const tickers = Array.isArray(c.tickers) ? c.tickers : [];
  return (
    <div className="rounded border border-border/60 bg-muted/10 p-2 flex items-start gap-2">
      <Bell className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-300" />
      <div className="min-w-0 flex-1 text-[12px] leading-snug">
        <span className="font-mono text-muted-foreground mr-2">{c.when || '—'}</span>
        <span className="text-foreground/90">{c.event}</span>
        {tickers.length > 0 && (
          <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">
            {tickers.map((t) => (
              <span
                key={t}
                className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-primary/10 text-primary/90 border border-primary/25"
              >
                {t}
              </span>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}

function BreakingEventRow({ ev }: { ev: BreakingEventToday }) {
  const sev = severityStyle(Number(ev.severity ?? 1));
  return (
    <div className={cn('rounded border p-2 flex items-start gap-2', sev.ring)}>
      <AlertTriangle className={cn('w-3.5 h-3.5 mt-0.5 shrink-0', sev.text)} />
      <div className="min-w-0 flex-1">
        <div className="text-[12px] leading-snug text-foreground/90">{ev.headline}</div>
        <div className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-1.5">
          {ev.source && <span>{ev.source}</span>}
          {ev.source && <span className="text-muted-foreground/40">·</span>}
          <span className={cn('font-mono', sev.text)}>{sev.label}</span>
        </div>
      </div>
    </div>
  );
}

// ---------- Today's Tape rows ----------

function fmtNumPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  return `${v >= 0 ? '+' : ''}${v.toFixed(0)}%`;
}

function fmtPremium(usd: number | null | undefined, fallback?: string): string {
  if (fallback) return fallback;
  if (usd == null || !Number.isFinite(Number(usd))) return '—';
  const v = Math.abs(Number(usd));
  const sign = Number(usd) >= 0 ? '+' : '-';
  if (v >= 1_000_000) return `${sign}$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${sign}$${(v / 1_000).toFixed(0)}K`;
  return `${sign}$${v.toFixed(0)}`;
}

function recapDirChip(direction: string | null | undefined): { cls: string; label: string; Icon: typeof TrendingUp } {
  const d = (direction || '').toLowerCase();
  if (d.includes('bull') || d === 'up' || d === 'long') {
    return { cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40', label: 'BULL', Icon: TrendingUp };
  }
  if (d.includes('bear') || d === 'down' || d === 'short') {
    return { cls: 'bg-red-500/15 text-red-300 border-red-500/40', label: 'BEAR', Icon: TrendingDown };
  }
  return { cls: 'bg-slate-500/15 text-slate-300 border-slate-500/40', label: d.toUpperCase() || '—', Icon: Minus };
}

function FlowRecapRow({ f }: { f: FlowRecapEntry }) {
  const dir = recapDirChip(f.direction);
  const Icon = dir.Icon;
  const stackTag = f.stacking_prints != null && Number(f.stacking_prints) >= 5
    ? <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300 border border-sky-500/30">×{f.stacking_prints}</span>
    : null;
  return (
    <div className="rounded border border-border/60 bg-muted/10 p-2 space-y-1">
      <div className="flex items-start gap-2 flex-wrap">
        <span className="text-[11px] font-mono font-bold text-foreground tabular-nums">{f.ticker}</span>
        <span className="text-[11px] font-mono text-muted-foreground">{f.strike_expiry || f.contract}</span>
        <span className={cn('inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded border', dir.cls)}>
          <Icon className="w-3 h-3" /> {dir.label}
        </span>
        <span className="text-[11px] font-mono tabular-nums text-emerald-300 ml-auto">{fmtPremium(f.premium_usd, f.premium_fmt)}</span>
        {f.score != null && (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/30">
            {Math.round(Number(f.score))}
          </span>
        )}
        {stackTag}
        {f.ticker_unusual && (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">
            unusual
          </span>
        )}
      </div>
      {f.commentary && (
        <div className="text-[12px] leading-snug text-foreground/85 pl-1">{f.commentary}</div>
      )}
      <div className="text-[10px] text-muted-foreground/80 pl-1 flex items-center gap-2 flex-wrap">
        {f.event_time_tag && <span className="font-mono">{f.event_time_tag}</span>}
        {f.dte != null && <span>{f.dte}DTE</span>}
        {f.classification && <span className="font-mono">{f.classification}</span>}
      </div>
    </div>
  );
}

function StackRecapRow({ s }: { s: StackRecapEntry }) {
  const dir = recapDirChip(s.direction);
  const Icon = dir.Icon;
  const peakColor = s.peak_pct != null && Number(s.peak_pct) >= 50
    ? 'text-emerald-300' : s.peak_pct != null && Number(s.peak_pct) >= 0 ? 'text-foreground/80' : 'text-red-300';
  return (
    <div className="rounded border border-sky-500/25 bg-sky-500/5 p-2 space-y-1">
      <div className="flex items-start gap-2 flex-wrap">
        <span className="text-[11px] font-mono font-bold text-foreground tabular-nums">{s.ticker}</span>
        <span className="text-[11px] font-mono text-muted-foreground">{s.strike_expiry || s.contract}</span>
        <span className={cn('inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded border', dir.cls)}>
          <Icon className="w-3 h-3" /> {dir.label}
        </span>
        {s.prints != null && (
          <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-200 border border-sky-500/40 ml-auto">
            ×{s.prints}
          </span>
        )}
        {s.peak_pct != null && (
          <span className={cn('text-[11px] font-mono tabular-nums', peakColor)}>peak {fmtNumPct(s.peak_pct)}</span>
        )}
      </div>
      {s.commentary && (
        <div className="text-[12px] leading-snug text-foreground/85 pl-1">{s.commentary}</div>
      )}
      <div className="text-[10px] text-muted-foreground/80 pl-1 flex items-center gap-2 flex-wrap">
        {s.first_print_tag && <span className="font-mono">first {s.first_print_tag}</span>}
        {s.track_status && <span className="font-mono">{s.track_status.toLowerCase()}</span>}
        {s.current_pct != null && <span>now {fmtNumPct(s.current_pct)}</span>}
      </div>
    </div>
  );
}

function RealizedRecapRow({ r }: { r: RealizedRecapEntry }) {
  const dir = recapDirChip(r.direction);
  const Icon = dir.Icon;
  const peak = r.peak_pct != null ? Number(r.peak_pct) : null;
  const peakColor = peak == null ? 'text-muted-foreground'
    : peak >= 200 ? 'text-emerald-200 font-bold'
    : peak >= 100 ? 'text-emerald-300 font-bold'
    : peak >= 50 ? 'text-emerald-300' : 'text-foreground/80';
  return (
    <div className="rounded border border-amber-500/30 bg-amber-500/5 p-2 space-y-1">
      <div className="flex items-start gap-2 flex-wrap">
        <span className="text-[11px] font-mono font-bold text-foreground tabular-nums">{r.ticker}</span>
        <span className="text-[11px] font-mono text-muted-foreground">{r.strike_expiry || r.contract}</span>
        <span className={cn('inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded border', dir.cls)}>
          <Icon className="w-3 h-3" /> {dir.label}
        </span>
        <span className={cn('text-[13px] font-mono tabular-nums ml-auto', peakColor)}>
          {fmtNumPct(r.peak_pct)}
        </span>
        {r.time_to_milestone && r.time_to_milestone.minutes != null && (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/40">
            {r.time_to_milestone.pct}% in {r.time_to_milestone.minutes}m
          </span>
        )}
      </div>
      {r.commentary && (
        <div className="text-[12px] leading-snug text-foreground/85 pl-1">{r.commentary}</div>
      )}
      <div className="text-[10px] text-muted-foreground/80 pl-1 flex items-center gap-2 flex-wrap">
        {r.first_print_tag && <span className="font-mono">first {r.first_print_tag}</span>}
        {r.peak_at_tag && <span className="font-mono">peak {r.peak_at_tag}</span>}
        {r.entry_price != null && r.peak_price != null && (
          <span className="font-mono">${Number(r.entry_price).toFixed(2)} → ${Number(r.peak_price).toFixed(2)}</span>
        )}
        {r.prints != null && r.prints > 1 && <span>×{r.prints}</span>}
      </div>
    </div>
  );
}

function TomorrowChip({ w }: { w: TomorrowWatchEntry }) {
  const high = w.priority === 'high';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded border font-mono',
        high
          ? 'bg-red-500/10 text-red-200 border-red-500/50 ring-1 ring-red-500/20'
          : 'bg-amber-500/10 text-amber-200 border-amber-500/40',
      )}
      title={w.reason}
    >
      <span className="font-bold">{w.ticker}</span>
      <span className="text-foreground/70 font-sans">— {w.reason}</span>
    </span>
  );
}

function SkipChip({ s }: { s: SkipTomorrowEntry }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded border font-mono bg-red-500/10 text-red-300 border-red-500/40"
      title={s.reason}
    >
      <span className="font-bold line-through decoration-red-400/60">{s.ticker}</span>
      <span className="text-foreground/70 font-sans">— {s.reason}</span>
    </span>
  );
}

function ScriptBlock({ script }: { script: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(script);
      setCopied(true);
      toast.success('Script copied');
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Copy failed');
    }
  };

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={() => setOpen((o) => !o)}
          className="text-xs uppercase tracking-wider text-muted-foreground inline-flex items-center gap-1.5 hover:text-foreground"
        >
          {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          <FileText className="w-3.5 h-3.5" /> Script
        </button>
        {open && (
          <Button
            variant="ghost"
            size="sm"
            onClick={copy}
            className="text-[11px] h-6"
            aria-label="Copy script"
          >
            {copied ? (
              <>
                <Check className="w-3 h-3 mr-1" /> Copied
              </>
            ) : (
              <>
                <Copy className="w-3 h-3 mr-1" /> Copy
              </>
            )}
          </Button>
        )}
      </div>
      {open && (
        <pre className="text-[11.5px] leading-relaxed font-mono whitespace-pre-wrap rounded-md border border-border/60 bg-muted/15 p-3 text-foreground/85 max-h-[60vh] overflow-y-auto">
          {script}
        </pre>
      )}
    </section>
  );
}

// ---------- per-day section ----------

function ReportEntry({ row, defaultOpen }: { row: EodReportRow; defaultOpen: boolean }) {
  const [expanded, setExpanded] = useState(defaultOpen);

  const tickerCloses = Array.isArray(row.per_ticker_close) ? row.per_ticker_close : [];
  const scorecard = Array.isArray(row.morning_brief_scorecard) ? row.morning_brief_scorecard : [];
  const carryover = Array.isArray(row.carryover_themes) ? row.carryover_themes : [];
  const catalysts = Array.isArray(row.overnight_catalysts) ? row.overnight_catalysts : [];
  const breaking = Array.isArray(row.breaking_events_today) ? row.breaking_events_today : [];
  const tomorrow = Array.isArray(row.tomorrow_watchlist) ? row.tomorrow_watchlist : [];
  const skip = Array.isArray(row.skip_tomorrow) ? row.skip_tomorrow : [];
  const lessons = Array.isArray(row.lessons_today) ? row.lessons_today : [];
  const flowRecap = Array.isArray(row.flow_recap) ? row.flow_recap : [];
  const stackRecap = Array.isArray(row.stack_recap) ? row.stack_recap : [];
  const realizedRecap = Array.isArray(row.realized_recap) ? row.realized_recap : [];

  const summary: ScorecardSummary =
    row.scorecard_summary && typeof row.scorecard_summary === 'object'
      ? row.scorecard_summary
      : { wins: 0, partials: 0, neutrals: 0, losses: 0, score_pct: null };

  const [scorecardOpen, setScorecardOpen] = useState(false);

  return (
    <Card className="p-4 space-y-4">
      {/* Header */}
      <header className="flex items-start justify-between gap-3">
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Calendar className="w-4 h-4 text-muted-foreground" />
            <h2 className="text-base font-semibold tracking-tight">
              {formatDateET(row.session_date)}
            </h2>
            {row.regime_close && (
              <span className="text-[10px] uppercase tracking-wider font-medium px-2 py-0.5 rounded-full border border-primary/40 bg-primary/10 text-primary">
                close: {row.regime_close}
              </span>
            )}
            {row.regime_shift_today && (
              <span className="text-[10px] uppercase tracking-wider font-medium px-2 py-0.5 rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-300">
                shift: {row.regime_shift_today}
              </span>
            )}
          </div>
          <div className="text-[10px] text-muted-foreground flex items-center gap-2 flex-wrap">
            <span>by {row.generated_by_model || 'Sonnet'}</span>
            <span className="text-muted-foreground/40">·</span>
            <span>{formatGenAt(row.generated_at)}</span>
            {row.triggered_by && (
              <>
                <span className="text-muted-foreground/40">·</span>
                <span className="font-mono">{row.triggered_by}</span>
              </>
            )}
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded((e) => !e)}
          className="text-[11px] shrink-0"
        >
          {expanded ? (
            <>
              <ChevronDown className="w-3 h-3 mr-1" /> Collapse
            </>
          ) : (
            <>
              <ChevronRight className="w-3 h-3 mr-1" /> Expand
            </>
          )}
        </Button>
      </header>

      {/* Session summary — visible whether collapsed or open */}
      {row.session_summary && (
        <div className="text-sm leading-relaxed whitespace-pre-wrap text-foreground/90 border-l-2 border-primary/40 pl-3">
          {row.session_summary}
        </div>
      )}

      {/* Scorecard summary chip — always visible */}
      <ScorecardSummaryChip s={summary} />

      {expanded && (
        <>
          {/* Morning Brief Scorecard — collapsible body */}
          {scorecard.length > 0 && (
            <section className="space-y-2">
              <button
                onClick={() => setScorecardOpen((o) => !o)}
                className="w-full flex items-center justify-between gap-2 text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground"
              >
                <span className="inline-flex items-center gap-1.5">
                  {scorecardOpen ? (
                    <ChevronDown className="w-3 h-3" />
                  ) : (
                    <ChevronRight className="w-3 h-3" />
                  )}
                  <ClipboardCheck className="w-3.5 h-3.5" /> Morning Brief Scorecard
                  <span className="text-muted-foreground/60">({scorecard.length})</span>
                </span>
              </button>
              {scorecardOpen && (
                <div className="space-y-2">
                  {scorecard.map((e, i) => (
                    <ScorecardEntryRow key={`${e.ticker}-${i}`} e={e} />
                  ))}
                </div>
              )}
            </section>
          )}

          {/* Per-ticker close — 10-card grid */}
          {tickerCloses.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-xs uppercase tracking-wider text-muted-foreground inline-flex items-center gap-1.5">
                <Target className="w-3.5 h-3.5" /> Per-Ticker Close
                <span className="text-muted-foreground/60">({tickerCloses.length})</span>
              </h3>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
                {tickerCloses.map((tc, i) => (
                  <TickerCloseCard key={`${tc.ticker}-${i}`} tc={tc} />
                ))}
              </div>
            </section>
          )}

          {/* Today's Tape — flow / realized / stacks */}
          {(flowRecap.length > 0 || realizedRecap.length > 0 || stackRecap.length > 0) && (
            <section className="space-y-3">
              <h3 className="text-xs uppercase tracking-wider text-muted-foreground inline-flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5 text-amber-400" /> Today's Tape
                <span className="text-muted-foreground/60">
                  ({flowRecap.length} flow / {realizedRecap.length} realized / {stackRecap.length} stack)
                </span>
              </h3>

              {realizedRecap.length > 0 && (
                <div className="space-y-2">
                  <div className="text-[10px] uppercase tracking-wider text-amber-300 inline-flex items-center gap-1.5">
                    <Flame className="w-3 h-3" /> Top Realized
                  </div>
                  <div className="space-y-1.5">
                    {realizedRecap.map((r, i) => (
                      <RealizedRecapRow key={`r-${r.contract}-${i}`} r={r} />
                    ))}
                  </div>
                </div>
              )}

              {flowRecap.length > 0 && (
                <div className="space-y-2">
                  <div className="text-[10px] uppercase tracking-wider text-emerald-300 inline-flex items-center gap-1.5">
                    <Zap className="w-3 h-3" /> Top Scored Flows
                  </div>
                  <div className="space-y-1.5">
                    {flowRecap.map((f, i) => (
                      <FlowRecapRow key={`f-${f.contract}-${i}`} f={f} />
                    ))}
                  </div>
                </div>
              )}

              {stackRecap.length > 0 && (
                <div className="space-y-2">
                  <div className="text-[10px] uppercase tracking-wider text-sky-300 inline-flex items-center gap-1.5">
                    <Layers className="w-3 h-3" /> Stacking Conviction
                  </div>
                  <div className="space-y-1.5">
                    {stackRecap.map((s, i) => (
                      <StackRecapRow key={`s-${s.contract}-${i}`} s={s} />
                    ))}
                  </div>
                </div>
              )}
            </section>
          )}

          {/* Carryover themes */}
          {carryover.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-xs uppercase tracking-wider text-muted-foreground inline-flex items-center gap-1.5">
                <Sunrise className="w-3.5 h-3.5" /> Carryover Themes
                <span className="text-muted-foreground/60">({carryover.length})</span>
              </h3>
              <div className="flex flex-wrap gap-2">
                {carryover.map((c, i) => (
                  <div
                    key={i}
                    className="rounded border border-primary/25 bg-primary/5 px-2.5 py-1.5 text-[12px] leading-snug text-foreground/90 max-w-full"
                  >
                    {c}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Overnight catalysts */}
          {catalysts.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-xs uppercase tracking-wider text-muted-foreground inline-flex items-center gap-1.5">
                <Bell className="w-3.5 h-3.5" /> Overnight Catalysts
                <span className="text-muted-foreground/60">({catalysts.length})</span>
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {catalysts.map((c, i) => (
                  <CatalystRow key={i} c={c} />
                ))}
              </div>
            </section>
          )}

          {/* Tomorrow's watchlist + skip — paired chip rows */}
          {(tomorrow.length > 0 || skip.length > 0) && (
            <section className="space-y-2">
              <h3 className="text-xs uppercase tracking-wider text-muted-foreground inline-flex items-center gap-1.5">
                <Eye className="w-3.5 h-3.5" /> Tomorrow
                <span className="text-muted-foreground/60">
                  ({tomorrow.length} watch / {skip.length} skip)
                </span>
              </h3>
              {tomorrow.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {tomorrow.map((w, i) => (
                    <TomorrowChip key={`w-${w.ticker}-${i}`} w={w} />
                  ))}
                </div>
              )}
              {skip.length > 0 && (
                <div className="flex flex-wrap gap-2 items-center">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground inline-flex items-center gap-1">
                    <Ban className="w-3 h-3" /> Skip
                  </span>
                  {skip.map((s, i) => (
                    <SkipChip key={`s-${s.ticker}-${i}`} s={s} />
                  ))}
                </div>
              )}
            </section>
          )}

          {/* Breaking events today */}
          {breaking.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-xs uppercase tracking-wider text-muted-foreground inline-flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5" /> Breaking Events Today
                <span className="text-muted-foreground/60">({breaking.length})</span>
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {breaking.map((ev, i) => (
                  <BreakingEventRow key={i} ev={ev} />
                ))}
              </div>
            </section>
          )}

          {/* Lessons today */}
          {lessons.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-xs uppercase tracking-wider text-muted-foreground inline-flex items-center gap-1.5">
                <Lightbulb className="w-3.5 h-3.5" /> Lessons Today
                <span className="text-muted-foreground/60">({lessons.length})</span>
              </h3>
              <ul className="space-y-1.5">
                {lessons.map((l, i) => (
                  <li
                    key={i}
                    className="text-[12.5px] leading-relaxed text-foreground/90 pl-3 border-l-2 border-primary/40"
                  >
                    {l}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Script — collapsible at the bottom */}
          {row.script && <ScriptBlock script={row.script} />}

          {/* Footer metadata */}
          <div className="text-[10px] text-muted-foreground/80 leading-relaxed border-t border-border/40 pt-2 flex flex-wrap gap-x-3 gap-y-1">
            {row.generated_by_model && (
              <span>
                model: <span className="font-mono">{row.generated_by_model}</span>
              </span>
            )}
            {row.cost_usd != null && (
              <span>
                cost: <span className="font-mono">${Number(row.cost_usd).toFixed(4)}</span>
              </span>
            )}
            {row.tokens_in != null && (
              <span>
                tok in: <span className="font-mono">{row.tokens_in.toLocaleString()}</span>
              </span>
            )}
            {row.tokens_out != null && (
              <span>
                tok out: <span className="font-mono">{row.tokens_out.toLocaleString()}</span>
              </span>
            )}
            <span>
              id: <span className="font-mono">{row.id.slice(0, 8)}</span>
            </span>
          </div>
        </>
      )}
    </Card>
  );
}

// ---------- main page ----------

export default function EodReport() {
  const [range, setRange] = useState<EodReportDateRange>('today');
  const { data: rows, isLoading } = useEodReport(range);

  const latest = rows?.[0];

  const tickerCount = useMemo(
    () =>
      Array.isArray(latest?.per_ticker_close) ? latest!.per_ticker_close.length : 0,
    [latest],
  );

  const scoreLatest = useMemo(() => {
    const s = latest?.scorecard_summary;
    if (!s || s.score_pct == null) return null;
    return Number(s.score_pct);
  }, [latest]);

  const tomorrowCount = useMemo(
    () =>
      Array.isArray(latest?.tomorrow_watchlist) ? latest!.tomorrow_watchlist.length : 0,
    [latest],
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-5xl mx-auto p-4 space-y-4">
        <header>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Moon className="w-5 h-5 text-primary" />
            <span>EOD Report</span>
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Close-to-open handoff — graded morning brief, carryover, tomorrow's setup. Sonnet
            writes one row per session at 5 PM ET.
          </p>
        </header>

        {/* Top stats strip — mirrors /morning-brief */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card className="p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
              <Calendar className="w-3 h-3" /> Reports in range
            </div>
            <div className="text-2xl font-bold tabular-nums">{rows?.length ?? 0}</div>
            <div className="text-[10px] text-muted-foreground">
              {range === 'today' ? 'today' : range === 'all' ? 'all-time' : `last ${range}`}
            </div>
          </Card>
          <Card className="p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
              <Moon className="w-3 h-3" /> Latest
            </div>
            <div className="text-base font-bold">
              {latest?.session_date ? formatDateET(latest.session_date) : '—'}
            </div>
            <div className="text-[10px] text-muted-foreground">
              {latest?.regime_close ? `close: ${latest.regime_close}` : 'no regime'}
            </div>
          </Card>
          <Card className="p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
              <ClipboardCheck className="w-3 h-3" /> Brief score
            </div>
            <div className="text-2xl font-bold tabular-nums">
              {scoreLatest == null ? '—' : `${scoreLatest.toFixed(0)}%`}
            </div>
            <div className="text-[10px] text-muted-foreground">latest report</div>
          </Card>
          <Card className="p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
              <Eye className="w-3 h-3" /> Tomorrow watch
            </div>
            <div className="text-2xl font-bold tabular-nums">{tomorrowCount}</div>
            <div className="text-[10px] text-muted-foreground">
              {tickerCount} closes graded
            </div>
          </Card>
        </div>

        {/* Date range chips — mirrors /morning-brief */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground mr-1">When:</span>
          {(
            [
              { key: 'today', label: 'Today' },
              { key: '7d', label: '7d' },
              { key: '30d', label: '30d' },
              { key: 'all', label: 'All' },
            ] as const
          ).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setRange(key)}
              className={cn(
                'text-[11px] font-mono px-2 py-1 rounded border transition-colors',
                range === key
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-muted bg-muted/20 text-muted-foreground hover:text-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Body */}
        {isLoading && !rows ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            Loading EOD report…
          </Card>
        ) : !rows || rows.length === 0 ? (
          range === 'today' ? (
            <Card className="p-6 text-center text-sm text-muted-foreground space-y-2">
              <div>Today's EOD report hasn't fired yet.</div>
              <div className="text-xs">
                Cron lands ~5 PM ET weekdays. Switch to{' '}
                <span className="font-mono">7d</span> /{' '}
                <span className="font-mono">30d</span> to see prior reports.
              </div>
            </Card>
          ) : (
            <Card className="p-6 text-center text-sm text-muted-foreground space-y-1">
              <div>No EOD reports yet.</div>
              <Badge variant="outline" className="text-[10px] font-mono">
                cron fires 5 PM ET weekdays
              </Badge>
            </Card>
          )
        ) : (
          <div className="space-y-3">
            {rows.map((r, idx) => (
              <ReportEntry key={r.id} row={r} defaultOpen={idx === 0} />
            ))}
          </div>
        )}

        <div className="text-[10px] text-muted-foreground leading-relaxed">
          Cadence: 5 PM ET weekdays via the <span className="font-mono">ct-eod-report</span>{' '}
          cron. One row per session_date. Sources: morning brief grade-out, per-ticker close
          tilts, regime end-state, overnight catalysts, breaking news, tomorrow setup.
        </div>
      </div>
    </div>
  );
}
