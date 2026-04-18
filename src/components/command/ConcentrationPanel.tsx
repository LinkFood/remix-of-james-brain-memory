/**
 * ConcentrationPanel — live portfolio concentration dashboard.
 *
 * Sits on /book below the RiskMetricsPanel. Shows three concurrent views
 * of the book's current concentration, each capped by a ct_config key
 * that can be tuned from /ct-settings → category 'concentration':
 *
 *   - Tickers     — per-instrument size % of book  (max_ticker_pct)
 *   - Themes      — per-thesis_theme size % of book (max_theme_pct)
 *   - Direction   — long % vs short % stacked bar  (max_direction_pct)
 *   - Options     — count of open call+put positions (max_concurrent_options)
 *
 * Bar color thresholds relative to the limit:
 *   < 50%   → green     (plenty of room)
 *   50-80%  → yellow    (healthy)
 *   80-95%  → orange    (watch)
 *   > 95%   → red       (near cap / over)
 *
 * Options positions count toward ticker concentration (premium/book*100)
 * but do NOT count toward theme or direction caps — options don't map to
 * directional dollar exposure without Greeks.
 */
import { Card } from '@/components/ui/card';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from '@/components/ui/tooltip';
import { Scale, AlertTriangle } from 'lucide-react';
import { useConcentration, type ConcentrationSnapshot } from '@/hooks/useConcentration';

type Tier = 'green' | 'yellow' | 'orange' | 'red';

const TIER_BG: Record<Tier, string> = {
  green:  'bg-emerald-500',
  yellow: 'bg-yellow-400',
  orange: 'bg-orange-500',
  red:    'bg-red-500',
};

const TIER_TEXT: Record<Tier, string> = {
  green:  'text-emerald-400',
  yellow: 'text-yellow-300',
  orange: 'text-orange-400',
  red:    'text-red-400',
};

function tier(pct: number, limit: number): Tier {
  if (limit <= 0) return 'green';
  const ratio = pct / limit;
  if (ratio > 0.95) return 'red';
  if (ratio > 0.80) return 'orange';
  if (ratio > 0.50) return 'yellow';
  return 'green';
}

