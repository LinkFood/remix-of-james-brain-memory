/**
 * Analogs — Regime Analog Explorer.
 *
 * The deeper sibling of wave 24's session-analog matcher. Where that feature
 * finds the most-similar past sessions via embedding, this page lets you
 * filter history by EXPLICIT regime constraints ("positive gamma + low IV +
 * strong breadth + no catalyst") and browse the resulting sessions, their
 * EOD outcomes, and Claude's graded track record on those days.
 *
 * Layout:
 *   - Left  (w-80, sticky): FilterPanel — 8 dimensions + search-by-example
 *                           buttons + aggregate footer.
 *   - Right (flex-1):       MatchList — one row per filtered session with
 *                           regime chips, return %, event count, grade summary.
 *                           Click → /session?date=YYYY-MM-DD.
 *   - Footer row inside the left panel shows the aggregate for the current
 *     filter (count, avg close return %, est median DD, hit rate, precision).
 *
 * Data: useRegimeAnalogs (pulls ct_session_embeddings + ct_iv_rank_daily +
 * ct_events + ct_grades, composes regime tags, filters client-side).
 *
 * No UW calls. Not wrapped in charts right now, but any future chart MUST
 * use <ChartSafe>.
 *
 * Thin-corpus behavior: when the session count is below
 * REGIME_ANALOGS_MIN_CORPUS (7), we show an empty-state card instead of the
 * list. The filter panel stays interactive so the user can see the scaffold.
 */

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Slider } from '@/components/ui/slider';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Calendar, AlertTriangle, TrendingUp, TrendingDown, Filter, Zap, Download,
  RotateCcw, Target, Gauge,
} from 'lucide-react';
import {
  useRegimeAnalogs,
  DEFAULT_FILTERS,
  REGIME_ANALOGS_MIN_CORPUS,
  regimeAnalogsToCsv,
  type RegimeAnalogFilters,
  type RegimeSessionRow,
  type RegimeAggregate,
} from '@/hooks/useRegimeAnalogs';

// ---------------------------------------------------------------------------
// Small render helpers
// ---------------------------------------------------------------------------

function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}%`;
}

function fmtPctRatio(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(0)}%`;
}

function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// Mon-Fri only for filter UI (weekends never appear in session_embeddings but
// we still hide them from the selector for clarity).
const TRADING_DOWS = [1, 2, 3, 4, 5] as const;

function GammaChip({ v }: { v: RegimeSessionRow['gamma'] }) {
  if (v === 'positive') return <Badge className="bg-emerald-500/15 text-emerald-300 border-emerald-500/30 text-[10px] px-1.5 py-0">γ+</Badge>;
  if (v === 'negative') return <Badge className="bg-red-500/15 text-red-300 border-red-500/30 text-[10px] px-1.5 py-0">γ-</Badge>;
  return <Badge variant="outline" className="text-[10px] px-1.5 py-0">γ?</Badge>;
}
function IvChip({ v }: { v: RegimeSessionRow['iv_tier'] }) {
  const map = {
    low:  'bg-sky-500/15 text-sky-300 border-sky-500/30',
    mid:  'bg-amber-500/15 text-amber-300 border-amber-500/30',
    high: 'bg-orange-500/15 text-orange-300 border-orange-500/30',
    unknown: 'bg-muted/40 text-muted-foreground border-border',
  } as const;
  return <Badge className={`${map[v]} text-[10px] px-1.5 py-0`}>IV {v}</Badge>;
}
function VixChip({ v }: { v: RegimeSessionRow['vix_tier'] }) {
  const map = {
    low:       'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    mid:       'bg-sky-500/15 text-sky-300 border-sky-500/30',
    elevated:  'bg-amber-500/15 text-amber-300 border-amber-500/30',
    stressed:  'bg-red-500/15 text-red-300 border-red-500/30',
    unknown:   'bg-muted/40 text-muted-foreground border-border',
  } as const;
  return <Badge className={`${map[v]} text-[10px] px-1.5 py-0`}>VIX {v}</Badge>;
}
function BreadthChip({ v }: { v: RegimeSessionRow['breadth'] }) {
  const map = {
    strong:  'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    mixed:   'bg-amber-500/15 text-amber-300 border-amber-500/30',
    weak:    'bg-red-500/15 text-red-300 border-red-500/30',
    unknown: 'bg-muted/40 text-muted-foreground border-border',
  } as const;
  return <Badge className={`${map[v]} text-[10px] px-1.5 py-0`}>Breadth {v}</Badge>;
}

