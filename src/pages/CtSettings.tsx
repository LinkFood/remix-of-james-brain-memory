/**
 * CtSettings — Tunable configuration for Co-Trader.
 *
 * Reads and writes the `ct_config` table. Each row represents a threshold
 * that's currently hard-coded in an edge function somewhere. Editing a
 * value writes it to the DB; the value does NOT take effect until the
 * relevant edge function is refactored to call `getConfig()` from
 * `supabase/functions/_shared/configCache.ts`.
 *
 * INTEGRATION NOTE: Settings are read by edge functions on each invocation.
 * Changes apply on the next cron tick — no redeploy needed. Values are
 * cached for 60s in edge functions (via configCache.ts) to avoid per-tick
 * DB hits. Today no production function imports the helper yet — this
 * page is infrastructure waiting on opt-in.
 *
 * UI:
 *   - Grouped by category (cooldown / scoring / clusters / slack / usage /
 *     book / watcher).
 *   - Booleans render as a Switch; numbers as number input + slider;
 *     strings as Input. Save is explicit (button) per row.
 *   - Per-category "Reset to defaults" button.
 *   - Tooltip per row with description, default, and range.
 *   - Values outside min/max are refused with a toast.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Settings2,
  Info,
  RotateCcw,
  Save,
  Timer,
  Gauge,
  Layers,
  Send,
  Activity,
  Wallet,
  Radar,
  Scale,
  Shield,
  Zap,
  AlertTriangle,
  Sliders,
  History,
} from 'lucide-react';

type ConfigValue = number | boolean | string | null;

interface ConfigRow {
  id: string;
  key: string;
  value: ConfigValue;
  description: string | null;
  category: string;
  min_value: number | null;
  max_value: number | null;
  default_value: ConfigValue;
  updated_at: string;
}

interface CategoryMeta {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  blurb: string;
}

const CATEGORY_ORDER: string[] = [
  'cooldown',
  'scoring',
  'clusters',
  'slack',
  'usage',
  'book',
  'concentration',
  'watcher',
];

const CATEGORIES: Record<string, CategoryMeta> = {
  cooldown: {
    label: 'Cooldown',
    icon: Timer,
    blurb: 'Signal suppression and paper-book commit gating.',
  },
  scoring: {
    label: 'Scoring',
    icon: Gauge,
    blurb: 'Attention score thresholds for urgency, alerts, and flagging.',
  },
  clusters: {
    label: 'Clusters',
    icon: Layers,
    blurb: 'Sweep and dark-pool cluster triggers.',
  },
  slack: {
    label: 'Slack',
    icon: Send,
    blurb: 'Digest verbosity and live-push gating.',
  },
  usage: {
    label: 'UW Usage',
    icon: Activity,
    blurb: 'Unusual Whales API usage tier breakpoints.',
  },
  book: {
    label: 'Book',
    icon: Wallet,
    blurb: 'Intraday drawdown alert thresholds.',
  },
  concentration: {
    label: 'Concentration',
    icon: Scale,
    blurb: 'Portfolio concentration caps — ticker, theme, direction, options count. Gates NEW trades only; existing positions are never force-closed.',
  },
  watcher: {
    label: 'Watcher',
    icon: Radar,
    blurb: 'Watcher budget limits.',
  },
};

function detectType(value: ConfigValue): 'boolean' | 'number' | 'string' {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  return 'string';
}

function formatDisplay(value: ConfigValue): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  return String(value);
}

/** Find a sensible slider step given the min/max range. */
function sliderStep(min: number, max: number): number {
  const span = Math.abs(max - min);
  if (span <= 5) return 0.1;
  if (span <= 50) return 1;
  if (span <= 500) return 5;
  if (span <= 5_000) return 50;
  if (span <= 500_000) return 1_000;
  return 10_000;
}

// ---------------------------------------------------------------------------
// Preset types + constants — wired to the apply_config_preset RPC and the
// ct-preset-apply edge function.
// ---------------------------------------------------------------------------

