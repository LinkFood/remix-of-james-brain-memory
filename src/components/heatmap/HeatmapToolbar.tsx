/**
 * HeatmapToolbar — controls for the /heatmap page.
 *
 * Exposes:
 *   - Math mode select       (5 options, default 'aggressive_directional_decay')
 *   - Lookback chips         (24h / 3d / 7d / 30d, default 7d)
 *   - 0DTE toggle            (default off)
 *   - Min premium input      ($100K / $250K / $500K / $1M / custom)
 *   - View mode tabs         (Combined / Per-Ticker)
 *   - Color anchor toggle    (per-row / global percentile)
 *
 * Stateless — value+onChange for each control. Parent owns state so
 * deep-linking and persistence are trivial later.
 */

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import type { HeatmapMathMode } from '@/hooks/useFlowHeatmap';

export type HeatmapLookback = '24h' | '3d' | '7d' | '30d';
export type HeatmapView = 'combined' | 'per_ticker';
export type HeatmapColorAnchor = 'per_row' | 'global';
export type BaselineMode = 'off' | '1h' | 'session_open' | 'yesterday_close' | 'custom';

export interface HeatmapToolbarValue {
  mathMode: HeatmapMathMode;
  lookback: HeatmapLookback;
  include0DTE: boolean;
  minPremium: number;
  view: HeatmapView;
  colorAnchor: HeatmapColorAnchor;
  baselineMode: BaselineMode;
  baselineCustomAt?: Date;
}

interface HeatmapToolbarProps {
  value: HeatmapToolbarValue;
  onChange: (next: HeatmapToolbarValue) => void;
}

const MATH_MODE_OPTIONS: { value: HeatmapMathMode; label: string }[] = [
  { value: 'aggressive_directional_decay', label: 'Aggressive Directional (decay 5d)' },
  { value: 'aggressive_directional_raw', label: 'Aggressive Directional (raw)' },
  { value: 'net_signed', label: 'Net Signed (calls−puts)' },
  { value: 'total', label: 'Total Premium' },
  { value: 'voi_unusual', label: 'Volume / OI Unusual' },
];

const LOOKBACK_OPTIONS: { value: HeatmapLookback; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '3d', label: '3d' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
];

const PREMIUM_PRESETS: { value: number; label: string }[] = [
  { value: 100_000, label: '$100K' },
  { value: 250_000, label: '$250K' },
  { value: 500_000, label: '$500K' },
  { value: 1_000_000, label: '$1M' },
];

const BASELINE_OPTIONS: { value: BaselineMode; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: '1h', label: '1h ago' },
  { value: 'session_open', label: 'Session open' },
  { value: 'yesterday_close', label: 'Yesterday close' },
  { value: 'custom', label: 'Custom' },
];

