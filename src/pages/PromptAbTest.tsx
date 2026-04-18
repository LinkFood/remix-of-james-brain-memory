/**
 * PromptAbTest — "did the new system prompt actually make things better?"
 *
 * Scorecard per prompt_version (v1 → v1.1 → v1.2 → v1.3), rendered as a
 * column per version with deltas annotated between adjacent columns. Read-only
 * — no mutations, zero new UW calls.
 *
 * Sparse / sample-size handling is prominent:
 *   - versions with < PROMPT_AB_MIN_SAMPLES are labeled "insufficient sample"
 *     and excluded from deltas
 *   - versions below PROMPT_AB_STAT_SIG_THRESHOLD (30) are labeled
 *     "directional, not stat-sig"
 *
 * The footer generates a short client-side narrative summarizing which
 * version is best per dimension (only among comparable versions).
 */
import { useMemo } from 'react';
import {
  usePromptAbTest,
  type PromptVersionStats,
  PROMPT_AB_MIN_SAMPLES,
  PROMPT_AB_STAT_SIG_THRESHOLD,
} from '@/hooks/usePromptAbTest';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { FlaskConical, AlertCircle, ChevronRight } from 'lucide-react';

function fmtPct(n: number | null, digits = 0): string {
  if (n == null) return '—';
  return `${(n * 100).toFixed(digits)}%`;
}

function fmtPp(n: number | null, digits = 1): string {
  if (n == null) return '—';
  return `${n.toFixed(digits)}pp`;
}

function fmtPerDay(n: number | null): string {
  if (n == null) return '—';
  return `${n.toFixed(2)}/day`;
}

function fmtDateRange(first: string | null, last: string | null): string {
  if (!first && !last) return '—';
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  const a = first ? new Date(first).toLocaleDateString('en-US', opts) : '—';
  const b = last ? new Date(last).toLocaleDateString('en-US', opts) : '—';
  if (a === b) return a;
  return `${a} → ${b}`;
}

/** Color a hit_rate for the scorecard stripe. */
function hitRateColor(rate: number | null): string {
  if (rate == null) return 'text-muted-foreground';
  if (rate >= 0.6) return 'text-green-400';
  if (rate >= 0.4) return 'text-amber-400';
  return 'text-red-400';
}

function calibrationColor(gap: number | null): string {
  if (gap == null) return 'text-muted-foreground';
  if (gap <= 5) return 'text-green-400';
  if (gap <= 15) return 'text-amber-400';
  return 'text-red-400';
}

function demotionColor(rate: number | null): string {
  if (rate == null) return 'text-muted-foreground';
  // High demotion rate is GOOD here — it means cooldowns worked, not that
  // alerts were over-aggressive. But we still surface it neutral.
  if (rate >= 0.3) return 'text-amber-400';
  return 'text-foreground';
}

function bandColor(rate: number | null): string {
  if (rate == null) return 'text-muted-foreground';
  if (rate >= 0.5) return 'text-green-400';
  if (rate >= 0.3) return 'text-amber-400';
  return 'text-red-400';
}

/** Delta copy between two adjacent versions, skipping insufficient ones. */
function deltaLine(prev: PromptVersionStats, curr: PromptVersionStats): string | null {
  if (prev.insufficient || curr.insufficient) return null;
  const parts: string[] = [];

  if (prev.hit_rate != null && curr.hit_rate != null) {
    const delta = (curr.hit_rate - prev.hit_rate) * 100;
    const sign = delta >= 0 ? '+' : '';
    parts.push(`hit rate ${sign}${delta.toFixed(0)}%`);
  }

  if (prev.alerts_per_day != null && curr.alerts_per_day != null && prev.alerts_per_day > 0) {
    const pct = ((curr.alerts_per_day - prev.alerts_per_day) / prev.alerts_per_day) * 100;
    const sign = pct >= 0 ? '+' : '';
    parts.push(`alerts/day ${sign}${pct.toFixed(0)}%`);
  }

  if (prev.calibration_gap_pp != null && curr.calibration_gap_pp != null) {
    const delta = curr.calibration_gap_pp - prev.calibration_gap_pp;
    const sign = delta >= 0 ? '+' : '';
    parts.push(`calibration ${sign}${delta.toFixed(1)}pp`);
  }

  // Band accuracy: "new stat" if prev had no banded claims, else delta.
  if (curr.band_accuracy != null) {
    if (prev.band_accuracy == null) {
      parts.push('band accuracy new stat');
    } else {
      const delta = (curr.band_accuracy - prev.band_accuracy) * 100;
      const sign = delta >= 0 ? '+' : '';
      parts.push(`band accuracy ${sign}${delta.toFixed(0)}%`);
    }
  }

  if (parts.length === 0) return null;
  return `${curr.version} vs ${prev.version}: ${parts.join(', ')}`;
}

interface NarrativePiece {
  dimension: string;
  leader: string | null;
  detail: string;
}

