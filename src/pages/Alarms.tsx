/**
 * /alarms — Real-time signature-alarm calibration page.
 *
 * James reads this page when Slack is OFF (calibration mode). Every row in
 * ct_flags with source='signature_alarm' surfaces here, sorted newest first,
 * with realtime push for new INSERTs. Outcome chips read from
 * ct_contract_tracks via source_flow_ids[0] = alert_id.
 *
 * Filter chips: tier (gold/silver/bronze), type (live/replay), day window.
 * Slack toggle pill is read-only — the page does not let James flip it from
 * here; that happens in /ct-settings (or via direct ct_config update).
 */

import { useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { Bell, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';
import {
  useAlarms,
  type AlarmRow,
  type AlarmTierFilter,
  type AlarmTypeFilter,
  type AlarmDayFilter,
  type AlarmDetectorFilter,
  type AlarmRegime,
  type AlarmRegimeFilter,
  type ContractOutcome,
} from '@/hooks/useAlarms';
import { useSlackToggleStatus } from '@/hooks/useSlackToggleStatus';

const TIER_EMOJI: Record<string, string> = {
  gold: '🥇',
  silver: '🥈',
  bronze: '🥉',
  unknown: '⚡',
};

function timeEt(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'America/New_York',
    });
  } catch {
    return iso.slice(11, 16);
  }
}

function dteFromExpiry(expiry: string | null): number | null {
  if (!expiry) return null;
  const [y, m, d] = expiry.split('-').map(Number);
  if (!y || !m || !d) return null;
  // Anchor on midnight UTC of expiry vs midnight UTC today — close-enough for label.
  const expMs = Date.UTC(y, m - 1, d);
  const todayMs = Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate(),
  );
  return Math.round((expMs - todayMs) / 86_400_000);
}

function tierBadgeColor(tier: string): string {
  if (tier === 'gold') return 'border-yellow-400/60 bg-yellow-500/10 text-yellow-200';
  if (tier === 'silver') return 'border-slate-300/40 bg-slate-400/10 text-slate-100';
  if (tier === 'bronze') return 'border-amber-700/40 bg-amber-700/10 text-amber-300';
  return 'border-muted bg-muted/20 text-muted-foreground';
}

function sideColor(side: 'call' | 'put' | null): string {
  if (side === 'call') return 'text-emerald-300';
  if (side === 'put') return 'text-rose-300';
  return 'text-muted-foreground';
}

function OutcomeChip({ outcome }: { outcome: ContractOutcome | undefined }) {
  if (!outcome) {
    return <span className="text-[10px] text-muted-foreground/60 tabular-nums">—</span>;
  }
  const { status, peakPct, currentPct } = outcome;
  // peakPct / currentPct from ct_contract_tracks are decimals (e.g. 2.74 = +274%).
  const pctLabel = (n: number) => `${n >= 0 ? '+' : ''}${(n * 100).toFixed(0)}%`;
  if (status === 'WIN') {
    return (
      <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/15 text-emerald-200 text-[10px] font-mono px-1.5 py-0">
        WIN {pctLabel(peakPct)}
      </Badge>
    );
  }
  if (status === 'LOSS') {
    return (
      <Badge variant="outline" className="border-rose-500/40 bg-rose-500/15 text-rose-200 text-[10px] font-mono px-1.5 py-0">
        LOSS {pctLabel(currentPct)}
      </Badge>
    );
  }
  if (status === 'WORKING') {
    return (
      <Badge variant="outline" className="border-emerald-500/25 bg-emerald-500/[0.06] text-emerald-300 text-[10px] font-mono px-1.5 py-0">
        WORKING {pctLabel(currentPct)}
      </Badge>
    );
  }
  if (status === 'EXPIRED') {
    return (
      <Badge variant="outline" className="border-slate-500/40 bg-slate-500/15 text-slate-300 text-[10px] font-mono px-1.5 py-0">
        EXP {pctLabel(peakPct)}
      </Badge>
    );
  }
  return <span className="text-[10px] text-muted-foreground/60 tabular-nums">—</span>;
}

function ThesisCell({ thesis }: { thesis: string | null }) {
  const [expanded, setExpanded] = useState(false);
  if (!thesis) return <span className="text-muted-foreground/60">—</span>;
  const isLong = thesis.length > 100;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); setExpanded((x) => !x); }}
      className="text-left text-[11px] leading-snug text-foreground/85 hover:text-foreground transition-colors max-w-[420px]"
    >
      <span className={cn(!expanded && 'line-clamp-2')}>{thesis}</span>
      {isLong && (
        <span className="ml-1 inline-flex items-center text-muted-foreground">
          {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </span>
      )}
    </button>
  );
}