// ---------------------------------------------------------------------------
// MatchList
// ---------------------------------------------------------------------------

function MatchList({ rows }: { rows: RegimeSessionRow[] }) {
  if (rows.length === 0) {
    return (
      <Card className="p-6 text-center text-sm text-muted-foreground">
        <Filter className="w-5 h-5 mx-auto mb-2 opacity-50" />
        No sessions match the current filter. Try loosening a constraint.
      </Card>
    );
  }
  return (
    <div className="space-y-1.5">
      {rows.map((r) => <MatchRow key={r.session_date} r={r} />)}
    </div>
  );
}

function MatchRow({ r }: { r: RegimeSessionRow }) {
  const ret = r.eod_return_pct;
  const retColor =
    ret === null || ret === undefined
      ? 'text-muted-foreground'
      : ret > 0
        ? 'text-emerald-300'
        : ret < 0
          ? 'text-red-300'
          : 'text-muted-foreground';

  return (
    <Card className="p-3 hover:bg-muted/30 transition-colors">
      <div className="flex items-center gap-3 flex-wrap">
        {/* Date + day-of-week */}
        <div className="min-w-[110px]">
          <div className="text-xs font-mono text-foreground/80">{r.session_date}</div>
          <div className="text-[10px] text-muted-foreground">{DOW_LABELS[r.dow]}</div>
        </div>

        {/* Regime chips */}
        <div className="flex items-center gap-1 flex-wrap">
          <GammaChip v={r.gamma} />
          <IvChip v={r.iv_tier} />
          <VixChip v={r.vix_tier} />
          <BreadthChip v={r.breadth} />
          {r.opex_week && (
            <Badge className="bg-purple-500/15 text-purple-300 border-purple-500/30 text-[10px] px-1.5 py-0">
              OPEX
            </Badge>
          )}
          {r.has_catalyst && (
            <Badge className="bg-red-500/15 text-red-300 border-red-500/30 text-[10px] px-1.5 py-0">
              <AlertTriangle className="w-2.5 h-2.5 mr-0.5" />
              {r.catalyst_sources.slice(0, 2).join(', ')}
              {r.catalyst_sources.length > 2 ? `+${r.catalyst_sources.length - 2}` : ''}
            </Badge>
          )}
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Return + event count + grades */}
        <div className="flex items-center gap-3 text-[11px]">
          <div
            className="flex items-center gap-1"
            title={r.eod_summary ?? 'EOD outcome not yet materialized'}
          >
            {ret !== null && ret !== undefined && ret > 0 && <TrendingUp className="w-3 h-3 text-emerald-400" />}
            {ret !== null && ret !== undefined && ret < 0 && <TrendingDown className="w-3 h-3 text-red-400" />}
            <span className={`font-mono tabular-nums ${retColor}`}>{fmtPct(ret)}</span>
          </div>
          <div className="text-muted-foreground font-mono tabular-nums" title="Catalyst events within ±24h">
            {r.event_count} ev
          </div>
          <div className="text-muted-foreground text-[10px] font-mono" title="Claude's graded calls that day">
            <span className="text-emerald-300">{r.grade_right}r</span>{' '}
            <span className="text-red-300">{r.grade_wrong}w</span>{' '}
            <span className="text-amber-300">{r.grade_partial}p</span>
          </div>
          {r.similarity_to_today !== null && (
            <div className="text-muted-foreground font-mono tabular-nums text-[10px]" title="Cosine similarity to today's tape">
              sim {r.similarity_to_today.toFixed(2)}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1.5">
          <Link
            to={`/session?date=${r.session_date}`}
            className="text-[10px] text-sky-300 hover:text-sky-200 underline underline-offset-2"
            title="View Claude's decisions that day"
          >
            View day
          </Link>
        </div>
      </div>
      {r.state_summary && (
        <div className="mt-1.5 text-[11px] text-muted-foreground/80 line-clamp-1" title={r.state_summary}>
          {r.state_summary}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// AggregateFooter
// ---------------------------------------------------------------------------

function AggregateFooter({ agg }: { agg: RegimeAggregate }) {
  return (
    <Card className="p-3 space-y-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        Aggregate — {agg.count} session{agg.count === 1 ? '' : 's'}
      </div>
      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Avg close ret</span>
          <span className="font-mono tabular-nums">{fmtPct(agg.avg_close_return_pct)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Hit rate</span>
          <span className="font-mono tabular-nums">{fmtPctRatio(agg.hit_rate)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground" title="Median of |min(0, close ret)| — close-return floor, not intraday DD">
            Med DD est
          </span>
          <span className="font-mono tabular-nums">{fmtPct(agg.median_dd_pct_est)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Avg events</span>
          <span className="font-mono tabular-nums">{fmtNum(agg.avg_event_count, 1)}</span>
        </div>
        <div className="flex items-center justify-between col-span-2">
          <span className="text-muted-foreground">Referee precision</span>
          <span className="font-mono tabular-nums">{fmtPctRatio(agg.precision)}</span>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// FilterPanel
// ---------------------------------------------------------------------------

interface FilterPanelProps {
  filters: RegimeAnalogFilters;
  onChange: (next: RegimeAnalogFilters) => void;
  onMatchToday: () => void;
  onLastFomc: () => void;
  onClear: () => void;
  onExport: () => void;
  exportDisabled: boolean;
}

function FilterPanel({
  filters, onChange, onMatchToday, onLastFomc, onClear, onExport, exportDisabled,
}: FilterPanelProps) {
  const patch = (next: Partial<RegimeAnalogFilters>) => onChange({ ...filters, ...next });

  const toggleDow = (n: number) => {
    const has = filters.days_of_week.includes(n);
    const next = has
      ? filters.days_of_week.filter(d => d !== n)
      : [...filters.days_of_week, n].sort();
    patch({ days_of_week: next });
  };

  return (
    <Card className="p-3 space-y-3">
      {/* Search-by-example */}
      <div className="space-y-1.5">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Search by example</div>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="outline" className="h-7 text-[11px] gap-1" onClick={onMatchToday}>
            <Target className="w-3 h-3" />
            Match today's regime
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-[11px] gap-1" onClick={onLastFomc}>
            <Gauge className="w-3 h-3" />
            Last FOMC day
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-[11px] gap-1 text-muted-foreground" onClick={onClear}>
            <RotateCcw className="w-3 h-3" />
            Clear
          </Button>
        </div>
      </div>

      <div className="border-t border-border/50 pt-3 space-y-2.5">
        {/* Gamma */}
        <div>
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Gamma regime</Label>
          <Select value={filters.gamma} onValueChange={(v) => patch({ gamma: v as RegimeAnalogFilters['gamma'] })}>
            <SelectTrigger className="h-8 text-xs mt-1"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any</SelectItem>
              <SelectItem value="positive">Positive (γ+)</SelectItem>
              <SelectItem value="negative">Negative (γ-)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* IV tier */}
        <div>
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">IV tier (SPY)</Label>
          <Select value={filters.iv_tier} onValueChange={(v) => patch({ iv_tier: v as RegimeAnalogFilters['iv_tier'] })}>
            <SelectTrigger className="h-8 text-xs mt-1"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any</SelectItem>
              <SelectItem value="low">Low (&lt;25)</SelectItem>
              <SelectItem value="mid">Mid (25–60)</SelectItem>
              <SelectItem value="high">High (&gt;60)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* VIX tier */}
        <div>
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">VIX tier</Label>
          <Select value={filters.vix_tier} onValueChange={(v) => patch({ vix_tier: v as RegimeAnalogFilters['vix_tier'] })}>
            <SelectTrigger className="h-8 text-xs mt-1"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any</SelectItem>
              <SelectItem value="low">Low (&lt;14)</SelectItem>
              <SelectItem value="mid">Mid (14–20)</SelectItem>
              <SelectItem value="elevated">Elevated (20–30)</SelectItem>
              <SelectItem value="stressed">Stressed (&gt;30)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Breadth */}
        <div>
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Breadth</Label>
          <Select value={filters.breadth} onValueChange={(v) => patch({ breadth: v as RegimeAnalogFilters['breadth'] })}>
            <SelectTrigger className="h-8 text-xs mt-1"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any</SelectItem>
              <SelectItem value="strong">Strong</SelectItem>
              <SelectItem value="mixed">Mixed</SelectItem>
              <SelectItem value="weak">Weak</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Catalyst */}
        <div>
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Catalyst (±24h)</Label>
          <Select value={filters.catalyst} onValueChange={(v) => patch({ catalyst: v as RegimeAnalogFilters['catalyst'] })}>
            <SelectTrigger className="h-8 text-xs mt-1"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any</SelectItem>
              <SelectItem value="yes">Yes (macro/earnings/FDA)</SelectItem>
              <SelectItem value="no">No</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* OPEX */}
        <div>
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">OPEX week</Label>
          <Select value={filters.opex_week} onValueChange={(v) => patch({ opex_week: v as RegimeAnalogFilters['opex_week'] })}>
            <SelectTrigger className="h-8 text-xs mt-1"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any</SelectItem>
              <SelectItem value="yes">Yes</SelectItem>
              <SelectItem value="no">No</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Day of week */}
        <div>
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Day of week</Label>
          <div className="flex flex-wrap gap-2 mt-1.5">
            {TRADING_DOWS.map((d) => {
              const checked = filters.days_of_week.includes(d);
              return (
                <label key={d} className="flex items-center gap-1 cursor-pointer">
                  <Checkbox
                    checked={checked}
                    onCheckedChange={() => toggleDow(d)}
                    className="h-3.5 w-3.5"
                  />
                  <span className="text-[11px] text-muted-foreground">{DOW_LABELS[d]}</span>
                </label>
              );
            })}
          </div>
        </div>

        {/* Min similarity */}
        <div>
          <div className="flex items-center justify-between">
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Min similarity</Label>
            <span className="text-[10px] font-mono text-muted-foreground">
              {filters.min_similarity.toFixed(2)}
            </span>
          </div>
          <Slider
            value={[filters.min_similarity]}
            onValueChange={([v]) => patch({ min_similarity: v ?? 0 })}
            min={0}
            max={1}
            step={0.05}
            className="mt-2"
          />
          <div className="text-[10px] text-muted-foreground/70 mt-1">
            0 = off. Requires today's snapshot in ct_session_embeddings.
          </div>
        </div>
      </div>

      {/* Export */}
      <div className="border-t border-border/50 pt-3">
        <Button
          size="sm"
          variant="outline"
          className="w-full h-7 text-[11px] gap-1.5"
          onClick={onExport}
          disabled={exportDisabled}
        >
          <Download className="w-3 h-3" />
          Export matching (CSV)
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Analogs() {
  const [filters, setFilters] = useState<RegimeAnalogFilters>(DEFAULT_FILTERS);
  const { loading, error, corpusCount, warmingUp, todaySession, filtered, aggregate } =
    useRegimeAnalogs(filters);

  // "Match today's regime" — fill filters from today's derived session row.
  const handleMatchToday = () => {
    if (!todaySession) return;
    setFilters({
      ...DEFAULT_FILTERS,
      gamma:    todaySession.gamma    !== 'unknown' ? todaySession.gamma    : 'any',
      iv_tier:  todaySession.iv_tier  !== 'unknown' ? todaySession.iv_tier  : 'any',
      breadth:  todaySession.breadth  !== 'unknown' ? todaySession.breadth  : 'any',
      vix_tier: todaySession.vix_tier !== 'unknown' ? todaySession.vix_tier : 'any',
      catalyst: todaySession.has_catalyst ? 'yes' : 'no',
      opex_week: todaySession.opex_week ? 'yes' : 'any',
      days_of_week: [],
      min_similarity: 0,
    });
  };

  // "Last FOMC day" — catalyst=yes and no other constraints.
  // The catalyst_sources chip will typically include 'fomc' on that day; we
  // can't narrow server-side without a dedicated query, so we surface all
  // catalyst days and let the user eyeball FOMC. Cheap, no extra queries.
  const handleLastFomc = () => {
    setFilters({ ...DEFAULT_FILTERS, catalyst: 'yes' });
  };

  const handleClear = () => setFilters(DEFAULT_FILTERS);

  // Export — CSV of the currently filtered rows.
  const handleExport = () => {
    if (filtered.length === 0) return;
    const csv = regimeAnalogsToCsv(filtered);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const stamp = new Date().toISOString().slice(0, 10);
    a.download = `regime-analogs-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Pre-compute active filter chip summary for the header
  const activeChips = useMemo(() => {
    const out: string[] = [];
    if (filters.gamma !== 'any')     out.push(`γ ${filters.gamma}`);
    if (filters.iv_tier !== 'any')   out.push(`IV ${filters.iv_tier}`);
    if (filters.vix_tier !== 'any')  out.push(`VIX ${filters.vix_tier}`);
    if (filters.breadth !== 'any')   out.push(`breadth ${filters.breadth}`);
    if (filters.catalyst !== 'any')  out.push(`catalyst ${filters.catalyst}`);
    if (filters.opex_week !== 'any') out.push(`OPEX ${filters.opex_week}`);
    if (filters.days_of_week.length > 0) {
      out.push(filters.days_of_week.map(d => DOW_LABELS[d]).join('/'));
    }
    if (filters.min_similarity > 0)  out.push(`sim≥${filters.min_similarity.toFixed(2)}`);
    return out;
  }, [filters]);

  return (
    <div className="p-4 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-4 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
            <Calendar className="w-5 h-5 text-primary" />
            Regime Analog Explorer
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Filter historical sessions by explicit regime constraints. Find the days that
            looked like the one you're pattern-matching for — and see how they played out.
          </p>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="font-mono">{corpusCount} session{corpusCount === 1 ? '' : 's'} in corpus</span>
          {activeChips.length > 0 && (
            <span className="text-muted-foreground/70">· {activeChips.join(' · ')}</span>
          )}
        </div>
      </div>

      {error && (
        <Card className="p-3 mb-3 border-red-500/40 bg-red-500/5 text-xs text-red-300">
          <AlertTriangle className="w-3.5 h-3.5 inline mr-1 -mt-0.5" />
          Error loading analogs: {error}
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
        {/* LEFT: Filters + aggregate */}
        <div className="space-y-3">
          <FilterPanel
            filters={filters}
            onChange={setFilters}
            onMatchToday={handleMatchToday}
            onLastFomc={handleLastFomc}
            onClear={handleClear}
            onExport={handleExport}
            exportDisabled={filtered.length === 0}
          />
          <AggregateFooter agg={aggregate} />

          {/* Debug-ish hint: today's snapshot presence */}
          <div className="text-[10px] text-muted-foreground/60 px-1">
            {todaySession
              ? `Today's snapshot loaded — "Match today's regime" and similarity slider active.`
              : `No snapshot for today yet. Build one via ct-session-analog (mode: 'build') to enable similarity filtering.`}
          </div>
        </div>

        {/* RIGHT: Matches */}
        <div>
          {loading && !filtered.length ? (
            <Card className="p-6 text-center text-sm text-muted-foreground">
              Loading analog sessions…
            </Card>
          ) : warmingUp ? (
            <Card className="p-6 text-center">
              <Zap className="w-6 h-6 mx-auto mb-2 text-amber-400 opacity-80" />
              <div className="text-sm font-medium text-foreground mb-1">Not enough history yet</div>
              <div className="text-xs text-muted-foreground max-w-md mx-auto">
                Regime analog explorer needs at least {REGIME_ANALOGS_MIN_CORPUS} sessions in
                ct_session_embeddings to be useful. Currently {corpusCount}. The nightly
                ct-session-analog build will fill this in — come back in a few sessions.
              </div>
            </Card>
          ) : (
            <MatchList rows={filtered} />
          )}
        </div>
      </div>
    </div>
  );
}