function buildNarrative(versions: PromptVersionStats[]): NarrativePiece[] {
  const comparable = versions.filter((v) => !v.insufficient);
  if (comparable.length < 2) {
    return [
      {
        dimension: 'Overall',
        leader: null,
        detail:
          comparable.length === 0
            ? 'No version has enough samples yet — grading lands at horizon close.'
            : 'Only one version has enough samples. Cannot compare until the next version accumulates claims.',
      },
    ];
  }

  const best = <K extends keyof PromptVersionStats>(
    key: K,
    higherIsBetter: boolean,
    filter?: (v: PromptVersionStats) => boolean,
  ): PromptVersionStats | null => {
    const pool = comparable.filter((v) => {
      const val = v[key];
      if (val == null || typeof val !== 'number') return false;
      return filter ? filter(v) : true;
    });
    if (pool.length === 0) return null;
    return pool.slice().sort((a, b) => {
      const av = a[key] as number;
      const bv = b[key] as number;
      return higherIsBetter ? bv - av : av - bv;
    })[0];
  };

  const pieces: NarrativePiece[] = [];

  const hit = best('hit_rate', true);
  if (hit && hit.hit_rate != null) {
    pieces.push({
      dimension: 'Hit rate',
      leader: hit.version,
      detail: `${hit.version} leads at ${fmtPct(hit.hit_rate)} (n=${hit.graded}).`,
    });
  }

  const cal = best('calibration_gap_pp', false);
  if (cal && cal.calibration_gap_pp != null) {
    pieces.push({
      dimension: 'Calibration',
      leader: cal.version,
      detail: `${cal.version} tightest at ${fmtPp(cal.calibration_gap_pp)} off claimed odds.`,
    });
  }

  const apd = best('alerts_per_day', false, (v) => (v.alerts_per_day ?? 0) > 0);
  if (apd && apd.alerts_per_day != null) {
    pieces.push({
      dimension: 'Signal density',
      leader: apd.version,
      detail: `${apd.version} quietest at ${fmtPerDay(apd.alerts_per_day)} — fewer but sharper alerts.`,
    });
  }

  const band = best('band_accuracy', true, (v) => (v.banded_graded_claims ?? 0) > 0);
  if (band && band.band_accuracy != null) {
    pieces.push({
      dimension: 'Band accuracy',
      leader: band.version,
      detail: `${band.version} leads bands at ${fmtPct(band.band_accuracy)} (n=${band.banded_graded_claims} banded + graded).`,
    });
  }

  if (pieces.length === 0) {
    pieces.push({
      dimension: 'Overall',
      leader: null,
      detail: 'Not enough graded data yet to declare a leader on any dimension.',
    });
  }

  return pieces;
}