function fmtPct(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(digits)}%`;
}

/**
 * Horizontal bar where width is pct-of-book, but the scale is relative
 * to the limit. A bar at the limit fills ~100% of the track; beyond the
 * limit the overflow is visible in red.
 */
interface BarProps {
  label:      string;
  pct:        number;   // actual % of book
  limit:      number;   // % of book cap
  sublabel?:  string;
  muted?:     boolean;  // for ticker rows that are pure-options (can't fully interpret)
}

function LimitBar({ label, pct, limit, sublabel, muted }: BarProps) {
  const t = tier(pct, limit);
  // Track width = 100% of card; fill = pct/limit clamped to 100%, overflow shown as saturated red.
  const fillRatio = limit > 0 ? Math.min(1, pct / limit) : 0;
  const overRatio = limit > 0 && pct > limit ? Math.min(1, (pct - limit) / limit) : 0;

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-[11px] font-mono font-semibold text-foreground flex items-center gap-1.5">
          <span className={muted ? 'opacity-70' : ''}>{label}</span>
          {sublabel && <span className="text-[9px] text-muted-foreground font-normal">{sublabel}</span>}
        </div>
        <div className={`text-[11px] font-mono ${TIER_TEXT[t]}`}>
          {fmtPct(pct)} <span className="text-muted-foreground">/ {limit}%</span>
        </div>
      </div>
      <div className="relative h-2 bg-muted/30 rounded overflow-hidden">
        <div
          className={`absolute top-0 left-0 h-full ${TIER_BG[t]} transition-[width] duration-300`}
          style={{ width: `${fillRatio * 100}%` }}
        />
        {overRatio > 0 && (
          <div
            className="absolute top-0 h-full bg-red-600 opacity-80"
            style={{
              left: '100%',
              transform: `translateX(${-overRatio * 24}px)`,
              width: `${overRatio * 24}px`,
            }}
          />
        )}
        {/* Limit marker — a vertical tick at 100% of the track (i.e. at the limit). */}
        <div className="absolute top-0 right-0 h-full w-[1px] bg-foreground/40" />
      </div>
    </div>
  );
}

function EmptyState({ note }: { note: string }) {
  return (
    <div className="text-[11px] text-muted-foreground italic py-6 text-center">
      {note}
    </div>
  );
}

function Column({
  title, subtitle, children,
}: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 min-w-0">
      <div className="flex items-baseline justify-between border-b border-border pb-1 mb-1">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-foreground">{title}</div>
        {subtitle && <div className="text-[9px] text-muted-foreground font-mono">{subtitle}</div>}
      </div>
      {children}
    </div>
  );
}

function TickerColumn({ snap }: { snap: ConcentrationSnapshot }) {
  const limit = snap.limits.max_ticker_pct;
  const rows = snap.ticker_rows;
  if (rows.length === 0) return <Column title="Tickers" subtitle={`cap ${limit}%`}><EmptyState note="No open positions." /></Column>;

  return (
    <Column title="Tickers" subtitle={`cap ${limit}%`}>
      <div className="space-y-2">
        {rows.map(r => (
          <LimitBar
            key={r.instrument}
            label={r.instrument}
            pct={r.pct}
            limit={limit}
            sublabel={r.is_option ? `opt${r.side === 'mixed' ? ' · mixed' : ''}` : r.side}
            muted={r.is_option}
          />
        ))}
      </div>
    </Column>
  );
}

function ThemeColumn({ snap }: { snap: ConcentrationSnapshot }) {
  const limit = snap.limits.max_theme_pct;
  // Always render all 7 themes so James sees the full distribution, even
  // empty ones. Order matches thesisClassifier priority.
  const THEMES: Array<{ key: string; label: string }> = [
    { key: 'convergence',          label: 'convergence' },
    { key: 'structural_tightness', label: 'structural' },
    { key: 'gap',                  label: 'gap' },
    { key: 'news_driven',          label: 'news' },
    { key: 'regime_flip',          label: 'regime' },
    { key: 'thesis_invalidation',  label: 'invalidation' },
    { key: 'other',                label: 'other' },
  ];

  const anyActive = Object.keys(snap.theme_pct).length > 0;
  if (!anyActive) return <Column title="Themes" subtitle={`cap ${limit}%`}><EmptyState note="No themed exposure." /></Column>;

  return (
    <Column title="Themes" subtitle={`cap ${limit}%`}>
      <div className="space-y-2">
        {THEMES.map(th => (
          <LimitBar
            key={th.key}
            label={th.label}
            pct={snap.theme_pct[th.key] ?? 0}
            limit={limit}
          />
        ))}
      </div>
    </Column>
  );
}

function DirectionColumn({ snap }: { snap: ConcentrationSnapshot }) {
  const limit = snap.limits.max_direction_pct;
  const maxOpts  = snap.limits.max_concurrent_options;
  const longT   = tier(snap.long_pct,  limit);
  const shortT  = tier(snap.short_pct, limit);
  const optsT   = maxOpts > 0 ? tier(snap.options_open, maxOpts) : 'green';

  return (
    <Column title="Direction &amp; Options" subtitle={`dir cap ${limit}% · opt cap ${maxOpts}`}>
      <div className="space-y-2">
        <LimitBar label="Long"  pct={snap.long_pct}  limit={limit} />
        <LimitBar label="Short" pct={snap.short_pct} limit={limit} />

        {/* Long vs short stacked bar — visual "where is the book leaning" */}
        <div className="pt-2">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Stacked</div>
          <div className="relative h-2.5 bg-muted/30 rounded overflow-hidden flex">
            <div
              className={`h-full ${TIER_BG[longT]} transition-[width] duration-300`}
              style={{ width: `${Math.min(100, snap.long_pct)}%` }}
              title={`long ${fmtPct(snap.long_pct)}`}
            />
            <div
              className={`h-full ${TIER_BG[shortT]} opacity-70 transition-[width] duration-300`}
              style={{ width: `${Math.min(100 - Math.min(100, snap.long_pct), snap.short_pct)}%` }}
              title={`short ${fmtPct(snap.short_pct)}`}
            />
          </div>
          <div className="flex items-center justify-between text-[9px] text-muted-foreground mt-1 font-mono">
            <span className={TIER_TEXT[longT]}>L {fmtPct(snap.long_pct)}</span>
            <span className={TIER_TEXT[shortT]}>S {fmtPct(snap.short_pct)}</span>
          </div>
        </div>

        {/* Options count — rendered as a pseudo-bar for visual parity. */}
        <div className="pt-2">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Open options</div>
          <div className="flex items-baseline justify-between">
            <div className="text-[11px] font-mono font-semibold">{snap.options_open}</div>
            <div className={`text-[11px] font-mono ${TIER_TEXT[optsT]}`}>
              {snap.options_open} <span className="text-muted-foreground">/ {maxOpts}</span>
            </div>
          </div>
          <div className="relative h-2 bg-muted/30 rounded overflow-hidden mt-1">
            <div
              className={`absolute top-0 left-0 h-full ${TIER_BG[optsT]}`}
              style={{ width: `${maxOpts > 0 ? Math.min(100, (snap.options_open / maxOpts) * 100) : 0}%` }}
            />
          </div>
        </div>
      </div>
    </Column>
  );
}

export function ConcentrationPanel() {
  const { data: snap, isLoading, error } = useConcentration();

  // Any currently-breached limit? Surface a banner so it's obvious. Note:
  // this is a VIEW — breaches on the live book don't force-close; new
  // trades just can't add to them.
  const banner = (() => {
    if (!snap) return null;
    const breaches: string[] = [];
    for (const [tkr, pct] of Object.entries(snap.ticker_pct)) {
      if (pct > snap.limits.max_ticker_pct) breaches.push(`${tkr} ${fmtPct(pct)} > ${snap.limits.max_ticker_pct}% (ticker cap)`);
    }
    for (const [th, pct] of Object.entries(snap.theme_pct)) {
      if (pct > snap.limits.max_theme_pct) breaches.push(`${th} ${fmtPct(pct)} > ${snap.limits.max_theme_pct}% (theme cap)`);
    }
    if (snap.long_pct  > snap.limits.max_direction_pct) breaches.push(`long ${fmtPct(snap.long_pct)} > ${snap.limits.max_direction_pct}% (direction cap)`);
    if (snap.short_pct > snap.limits.max_direction_pct) breaches.push(`short ${fmtPct(snap.short_pct)} > ${snap.limits.max_direction_pct}% (direction cap)`);
    if (snap.options_open > snap.limits.max_concurrent_options) breaches.push(`${snap.options_open} open options > ${snap.limits.max_concurrent_options} cap`);
    return breaches.length > 0 ? breaches : null;
  })();

  return (
    <TooltipProvider delayDuration={150}>
      <Card className="overflow-hidden">
        <div className="px-4 py-2.5 border-b border-border bg-muted/20 flex items-center gap-3">
          <Scale className="w-4 h-4 text-primary" />
          <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground">Concentration</h3>
          {snap && (
            <span className="text-[10px] text-muted-foreground font-mono">
              book ${snap.book_equity.toLocaleString('en-US')} · live
            </span>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-[9px] text-muted-foreground/70 cursor-help ml-auto">
                tune in /ct-settings
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-[280px] text-[11px] leading-snug">
              Limits gate NEW trades only. Existing positions can ride above cap
              briefly (e.g., after a limit is lowered); nothing is force-closed.
              Changes from /ct-settings propagate within 60s.
            </TooltipContent>
          </Tooltip>
        </div>

        {isLoading && (
          <div className="p-4 text-xs text-muted-foreground">loading…</div>
        )}
        {error && (
          <div className="p-4 text-xs text-red-400">
            failed to load concentration: {error instanceof Error ? error.message : String(error)}
          </div>
        )}

        {snap && (
          <>
            {banner && (
              <div className="px-4 py-2 border-b border-border bg-red-500/10 flex items-start gap-2">
                <AlertTriangle className="w-3.5 h-3.5 text-red-400 mt-0.5 flex-shrink-0" />
                <div className="text-[11px] text-red-300 font-mono leading-snug">
                  <span className="font-semibold">Live breach</span> — new trades on these axes will be rejected until exposure drops:
                  <ul className="list-disc pl-4 mt-1 space-y-0.5">
                    {banner.map((b, i) => <li key={i}>{b}</li>)}
                  </ul>
                </div>
              </div>
            )}

            <div className="p-4 grid grid-cols-1 lg:grid-cols-3 gap-6">
              <TickerColumn snap={snap} />
              <ThemeColumn snap={snap} />
              <DirectionColumn snap={snap} />
            </div>
          </>
        )}
      </Card>
    </TooltipProvider>
  );
}