type PresetName = 'conservative' | 'moderate' | 'aggressive' | 'paranoid';

interface PresetMeta {
  label: string;
  blurb: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: string; // tailwind color class fragment
}

const PRESETS: { name: PresetName; meta: PresetMeta }[] = [
  {
    name: 'conservative',
    meta: {
      label: 'Conservative',
      blurb: 'Tight cooldowns, small size, few trades. Fewer, higher-conviction.',
      icon: Shield,
      tone: 'text-sky-400 border-sky-400/40 hover:bg-sky-400/10',
    },
  },
  {
    name: 'moderate',
    meta: {
      label: 'Moderate',
      blurb: 'Restore the seeded defaults. Balanced posture.',
      icon: Sliders,
      tone: 'text-emerald-400 border-emerald-400/40 hover:bg-emerald-400/10',
    },
  },
  {
    name: 'aggressive',
    meta: {
      label: 'Aggressive',
      blurb: 'More trades, tighter latency. Opens the book up.',
      icon: Zap,
      tone: 'text-amber-400 border-amber-400/40 hover:bg-amber-400/10',
    },
  },
  {
    name: 'paranoid',
    meta: {
      label: 'Paranoid',
      blurb: 'Defensive. For volatile days. Very few entries.',
      icon: AlertTriangle,
      tone: 'text-rose-400 border-rose-400/40 hover:bg-rose-400/10',
    },
  },
];

interface PresetDiffEntry {
  key: string;
  current: ConfigValue | null;
  next: ConfigValue;
  action: 'change' | 'skip' | 'noop';
}

interface PresetPreview {
  preset: string;
  entries: PresetDiffEntry[];
}

interface PresetLogRow {
  id: string;
  preset: string;
  applied_at: string;
  applied_by: string | null;
  keys_changed: number;
  keys_skipped: number;
  diff_summary: Array<{ key: string; old: unknown; new: unknown }>;
}