function MetricRow({
  label,
  value,
  sub,
  valueClass,
}: {
  label: string;
  value: string;
  sub?: string;
  valueClass?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-right">
        <div className={`text-sm font-semibold font-mono ${valueClass ?? 'text-foreground'}`}>
          {value}
        </div>
        {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
      </div>
    </div>
  );
}

function VersionCard({ v }: { v: PromptVersionStats }) {
  return (
    <Card className="p-3 flex flex-col">
      <div className="flex items-center gap-2 border-b border-border pb-2 mb-2">
        <span className="font-mono text-sm font-bold text-primary">{v.version}</span>
        {v.insufficient && (
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-amber-500/40 text-amber-400">
            insufficient
          </Badge>
        )}
        {!v.insufficient && v.below_stat_sig && (
          <Badge
            variant="outline"
            className="text-[10px] px-1.5 py-0 border-muted-foreground/30 text-muted-foreground"
            title={`Below ${PROMPT_AB_STAT_SIG_THRESHOLD} samples — directional only`}
          >
            directional
          </Badge>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground">
          {fmtDateRange(v.first_seen, v.last_seen)}
        </span>
      </div>

      <div className="divide-y divide-border/50">
        <MetricRow
          label="Samples"
          value={String(v.samples)}
          sub={`${v.graded} graded`}
          valueClass={v.samples < PROMPT_AB_MIN_SAMPLES ? 'text-amber-400' : 'text-foreground'}
        />
        <MetricRow
          label="Hit rate"
          value={fmtPct(v.hit_rate)}
          sub={
            v.graded > 0
              ? `${v.right}R · ${v.partial}P · ${v.wrong}W${v.ambiguous > 0 ? ` · ${v.ambiguous}?` : ''}`
              : 'no graded'
          }
          valueClass={hitRateColor(v.hit_rate)}
        />
        <MetricRow
          label="Partial rate"
          value={fmtPct(v.partial_rate)}
        />
        <MetricRow
          label="Wrong rate"
          value={fmtPct(v.wrong_rate)}
        />
        <MetricRow
          label="Calibration gap"
          value={fmtPp(v.calibration_gap_pp)}
          sub={v.calibration_gap_pp != null ? '|claimed − actual|' : undefined}
          valueClass={calibrationColor(v.calibration_gap_pp)}
        />
        <MetricRow
          label="Alerts/day"
          value={fmtPerDay(v.alerts_per_day)}
          sub={`${v.alert_attempts || 0} attempts`}
        />
        <MetricRow
          label="Demotion rate"
          value={fmtPct(v.demotion_rate)}
          sub={`${v.demotions}/${v.alert_attempts || 0}`}
          valueClass={demotionColor(v.demotion_rate)}
        />
        {(v.banded_claims > 0 || v.band_accuracy != null) && (
          <MetricRow
            label="Band accuracy"
            value={fmtPct(v.band_accuracy)}
            sub={
              v.banded_graded_claims > 0
                ? `${v.band_hits}/${v.banded_graded_claims} in band`
                : `${v.banded_claims} banded, 0 graded`
            }
            valueClass={bandColor(v.band_accuracy)}
          />
        )}
      </div>
    </Card>
  );
}

function DeltaStrip({ versions }: { versions: PromptVersionStats[] }) {
  if (versions.length < 2) return null;
  const lines: string[] = [];
  for (let i = 1; i < versions.length; i++) {
    const line = deltaLine(versions[i - 1], versions[i]);
    if (line) lines.push(line);
  }
  if (lines.length === 0) return null;
  return (
    <Card className="p-3 bg-muted/10">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
        Version Deltas
      </div>
      <div className="space-y-1">
        {lines.map((l) => (
          <div key={l} className="flex items-start gap-2 text-xs font-mono text-foreground/90">
            <ChevronRight className="w-3 h-3 mt-0.5 text-primary shrink-0" />
            <span>{l}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function PromptAbTest() {
  const { data: versions, isLoading, error } = usePromptAbTest();

  const narrative = useMemo(() => (versions ? buildNarrative(versions) : []), [versions]);

  const statSigDisclaimer = useMemo(() => {
    if (!versions || versions.length === 0) return null;
    const anyBelow = versions.some((v) => !v.insufficient && v.below_stat_sig);
    return anyBelow
      ? `Directional, not statistically significant — at least one version has fewer than ${PROMPT_AB_STAT_SIG_THRESHOLD} samples.`
      : null;
  }, [versions]);

  return (
    <div className="min-h-screen bg-background text-foreground p-4">
      <div className="max-w-[1400px] mx-auto space-y-4">
        <header>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <FlaskConical className="w-6 h-6 text-primary" />
            <span className="text-primary">Prompt A/B Test</span>
            <span className="text-sm text-muted-foreground font-normal">
              does each system prompt iteration actually improve outcomes?
            </span>
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            Every ct_flag, ct_alert, ct_heartbeat carries a prompt_version tag. We join to
            ct_grades by subject_id and score each version the same way the referee does.
          </p>
          {statSigDisclaimer && (
            <div className="mt-2 flex items-start gap-2 text-[11px] text-amber-400/90 border border-amber-500/30 bg-amber-500/5 rounded px-2 py-1.5">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{statSigDisclaimer}</span>
            </div>
          )}
        </header>

        {isLoading && (
          <Card className="p-8 text-center text-sm text-muted-foreground">loading…</Card>
        )}

        {error && (
          <Card className="p-4 text-sm text-red-400">
            Failed to load prompt A/B data: {(error as Error).message}
          </Card>
        )}

        {versions && versions.length === 0 && !isLoading && (
          <Card className="p-8 text-center">
            <p className="text-sm text-muted-foreground">No prompt_version tags found yet.</p>
          </Card>
        )}

        {versions && versions.length > 0 && (
          <>
            <DeltaStrip versions={versions} />

            <div
              className={`grid gap-3 ${
                versions.length === 1
                  ? 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3'
                  : versions.length === 2
                    ? 'grid-cols-1 md:grid-cols-2'
                    : versions.length === 3
                      ? 'grid-cols-1 md:grid-cols-3'
                      : 'grid-cols-1 md:grid-cols-2 lg:grid-cols-4'
              }`}
            >
              {versions.map((v) => (
                <VersionCard key={v.version} v={v} />
              ))}
            </div>

            {/* Narrative footer — generated client-side from the scorecard. */}
            <Card className="p-4">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
                Narrative
              </div>
              <ul className="space-y-1.5 text-xs">
                {narrative.map((n) => (
                  <li key={n.dimension} className="flex items-start gap-2">
                    <span className="font-mono text-muted-foreground min-w-[100px] shrink-0">
                      {n.dimension}
                    </span>
                    <span className="text-foreground/90">{n.detail}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-3 text-[10px] text-muted-foreground leading-relaxed">
                Versions with fewer than {PROMPT_AB_MIN_SAMPLES} samples are excluded from
                leader selection. Deltas only computed between adjacent versions that both
                clear the minimum. "Directional" = below {PROMPT_AB_STAT_SIG_THRESHOLD}{' '}
                samples — treat as suggestive, not proof.
              </div>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

export default PromptAbTest;