/** Format a Date for an `<input type="datetime-local">` value (local TZ, no seconds). */
function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Format a min-premium number into an input-friendly short string. */
export function formatPremium(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${n}`;
}

/** Parse "$250K" / "1.5M" / "100000" into a number. Returns NaN if unparseable. */
export function parsePremium(s: string): number {
  const cleaned = s.trim().replace(/[$,\s]/g, '').toUpperCase();
  if (!cleaned) return NaN;
  const m = cleaned.match(/^(\d*\.?\d+)([KM])?$/);
  if (!m) return NaN;
  const num = parseFloat(m[1]);
  if (!Number.isFinite(num)) return NaN;
  if (m[2] === 'M') return num * 1_000_000;
  if (m[2] === 'K') return num * 1_000;
  return num;
}

export function HeatmapToolbar({ value, onChange }: HeatmapToolbarProps) {
  const set = <K extends keyof HeatmapToolbarValue>(k: K, v: HeatmapToolbarValue[K]) => {
    onChange({ ...value, [k]: v });
  };

  return (
    <div className="rounded-md border border-border bg-card/40 p-3 space-y-3">
      {/* Row 1: Math mode + lookback + view tabs (right) */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground shrink-0">Math:</Label>
          <Select value={value.mathMode} onValueChange={(v) => set('mathMode', v as HeatmapMathMode)}>
            <SelectTrigger className="h-8 w-[280px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MATH_MODE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value} className="text-xs">
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-1.5">
          <Label className="text-xs text-muted-foreground shrink-0 mr-1">Lookback:</Label>
          {LOOKBACK_OPTIONS.map((o) => (
            <button
              key={o.value}
              onClick={() => set('lookback', o.value)}
              className={cn(
                'text-[11px] font-mono px-2 py-1 rounded border transition-colors',
                value.lookback === o.value
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-muted bg-muted/20 text-muted-foreground hover:text-foreground',
              )}
            >
              {o.label}
            </button>
          ))}
        </div>

        <div className="ml-auto">
          <Tabs value={value.view} onValueChange={(v) => set('view', v as HeatmapView)}>
            <TabsList className="h-8">
              <TabsTrigger value="combined" className="text-[11px] px-3 h-7">Combined</TabsTrigger>
              <TabsTrigger value="per_ticker" className="text-[11px] px-3 h-7">Per-Ticker</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </div>

      {/* Row 2: 0DTE + Min premium + color anchor */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <Label htmlFor="heatmap-0dte" className="text-xs text-muted-foreground cursor-pointer">
            0DTE
          </Label>
          <Switch
            id="heatmap-0dte"
            checked={value.include0DTE}
            onCheckedChange={(v) => set('include0DTE', v)}
          />
        </div>

        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground shrink-0">Min premium:</Label>
          <Input
            value={formatPremium(value.minPremium)}
            onChange={(e) => {
              // We don't update on every keystroke — only on commit (blur/Enter).
              // But we still allow the displayed value to follow user edits.
              // Strategy: parse aggressively; if invalid, keep current.
              const parsed = parsePremium(e.target.value);
              if (Number.isFinite(parsed) && parsed >= 0) {
                set('minPremium', parsed);
              }
            }}
            onBlur={(e) => {
              // Re-format on blur to canonical form.
              const parsed = parsePremium(e.target.value);
              if (Number.isFinite(parsed) && parsed >= 0) {
                set('minPremium', parsed);
              }
            }}
            className="h-8 w-24 text-xs font-mono"
          />
          <div className="flex items-center gap-1">
            {PREMIUM_PRESETS.map((p) => (
              <button
                key={p.value}
                onClick={() => set('minPremium', p.value)}
                className={cn(
                  'text-[10px] font-mono px-1.5 py-0.5 rounded transition-colors',
                  value.minPremium === p.value
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2 ml-auto">
          <Label className="text-xs text-muted-foreground shrink-0">Color scale:</Label>
          {(['per_row', 'global'] as HeatmapColorAnchor[]).map((a) => (
            <button
              key={a}
              onClick={() => set('colorAnchor', a)}
              className={cn(
                'text-[10px] font-mono px-2 py-1 rounded border transition-colors',
                value.colorAnchor === a
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-muted bg-muted/20 text-muted-foreground hover:text-foreground',
              )}
            >
              {a === 'per_row' ? 'per-row' : 'global'}
            </button>
          ))}
        </div>
      </div>

      {/* Row 3: Change vs (baseline) */}
      <div className="flex flex-wrap items-center gap-2">
        <Label className="text-xs text-muted-foreground shrink-0 mr-1">Change vs:</Label>
        {BASELINE_OPTIONS.map((o) => (
          <button
            key={o.value}
            onClick={() => set('baselineMode', o.value)}
            className={cn(
              'text-[11px] font-mono px-2 py-1 rounded border transition-colors',
              value.baselineMode === o.value
                ? 'border-primary/40 bg-primary/10 text-primary'
                : 'border-muted bg-muted/20 text-muted-foreground hover:text-foreground',
            )}
          >
            {o.label}
          </button>
        ))}
        {value.baselineMode === 'custom' && (
          <input
            type="datetime-local"
            value={value.baselineCustomAt ? toLocalInputValue(value.baselineCustomAt) : ''}
            onChange={(e) => {
              const v = e.target.value;
              if (!v) {
                set('baselineCustomAt', undefined);
                return;
              }
              const d = new Date(v);
              if (Number.isFinite(d.getTime())) {
                set('baselineCustomAt', d);
              }
            }}
            className="h-7 text-[11px] font-mono px-2 rounded border border-muted bg-muted/20 text-foreground focus:outline-none focus:border-primary/40"
          />
        )}
      </div>
    </div>
  );
}

/** Map lookback chip to maxExpiryDays passed to the live RPC. */
export function lookbackToExpiryDays(l: HeatmapLookback): number {
  switch (l) {
    case '24h': return 7;
    case '3d':  return 14;
    case '7d':  return 35;
    case '30d': return 120;
  }
}