interface CurrentPreset {
  preset: string;
  applied_at: string;
  applied_by: string | null;
  keys_changed: number;
  keys_skipped: number;
  log_id: string;
}

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const sec = Math.max(0, Math.floor(diffMs / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

export default function CtSettings() {
  const [rows, setRows] = useState<ConfigRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, ConfigValue>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});

  // Preset state
  const [currentPreset, setCurrentPreset] = useState<CurrentPreset | null>(null);
  const [history, setHistory] = useState<PresetLogRow[]>([]);
  const [preview, setPreview] = useState<PresetPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState<PresetName | null>(null);
  const [applying, setApplying] = useState(false);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('ct_config')
      .select('*')
      .order('category', { ascending: true })
      .order('key', { ascending: true });

    if (error) {
      toast.error(`Failed to load config: ${error.message}`);
      setLoading(false);
      return;
    }

    const parsed = (data || []).map((r) => ({
      ...r,
      value: r.value as ConfigValue,
      default_value: r.default_value as ConfigValue,
    })) as ConfigRow[];

    setRows(parsed);
    const next: Record<string, ConfigValue> = {};
    parsed.forEach((r) => {
      next[r.key] = r.value;
    });
    setDrafts(next);
    setLoading(false);
  }, []);

  const fetchPresetState = useCallback(async () => {
    // Current preset (most recent log row).
    const currentRes = await supabase.rpc('current_config_preset');
    if (!currentRes.error && currentRes.data) {
      setCurrentPreset(currentRes.data as unknown as CurrentPreset);
    } else {
      setCurrentPreset(null);
    }

    // Last 5 preset changes.
    const histRes = await supabase
      .from('ct_config_preset_log')
      .select('*')
      .order('applied_at', { ascending: false })
      .limit(5);
    if (!histRes.error) {
      setHistory((histRes.data ?? []) as unknown as PresetLogRow[]);
    }
  }, []);

  useEffect(() => {
    fetchRows();
    fetchPresetState();
  }, [fetchRows, fetchPresetState]);

  const openPreview = async (name: PresetName) => {
    setPreviewLoading(name);
    const { data, error } = await supabase.rpc('preview_config_preset', { p_preset: name });
    setPreviewLoading(null);
    if (error) {
      toast.error(`Preview failed: ${error.message}`);
      return;
    }
    setPreview(data as unknown as PresetPreview);
  };

  const confirmApplyPreset = async () => {
    if (!preview) return;
    setApplying(true);
    const { data, error } = await supabase.functions.invoke('ct-preset-apply', {
      body: { preset: preview.preset },
    });
    setApplying(false);

    if (error) {
      toast.error(`Apply failed: ${error.message}`);
      return;
    }
    const res = data as { keys_changed?: number; keys_skipped?: number; preset?: string };
    toast.success(
      `Preset applied: ${res.preset} · ${res.keys_changed ?? 0} changed`
        + (res.keys_skipped ? ` · ${res.keys_skipped} skipped` : ''),
    );
    setPreview(null);
    await Promise.all([fetchRows(), fetchPresetState()]);
  };

  // Drift = count of keys that currently differ from the last-applied preset's
  // target values. A preset with 0 changes right now but 3 keys touched since
  // = "custom (drifted from moderate)".
  const presetDrift = useMemo(() => {
    if (!currentPreset) return 0;
    // Without re-fetching the map, we use a proxy: if any row.value differs
    // from row.default_value AND the applied preset was 'moderate', it's drift.
    // For non-moderate presets, we cannot compute drift client-side without
    // the map — show 0 and rely on a preview click to surface it.
    if (currentPreset.preset === 'moderate' || currentPreset.preset === 'default') {
      return rows.filter((r) => {
        const a = r.value;
        const b = r.default_value;
        if (typeof a === 'number' && typeof b === 'number') {
          return Math.abs(a - b) > 1e-9;
        }
        return a !== b;
      }).length;
    }
    return 0;
  }, [rows, currentPreset]);

  const byCategory = useMemo(() => {
    const map: Record<string, ConfigRow[]> = {};
    rows.forEach((r) => {
      (map[r.category] ||= []).push(r);
    });
    return map;
  }, [rows]);

  const setDraft = (key: string, v: ConfigValue) => {
    setDrafts((d) => ({ ...d, [key]: v }));
  };

  const isDirty = (row: ConfigRow) => {
    const draft = drafts[row.key];
    if (typeof draft === 'number' && typeof row.value === 'number') {
      return Math.abs(draft - row.value) > 1e-9;
    }
    return draft !== row.value;
  };

  const validate = (row: ConfigRow, draft: ConfigValue): string | null => {
    const kind = detectType(row.default_value);
    if (kind === 'number') {
      const n = typeof draft === 'number' ? draft : Number(draft);
      if (Number.isNaN(n)) return 'Not a number';
      if (row.min_value !== null && n < row.min_value) {
        return `Below min (${row.min_value})`;
      }
      if (row.max_value !== null && n > row.max_value) {
        return `Above max (${row.max_value})`;
      }
    }
    return null;
  };

  const saveRow = async (row: ConfigRow) => {
    const draft = drafts[row.key];
    const err = validate(row, draft);
    if (err) {
      toast.error(`${row.key}: ${err}`);
      return;
    }

    setSaving((s) => ({ ...s, [row.key]: true }));
    const { error } = await supabase
      .from('ct_config')
      .update({ value: draft as unknown as object })
      .eq('key', row.key);
    setSaving((s) => ({ ...s, [row.key]: false }));

    if (error) {
      toast.error(`Save failed: ${error.message}`);
      return;
    }
    toast.success(`${row.key} saved`);
    setRows((prev) => prev.map((r) => (r.key === row.key ? { ...r, value: draft } : r)));
  };

  const resetRowToDefault = (row: ConfigRow) => {
    setDraft(row.key, row.default_value);
  };

  const resetCategoryToDefaults = async (category: string) => {
    const inCat = rows.filter((r) => r.category === category);
    if (inCat.length === 0) return;

    setSaving((s) => {
      const next = { ...s };
      inCat.forEach((r) => (next[r.key] = true));
      return next;
    });

    const results = await Promise.all(
      inCat.map((r) =>
        supabase
          .from('ct_config')
          .update({ value: r.default_value as unknown as object })
          .eq('key', r.key),
      ),
    );

    setSaving((s) => {
      const next = { ...s };
      inCat.forEach((r) => (next[r.key] = false));
      return next;
    });

    const failed = results.filter((r) => r.error);
    if (failed.length) {
      toast.error(`${failed.length} reset(s) failed`);
    } else {
      toast.success(`${CATEGORIES[category]?.label ?? category} reset to defaults`);
    }
    fetchRows();
  };

  return (
    <TooltipProvider>
      <div className="h-full overflow-auto p-4">
        <div className="max-w-4xl mx-auto space-y-4">
          {/* Header */}
          <Card className="p-5 bg-card border-border">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-primary/10 rounded-xl flex items-center justify-center">
                <Settings2 className="w-5 h-5 text-primary" />
              </div>
              <div className="flex-1">
                <h1 className="text-xl font-bold">Co-Trader Config</h1>
                <p className="text-xs text-muted-foreground">
                  Tunable thresholds. Changes apply on the next cron tick — no redeploy. Values are
                  cached for 60s in edge functions via{' '}
                  <code className="px-1 rounded bg-muted/60">_shared/configCache.ts</code>.
                </p>
              </div>
            </div>
          </Card>

          {/* Preset bar */}
          <Card className="p-5 bg-card border-border">
            <div className="flex items-start justify-between gap-4 mb-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-semibold">Risk preset</h2>
                  {currentPreset ? (
                    <Badge variant="outline" className="text-xs font-mono">
                      {presetDrift > 0 ? `custom · drifted from ${currentPreset.preset}` : currentPreset.preset}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-xs font-mono">custom</Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {currentPreset ? (
                    <>
                      Last applied: <span className="font-mono">{currentPreset.preset}</span>{' · '}
                      {formatRelativeTime(currentPreset.applied_at)}
                      {' · '}{currentPreset.keys_changed} keys changed
                    </>
                  ) : (
                    'No preset has been applied yet — values are whatever was seeded.'
                  )}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {PRESETS.map(({ name, meta }) => {
                const Icon = meta.icon;
                const isCurrent = currentPreset?.preset === name && presetDrift === 0;
                return (
                  <Tooltip key={name}>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        className={`h-auto py-3 flex flex-col items-center gap-1 ${meta.tone} ${isCurrent ? 'ring-1 ring-current' : ''}`}
                        disabled={previewLoading !== null}
                        onClick={() => openPreview(name)}
                      >
                        <Icon className="w-4 h-4" />
                        <span className="text-sm font-semibold">{meta.label}</span>
                        {previewLoading === name && (
                          <span className="text-[10px] text-muted-foreground">loading…</span>
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-xs text-xs">
                      {meta.blurb}
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          </Card>

          {/* Preset history */}
          {history.length > 0 && (
            <Card className="p-5 bg-card border-border">
              <div className="flex items-center gap-2 mb-3">
                <History className="w-4 h-4 text-muted-foreground" />
                <h2 className="text-base font-semibold">Recent preset changes</h2>
              </div>
              <div className="space-y-2">
                {history.map((row) => (
                  <div
                    key={row.id}
                    className="flex items-center justify-between text-xs py-1.5 px-2 rounded-md bg-muted/30"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Badge variant="outline" className="font-mono">{row.preset}</Badge>
                      <span className="text-muted-foreground">
                        {row.keys_changed} changed
                        {row.keys_skipped > 0 ? ` · ${row.keys_skipped} skipped` : ''}
                      </span>
                    </div>
                    <div className="text-muted-foreground font-mono text-[11px] shrink-0">
                      {new Date(row.applied_at).toLocaleString()} · {formatRelativeTime(row.applied_at)}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {loading && (
            <Card className="p-4 text-sm text-muted-foreground">Loading config…</Card>
          )}

          {!loading && rows.length === 0 && (
            <Card className="p-4 text-sm text-muted-foreground">
              No config rows — run the latest migration to seed defaults.
            </Card>
          )}

          {!loading &&
            CATEGORY_ORDER.filter((c) => byCategory[c]?.length).map((category) => {
              const meta = CATEGORIES[category];
              const Icon = meta?.icon ?? Settings2;
              const catRows = byCategory[category] ?? [];

              return (
                <Card key={category} className="p-5 bg-card border-border">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 bg-primary/10 rounded-lg flex items-center justify-center">
                        <Icon className="w-4 h-4 text-primary" />
                      </div>
                      <div>
                        <h2 className="text-base font-semibold">{meta?.label ?? category}</h2>
                        <p className="text-xs text-muted-foreground">{meta?.blurb}</p>
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-xs"
                      onClick={() => resetCategoryToDefaults(category)}
                    >
                      <RotateCcw className="w-3 h-3 mr-1" />
                      Reset category
                    </Button>
                  </div>

                  <div className="space-y-3">
                    {catRows.map((row, idx) => (
                      <div key={row.key}>
                        {idx > 0 && <Separator className="my-2 opacity-50" />}
                        <ConfigRowEditor
                          row={row}
                          draft={drafts[row.key]}
                          dirty={isDirty(row)}
                          saving={!!saving[row.key]}
                          onChange={(v) => setDraft(row.key, v)}
                          onSave={() => saveRow(row)}
                          onResetToDefault={() => resetRowToDefault(row)}
                        />
                      </div>
                    ))}
                  </div>
                </Card>
              );
            })}
        </div>

        {/* Preset preview dialog */}
        <Dialog open={!!preview} onOpenChange={(o) => { if (!o) setPreview(null); }}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>
                Apply preset: <span className="font-mono">{preview?.preset}</span>
              </DialogTitle>
              <DialogDescription>
                Review the diff below. Click Confirm to apply atomically. Keys already at the
                target value are hidden; keys not present in the current config are marked
                <span className="font-mono mx-1">skip</span>.
              </DialogDescription>
            </DialogHeader>

            {preview && (() => {
              const changes = preview.entries.filter((e) => e.action === 'change');
              const skips = preview.entries.filter((e) => e.action === 'skip');
              const noops = preview.entries.filter((e) => e.action === 'noop').length;
              return (
                <div className="space-y-3 max-h-[50vh] overflow-auto">
                  <div className="text-xs text-muted-foreground flex gap-3">
                    <span><span className="font-mono text-emerald-400">{changes.length}</span> change{changes.length === 1 ? '' : 's'}</span>
                    <span><span className="font-mono">{noops}</span> already match</span>
                    {skips.length > 0 && (
                      <span><span className="font-mono text-amber-400">{skips.length}</span> skip (not seeded)</span>
                    )}
                  </div>

                  {changes.length === 0 && skips.length === 0 && (
                    <div className="text-sm text-muted-foreground py-4 text-center">
                      No changes — config already matches this preset.
                    </div>
                  )}

                  {changes.map((e) => (
                    <div key={e.key} className="text-xs flex items-center gap-2 py-1 border-b border-border/50">
                      <code className="font-mono flex-1 truncate">{e.key}</code>
                      <span className="font-mono text-muted-foreground">{JSON.stringify(e.current)}</span>
                      <span className="text-muted-foreground">→</span>
                      <span className="font-mono text-emerald-400">{JSON.stringify(e.next)}</span>
                    </div>
                  ))}

                  {skips.length > 0 && (
                    <div className="pt-2">
                      <div className="text-xs font-semibold text-amber-400 mb-1">Skipped (key not in ct_config)</div>
                      {skips.map((e) => (
                        <div key={e.key} className="text-xs flex items-center gap-2 py-0.5">
                          <code className="font-mono flex-1 truncate text-muted-foreground">{e.key}</code>
                          <span className="font-mono text-muted-foreground">would-be: {JSON.stringify(e.next)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}

            <DialogFooter>
              <Button variant="outline" onClick={() => setPreview(null)} disabled={applying}>
                Cancel
              </Button>
              <Button
                onClick={confirmApplyPreset}
                disabled={applying || !preview || preview.entries.filter((e) => e.action === 'change').length === 0}
              >
                {applying ? 'Applying…' : 'Confirm apply'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  );
}

interface EditorProps {
  row: ConfigRow;
  draft: ConfigValue;
  dirty: boolean;
  saving: boolean;
  onChange: (v: ConfigValue) => void;
  onSave: () => void;
  onResetToDefault: () => void;
}

function ConfigRowEditor({ row, draft, dirty, saving, onChange, onSave, onResetToDefault }: EditorProps) {
  const kind = detectType(row.default_value);
  const canSlide =
    kind === 'number' && row.min_value !== null && row.max_value !== null;

  return (
    <div className="flex items-start gap-4">
      {/* Label + tooltip */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <Label className="text-sm font-medium font-mono">{row.key}</Label>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="text-muted-foreground/60 hover:text-muted-foreground"
                aria-label={`About ${row.key}`}
              >
                <Info className="w-3 h-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs text-xs">
              <div className="space-y-1">
                {row.description && <div>{row.description}</div>}
                <div className="text-muted-foreground">
                  default: <span className="font-mono">{formatDisplay(row.default_value)}</span>
                  {row.min_value !== null && row.max_value !== null && (
                    <>
                      {' · '}range: <span className="font-mono">{row.min_value}</span>–
                      <span className="font-mono">{row.max_value}</span>
                    </>
                  )}
                </div>
              </div>
            </TooltipContent>
          </Tooltip>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">
          current: <span className="font-mono">{formatDisplay(row.value)}</span>
        </p>
      </div>

      {/* Editor */}
      <div className="flex items-center gap-2 w-[320px] shrink-0">
        {kind === 'boolean' && (
          <div className="flex-1 flex items-center justify-end">
            <Switch
              checked={!!(draft ?? false)}
              onCheckedChange={(v) => onChange(v)}
              disabled={saving}
            />
          </div>
        )}

        {kind === 'number' && (
          <>
            {canSlide && (
              <Slider
                className="flex-1"
                min={row.min_value as number}
                max={row.max_value as number}
                step={sliderStep(row.min_value as number, row.max_value as number)}
                value={[typeof draft === 'number' ? draft : Number(draft ?? 0)]}
                onValueChange={([v]) => onChange(v)}
                disabled={saving}
              />
            )}
            <Input
              type="number"
              className="w-24 h-8 text-sm font-mono"
              value={draft === null || draft === undefined ? '' : String(draft)}
              min={row.min_value ?? undefined}
              max={row.max_value ?? undefined}
              onChange={(e) => {
                const v = e.target.value;
                onChange(v === '' ? null : Number(v));
              }}
              disabled={saving}
            />
          </>
        )}

        {kind === 'string' && (
          <Input
            type="text"
            className="flex-1 h-8 text-sm font-mono"
            value={(draft as string) ?? ''}
            onChange={(e) => onChange(e.target.value)}
            disabled={saving}
          />
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 shrink-0">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 px-2 text-xs"
          onClick={onResetToDefault}
          disabled={saving || draft === row.default_value}
          title="Reset to default"
        >
          <RotateCcw className="w-3 h-3" />
        </Button>
        <Button
          size="sm"
          className="h-8 px-3 text-xs"
          onClick={onSave}
          disabled={saving || !dirty}
        >
          <Save className="w-3 h-3 mr-1" />
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}