const REGIME_EMOJI: Record<AlarmRegime, string> = {
  trending_up: '🟢',
  trending_down: '🔴',
  chop: '🟡',
  unknown: '⚪',
};

const REGIME_LABEL: Record<AlarmRegime, string> = {
  trending_up: 'up',
  trending_down: 'down',
  chop: 'chop',
  unknown: '—',
};

const REGIME_COLOR: Record<AlarmRegime, string> = {
  trending_up: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200',
  trending_down: 'border-rose-500/40 bg-rose-500/10 text-rose-200',
  chop: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
  unknown: 'border-muted bg-muted/20 text-muted-foreground',
};

// Compact USD-thousands formatter for inline pulse net premium (signed).
function fmtPremiumK(net: number | null): string {
  if (net == null || !Number.isFinite(net)) return '—';
  const k = net / 1000;
  const sign = k >= 0 ? '+' : '−';
  const abs = Math.abs(k);
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(1)}M`;
  return `${sign}$${abs.toFixed(0)}k`;
}

function RegimeCell({ alarm }: { alarm: AlarmRow }) {
  const regime = alarm.pulseRegime;
  const premiumLabel = fmtPremiumK(alarm.pulseNetPremium);
  return (
    <div className="flex flex-col items-start gap-0.5">
      <Badge
        variant="outline"
        className={cn('text-[10px] font-mono px-1.5 py-0', REGIME_COLOR[regime])}
        title={`Pulse net premium ${premiumLabel} · slope ${
          alarm.pulseSlope5min != null ? `${(alarm.pulseSlope5min / 1000).toFixed(1)}k/min` : 'n/a'
        }`}
      >
        <span className="mr-0.5">{REGIME_EMOJI[regime]}</span>
        {REGIME_LABEL[regime]}
      </Badge>
      <span className="text-[9px] font-mono tabular-nums text-muted-foreground">
        {premiumLabel}
      </span>
    </div>
  );
}

function AlarmRowView({
  alarm,
  outcome,
}: {
  alarm: AlarmRow;
  outcome: ContractOutcome | undefined;
}) {
  const dte = dteFromExpiry(alarm.expiry);
  return (
    <tr className="border-b border-border/40 hover:bg-muted/20 transition-colors">
      <td className="px-2 py-1.5 text-[11px] font-mono text-muted-foreground tabular-nums whitespace-nowrap">
        {timeEt(alarm.createdAt)}
      </td>
      <td className="px-2 py-1.5">
        <Badge
          variant="outline"
          className={cn('text-[10px] font-mono px-1.5 py-0', tierBadgeColor(alarm.tier))}
        >
          <span className="mr-0.5">{TIER_EMOJI[alarm.tier] ?? TIER_EMOJI.unknown}</span>
          {alarm.tier}
        </Badge>
      </td>
      <td className="px-2 py-1.5 whitespace-nowrap">
        <RegimeCell alarm={alarm} />
      </td>
      <td className="px-2 py-1.5 text-[12px] font-mono font-semibold whitespace-nowrap">
        {alarm.ticker || '—'}
      </td>
      <td className={cn('px-2 py-1.5 text-[11px] font-mono uppercase whitespace-nowrap', sideColor(alarm.side))}>
        {alarm.side ?? '—'}
      </td>
      <td className="px-2 py-1.5 text-[11px] font-mono tabular-nums text-right whitespace-nowrap">
        {alarm.strike != null ? `$${alarm.strike}` : '—'}
      </td>
      <td className="px-2 py-1.5 text-[11px] font-mono tabular-nums whitespace-nowrap">
        {alarm.expiry ? alarm.expiry.slice(5) : '—'}
        {dte != null && (
          <span className="ml-1 text-[9px] text-muted-foreground">
            ({dte}d)
          </span>
        )}
      </td>
      <td className="px-2 py-1.5 text-[11px] font-mono tabular-nums text-right whitespace-nowrap">
        {alarm.score ?? '—'}
      </td>
      <td className="px-2 py-1.5 text-[10px] font-mono whitespace-nowrap text-muted-foreground">
        {alarm.detectorId ?? '—'}
      </td>
      <td className="px-2 py-1.5">
        <ThesisCell thesis={alarm.thesis} />
      </td>
      <td className="px-2 py-1.5 whitespace-nowrap">
        <OutcomeChip outcome={outcome} />
      </td>
      <td className="px-2 py-1.5 whitespace-nowrap">
        {alarm.isReplay && (
          <span className="text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border border-slate-500/40 bg-slate-500/10 text-slate-400">
            replay
          </span>
        )}
      </td>
    </tr>
  );
}

export default function Alarms() {
  const [tierFilter, setTierFilter] = useState<AlarmTierFilter>('all');
  const [typeFilter, setTypeFilter] = useState<AlarmTypeFilter>('all');
  const [dayFilter, setDayFilter] = useState<AlarmDayFilter>('today');
  const [detectorFilter, setDetectorFilter] = useState<AlarmDetectorFilter>('all');
  const [regimeFilter, setRegimeFilter] = useState<AlarmRegimeFilter>('all');

  // Pull the unfiltered set first so the detector chip always shows every
  // value present in the day window — narrowing the chip otherwise hides
  // the option that would un-narrow it.
  const { alarms: alarmsUnfilteredByDetector } = useAlarms({
    tier: tierFilter,
    type: typeFilter,
    dayFilter,
    detector: 'all',
    regime: regimeFilter,
  });
  const { alarms, outcomes, isLoading, refetch } = useAlarms({
    tier: tierFilter,
    type: typeFilter,
    dayFilter,
    detector: detectorFilter,
    regime: regimeFilter,
  });
  const slack = useSlackToggleStatus();

  // Counts per-tier across the current filtered set — drives the secondary
  // chip readout and helps James see distribution at a glance.
  const tierCounts = useMemo(() => {
    const c = { gold: 0, silver: 0, bronze: 0, unknown: 0 };
    for (const a of alarms) c[a.tier]++;
    return c;
  }, [alarms]);

  const replayCount = useMemo(() => alarms.filter((a) => a.isReplay).length, [alarms]);
  const liveCount = alarms.length - replayCount;

  // Detector chip values — distinct detector_ids found in the broader set.
  const detectorOptions = useMemo(() => {
    const set = new Set<string>();
    for (const a of alarmsUnfilteredByDetector) {
      if (a.detectorId) set.add(a.detectorId);
    }
    return Array.from(set).sort();
  }, [alarmsUnfilteredByDetector]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-[1600px] mx-auto p-4 space-y-4">
        <header className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Bell className="w-5 h-5 text-primary" />
              <span>Signature Alarms</span>
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Calibration feed. Every signature-alarm fire — read this page when Slack is off.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {/* Slack toggle pill — read-only display. Linkable to a future
                /ct-settings#alarms anchor; for now the page is informational. */}
            <a
              href="/ct-settings"
              className={cn(
                'text-[11px] font-mono px-2 py-1 rounded border transition-colors',
                slack.enabled
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'
                  : 'border-slate-500/40 bg-slate-500/10 text-slate-300 hover:bg-slate-500/20',
              )}
              title={slack.enabled
                ? `Slack push enabled (min tier: ${slack.minTier})`
                : 'Slack push disabled — page is the only alarm surface'}
            >
              {slack.isLoading
                ? 'Slack: …'
                : `Slack: ${slack.enabled ? 'ON' : 'OFF'}${slack.enabled ? ` ${slack.minTier}+` : ''}`}
            </a>
            <Button size="sm" variant="outline" onClick={() => refetch()} className="text-xs">
              <RefreshCw className="w-3 h-3 mr-1" />
              Refresh
            </Button>
          </div>
        </header>

        {/* Filter strip */}
        <Card className="p-3 space-y-3">
          {/* Tier */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground mr-1">Tier:</span>
            {([
              ['all', 'All'],
              ['gold', '🥇 Gold'],
              ['silver', '🥈 Silver'],
              ['bronze', '🥉 Bronze'],
            ] as const).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setTierFilter(k)}
                className={cn(
                  'text-[11px] font-mono px-2 py-1 rounded border transition-colors',
                  tierFilter === k
                    ? 'border-primary/40 bg-primary/10 text-primary'
                    : 'border-muted bg-muted/20 text-muted-foreground hover:text-foreground',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Type */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground mr-1">Type:</span>
            {([
              ['all', 'All'],
              ['live', 'Live'],
              ['replay', 'Replay'],
            ] as const).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setTypeFilter(k)}
                className={cn(
                  'text-[11px] font-mono px-2 py-1 rounded border transition-colors',
                  typeFilter === k
                    ? 'border-primary/40 bg-primary/10 text-primary'
                    : 'border-muted bg-muted/20 text-muted-foreground hover:text-foreground',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Regime — Pulse-at-fire-time (tenet 9). */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground mr-1">Regime:</span>
            {([
              ['all', 'All'],
              ['trending_up', '🟢 Up'],
              ['trending_down', '🔴 Down'],
              ['chop', '🟡 Chop'],
              ['unknown', '⚪ Unknown'],
            ] as const).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setRegimeFilter(k)}
                className={cn(
                  'text-[11px] font-mono px-2 py-1 rounded border transition-colors',
                  regimeFilter === k
                    ? 'border-primary/40 bg-primary/10 text-primary'
                    : 'border-muted bg-muted/20 text-muted-foreground hover:text-foreground',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Day */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground mr-1">Day:</span>
            {([
              ['today', 'Today'],
              ['yesterday', 'Yesterday'],
              ['last3d', 'Last 3d'],
              ['all', 'All'],
            ] as const).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setDayFilter(k)}
                className={cn(
                  'text-[11px] font-mono px-2 py-1 rounded border transition-colors',
                  dayFilter === k
                    ? 'border-primary/40 bg-primary/10 text-primary'
                    : 'border-muted bg-muted/20 text-muted-foreground hover:text-foreground',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Detector — populated from distinct detector_id values in the
              current day window. Detector portfolio is first-class — the
              user filters by which detector fired, not by tier alone. */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground mr-1">Detector:</span>
            <button
              onClick={() => setDetectorFilter('all')}
              className={cn(
                'text-[11px] font-mono px-2 py-1 rounded border transition-colors',
                detectorFilter === 'all'
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-muted bg-muted/20 text-muted-foreground hover:text-foreground',
              )}
            >
              All
            </button>
            {detectorOptions.map((id) => (
              <button
                key={id}
                onClick={() => setDetectorFilter(id)}
                className={cn(
                  'text-[11px] font-mono px-2 py-1 rounded border transition-colors',
                  detectorFilter === id
                    ? 'border-primary/40 bg-primary/10 text-primary'
                    : 'border-muted bg-muted/20 text-muted-foreground hover:text-foreground',
                )}
                title={id}
              >
                {id}
              </button>
            ))}
            {detectorOptions.length === 0 && (
              <span className="text-[10px] text-muted-foreground/60 italic">
                no detector_id stamped yet — wait for next watcher sweep
              </span>
            )}
          </div>

          <div className="text-[10px] text-muted-foreground tabular-nums flex items-center gap-3 pt-1 border-t border-border/40">
            <span>
              <span className="text-foreground font-semibold">{alarms.length}</span> total
            </span>
            <span>
              🥇 <span className="text-yellow-200 font-semibold">{tierCounts.gold}</span>
            </span>
            <span>
              🥈 <span className="text-slate-100 font-semibold">{tierCounts.silver}</span>
            </span>
            <span>
              🥉 <span className="text-amber-300 font-semibold">{tierCounts.bronze}</span>
            </span>
            <span className="ml-3">
              live <span className="text-emerald-300 font-semibold">{liveCount}</span>
              {' · '}
              replay <span className="text-slate-400 font-semibold">{replayCount}</span>
            </span>
          </div>
        </Card>

        {/* Table */}
        {isLoading && alarms.length === 0 ? (
          <Card className="p-8 text-center text-sm text-muted-foreground">
            Loading alarms…
          </Card>
        ) : alarms.length === 0 ? (
          <Card className="p-8 text-center text-sm text-muted-foreground">
            No alarms in this window. Try widening the day filter or check that
            ct-signature-watcher is running.
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-muted/30 border-b border-border">
                  <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    <th className="px-2 py-2 text-left font-medium">Time ET</th>
                    <th className="px-2 py-2 text-left font-medium">Tier</th>
                    <th className="px-2 py-2 text-left font-medium">Regime</th>
                    <th className="px-2 py-2 text-left font-medium">Ticker</th>
                    <th className="px-2 py-2 text-left font-medium">Side</th>
                    <th className="px-2 py-2 text-right font-medium">Strike</th>
                    <th className="px-2 py-2 text-left font-medium">Expiry</th>
                    <th className="px-2 py-2 text-right font-medium">Score</th>
                    <th className="px-2 py-2 text-left font-medium">Detector</th>
                    <th className="px-2 py-2 text-left font-medium">Thesis</th>
                    <th className="px-2 py-2 text-left font-medium">Outcome</th>
                    <th className="px-2 py-2 text-left font-medium">Type</th>
                  </tr>
                </thead>
                <tbody>
                  {alarms.map((a) => (
                    <AlarmRowView
                      key={a.id}
                      alarm={a}
                      outcome={a.scoredFlowId ? outcomes.get(a.scoredFlowId) : undefined}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        <div className="text-[10px] text-muted-foreground leading-relaxed">
          Sorted newest first. Refreshes every 30s + realtime INSERT subscription.
          Limit 500 in the active window. Outcome chips read from ct_contract_tracks
          via source_flow_ids[0] = alert_id.
        </div>
      </div>
    </div>
  );
}
