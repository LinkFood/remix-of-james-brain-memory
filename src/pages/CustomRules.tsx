/**
 * CustomRules — James's own alert triggers, at /rules.
 *
 * Distinct from Claude-authored alerts. Each rule is a list of clauses (field,
 * op, value, optional window_min), a match logic (all / any), and an action
 * (slack / log / both). Evaluated every 5 min during RTH by ct-custom-rule-eval.
 *
 * This page is the CRUD surface + a "Test" button that evaluates the current
 * draft against the live state snapshot without touching the DB, using the
 * exact same evaluator the edge function uses (_shared/customRuleEval.ts via
 * a thin inline re-export wrapped in frontend types).
 *
 * Zero UW calls — the Test button pulls the latest ct_heartbeats row + one
 * NOPE + one IV-rank read and runs the evaluator client-side. Cheap.
 */

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Trash2, Pencil, Plus, Play, CheckCircle2, XCircle, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import {
  evaluateConditions, validateRule, RuleClause, RuleOp,
} from '../../supabase/functions/_shared/customRuleEval';

// -----------------------------------------------------------------------------
// Field + op vocabulary — mirror of the edge function's worldview.
// Keeping this in one place means the dropdown can never offer a field the
// evaluator doesn't understand.
// -----------------------------------------------------------------------------

const WATCHLIST_TICKERS = ['SPY', 'QQQ', 'IWM', 'NVDA', 'AAPL', 'META', 'TSLA', 'AMZN', 'MSFT', 'GOOGL'];
const PER_TICKER_METRICS = [
  { value: 'price',        label: 'price' },
  { value: 'regime',       label: 'regime (positive/negative/unknown)' },
  { value: 'gamma_flip',   label: 'gamma_flip' },
  { value: 'call_wall',    label: 'call_wall' },
  { value: 'put_wall',     label: 'put_wall' },
  { value: 'net_gamma_oi', label: 'net_gamma_oi' },
  { value: 'NOPE',         label: 'NOPE' },
  { value: 'iv_rank',      label: 'iv_rank' },
];

const GLOBAL_FIELDS = [
  { field: 'VIX.level',       label: 'VIX.level' },
  { field: 'VIX.change_pct',  label: 'VIX.change_pct' },
  { field: 'SPX.price',       label: 'SPX.price' },
  { field: 'SPX.regime',      label: 'SPX.regime' },
  { field: 'SPX.gamma_flip',  label: 'SPX.gamma_flip' },
];

// Complete field list for the dropdown: per-ticker × metric + globals.
const FIELD_OPTIONS: Array<{ field: string; label: string }> = [
  ...WATCHLIST_TICKERS.flatMap((t) =>
    PER_TICKER_METRICS.map((m) => ({
      field: `${t}.${m.value}`,
      label: `${t}.${m.value}`,
    })),
  ),
  ...GLOBAL_FIELDS,
];

const OP_OPTIONS: Array<{ value: RuleOp; label: string; needsValue: boolean; supportsWindow: boolean }> = [
  { value: 'lt',             label: '<',             needsValue: true,  supportsWindow: false },
  { value: 'lte',            label: '≤',             needsValue: true,  supportsWindow: false },
  { value: 'gt',             label: '>',             needsValue: true,  supportsWindow: false },
  { value: 'gte',            label: '≥',             needsValue: true,  supportsWindow: false },
  { value: 'eq',             label: '=',             needsValue: true,  supportsWindow: false },
  { value: 'crosses_above',  label: 'crosses above', needsValue: true,  supportsWindow: true  },
  { value: 'crosses_below',  label: 'crosses below', needsValue: true,  supportsWindow: true  },
  { value: 'changed',        label: 'changed',       needsValue: false, supportsWindow: false },
];

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface CustomRule {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  active: boolean;
  conditions: RuleClause[];
  match_logic: 'all' | 'any';
  action: 'slack' | 'log' | 'both';
  fire_count: number;
  last_fired_at: string | null;
  created_at: string;
  updated_at: string;
}

interface DraftRule {
  id?: string;
  name: string;
  description: string;
  active: boolean;
  conditions: RuleClause[];
  match_logic: 'all' | 'any';
  action: 'slack' | 'log' | 'both';
}

const EMPTY_CLAUSE: RuleClause = { field: 'SPY.price', op: 'lt', value: 0 };
const EMPTY_DRAFT: DraftRule = {
  name: '',
  description: '',
  active: true,
  conditions: [{ ...EMPTY_CLAUSE }],
  match_logic: 'all',
  action: 'slack',
};

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function fmtTimeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// -----------------------------------------------------------------------------
// State-builder for the TEST button. Mirrors the cron's buildState() shape —
// same fields, same tables — but runs in the browser so James can preview
// without deploying. If this ever drifts from the edge fn, tests will lie.
// -----------------------------------------------------------------------------

async function buildCurrentStateClient(): Promise<{
  current: Record<string, Record<string, unknown>>;
  prior: Record<string, Record<string, unknown>>;
  snapshot_ts: string | null;
}> {
  const current: Record<string, Record<string, unknown>> = {};
  const prior: Record<string, Record<string, unknown>> = {};

  // Heartbeats — last 2.
  const { data: hbs } = await supabase
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .from('ct_heartbeats' as any)
    .select('id, created_at, current_reads')
    .order('created_at', { ascending: false })
    .limit(2);
  const rows = (hbs ?? []) as Array<{ id: string; created_at: string; current_reads: Record<string, unknown> | null }>;
  const snapshot_ts = rows[0]?.created_at ?? null;

  const pickFromSnapshot = (hb: typeof rows[0] | undefined, bucket: Record<string, Record<string, unknown>>) => {
    if (!hb?.current_reads) return;
    const reads = hb.current_reads as Record<string, unknown>;
    const snap = (reads._snapshot && typeof reads._snapshot === 'object')
      ? reads._snapshot as Record<string, unknown>
      : reads;
    const pt = snap.per_ticker as Record<string, Record<string, unknown>> | undefined;
    if (pt) {
      for (const [tkr, inst] of Object.entries(pt)) {
        if (!inst || typeof inst !== 'object') continue;
        bucket[tkr] = {
          ...(bucket[tkr] ?? {}),
          price: inst.price ?? null,
          regime: inst.regime ?? null,
          gamma_flip: inst.gamma_flip ?? null,
          call_wall: inst.call_wall ?? null,
          put_wall: inst.put_wall ?? null,
          net_gamma_oi: inst.net_gamma_oi ?? null,
        };
      }
    }
    const spx = snap.spx_macro as Record<string, unknown> | undefined;
    if (spx) {
      bucket.SPX = {
        ...(bucket.SPX ?? {}),
        price: spx.price ?? null,
        regime: spx.regime ?? null,
        gamma_flip: spx.gamma_flip ?? null,
      };
    }
    const vix = snap.vix as Record<string, unknown> | undefined;
    if (vix) {
      bucket.VIX = {
        ...(bucket.VIX ?? {}),
        level: vix.level ?? null,
        change_pct: vix.change_pct ?? null,
        tier: vix.tier ?? null,
      };
    }
  };
  pickFromSnapshot(rows[0], current);
  pickFromSnapshot(rows[1], prior);

  // NOPE — last 2h.
  const nopeSince = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  const { data: nopeRows } = await supabase
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .from('ct_nope_minute' as any)
    .select('ticker, nope, tick_timestamp')
    .gte('tick_timestamp', nopeSince)
    .order('tick_timestamp', { ascending: false })
    .limit(1000);
  if (Array.isArray(nopeRows)) {
    const byTicker = new Map<string, Array<{ nope: number; ts: number }>>();
    for (const r of nopeRows as Array<{ ticker: string; nope: number | null; tick_timestamp: string }>) {
      if (r.nope === null || r.nope === undefined) continue;
      const arr = byTicker.get(r.ticker) ?? [];
      arr.push({ nope: r.nope, ts: new Date(r.tick_timestamp).getTime() });
      byTicker.set(r.ticker, arr);
    }
    for (const [tkr, list] of byTicker.entries()) {
      current[tkr] = { ...(current[tkr] ?? {}), NOPE: list[0].nope };
      if (list[1]) prior[tkr] = { ...(prior[tkr] ?? {}), NOPE: list[1].nope };
    }
  }

  // IV rank.
  const ivSince = new Date(Date.now() - 10 * 86400_000).toISOString().slice(0, 10);
  const { data: ivRows } = await supabase
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .from('ct_iv_rank_daily' as any)
    .select('ticker, date, iv_rank')
    .gte('date', ivSince)
    .order('ticker', { ascending: true })
    .order('date', { ascending: false })
    .limit(500);
  if (Array.isArray(ivRows)) {
    const byT = new Map<string, Array<{ iv_rank: number; date: string }>>();
    for (const r of ivRows as Array<{ ticker: string; date: string; iv_rank: number | null }>) {
      if (r.iv_rank === null) continue;
      const arr = byT.get(r.ticker) ?? [];
      arr.push({ iv_rank: r.iv_rank, date: r.date });
      byT.set(r.ticker, arr);
    }
    for (const [tkr, list] of byT.entries()) {
      current[tkr] = { ...(current[tkr] ?? {}), iv_rank: list[0].iv_rank };
      if (list[1]) prior[tkr] = { ...(prior[tkr] ?? {}), iv_rank: list[1].iv_rank };
    }
  }

  return { current, prior, snapshot_ts };
}

// -----------------------------------------------------------------------------
// Page
// -----------------------------------------------------------------------------

export default function CustomRules() {
  const qc = useQueryClient();
  const [userId, setUserId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState<DraftRule>(EMPTY_DRAFT);
  const [testResult, setTestResult] = useState<null | {
    matches: boolean;
    matched_clauses: string[];
    evaluations: Array<{ clause: RuleClause; matched: boolean; current: unknown; prior: unknown; reason: string }>;
    snapshot_ts: string | null;
  }>(null);

  useEffect(() => {
    // JAC gotcha: getUser() forces a server refresh so we never sit on a stale JWT.
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) setUserId(user.id);
    });
  }, []);

  // Load rules (RLS scopes to user automatically).
  const { data: rules = [], isLoading } = useQuery<CustomRule[]>({
    queryKey: ['ct_custom_rules'],
    enabled: !!userId,
    queryFn: async () => {
      const { data, error } = await supabase
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .from('ct_custom_rules' as any)
        .select('*')
        .order('active', { ascending: false })
        .order('created_at', { ascending: false });
      if (error) throw error;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (data ?? []) as any[] as CustomRule[];
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (d: DraftRule) => {
      if (!userId) throw new Error('not authed');
      const errs = validateRule(d);
      if (errs.length > 0) throw new Error(errs.join('; '));
      const payload = {
        user_id: userId,
        name: d.name.trim(),
        description: d.description.trim() || null,
        active: d.active,
        conditions: d.conditions,
        match_logic: d.match_logic,
        action: d.action,
      };
      if (d.id) {
        const { error } = await supabase
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .from('ct_custom_rules' as any)
          .update(payload)
          .eq('id', d.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .from('ct_custom_rules' as any)
          .insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success('Rule saved');
      qc.invalidateQueries({ queryKey: ['ct_custom_rules'] });
      setEditorOpen(false);
      setDraft(EMPTY_DRAFT);
      setTestResult(null);
    },
    onError: (e: unknown) => {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .from('ct_custom_rules' as any)
        .delete()
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Rule deleted');
      qc.invalidateQueries({ queryKey: ['ct_custom_rules'] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Delete failed'),
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      const { error } = await supabase
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .from('ct_custom_rules' as any)
        .update({ active })
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ct_custom_rules'] }),
  });

  const openNew = () => {
    setDraft(EMPTY_DRAFT);
    setTestResult(null);
    setEditorOpen(true);
  };

  const openEdit = (r: CustomRule) => {
    setDraft({
      id: r.id,
      name: r.name,
      description: r.description ?? '',
      active: r.active,
      conditions: r.conditions && r.conditions.length > 0 ? r.conditions : [{ ...EMPTY_CLAUSE }],
      match_logic: r.match_logic,
      action: r.action,
    });
    setTestResult(null);
    setEditorOpen(true);
  };

  const runTest = async () => {
    try {
      const { current, prior, snapshot_ts } = await buildCurrentStateClient();
      const result = evaluateConditions(draft.conditions, draft.match_logic, current, prior);
      setTestResult({ ...result, snapshot_ts });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Test failed');
    }
  };

  const draftErrors = useMemo(() => validateRule(draft), [draft]);

  return (
    <div className="p-6 space-y-4 max-w-5xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Custom rules</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Your own alert triggers. Evaluated every 5 min during RTH. Alerts only — never executes trades.
          </p>
        </div>
        <Button onClick={openNew} size="sm" className="gap-1.5">
          <Plus className="w-3.5 h-3.5" /> New rule
        </Button>
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : rules.length === 0 ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">
          No custom rules yet. Click <strong>New rule</strong> to author your first trigger.
        </Card>
      ) : (
        <div className="space-y-2">
          {rules.map((r) => (
            <Card key={r.id} className="p-3">
              <div className="flex items-start gap-3">
                <div className="shrink-0 pt-1">
                  <Switch
                    checked={r.active}
                    onCheckedChange={(checked) => toggleMutation.mutate({ id: r.id, active: checked })}
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{r.name}</span>
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                      {r.match_logic === 'all' ? 'AND' : 'OR'}
                    </Badge>
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                      {r.action}
                    </Badge>
                    {!r.active && (
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0">inactive</Badge>
                    )}
                  </div>
                  {r.description && (
                    <p className="text-xs text-muted-foreground mt-1">{r.description}</p>
                  )}
                  <ul className="mt-1.5 space-y-0.5">
                    {r.conditions.map((c, i) => (
                      <li key={i} className="text-xs text-muted-foreground font-mono">
                        {c.field} {c.op}{c.value !== undefined ? ` ${c.value}` : ''}
                        {c.window_min ? ` (window ${c.window_min}m)` : ''}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground">
                    <span>Fired {r.fire_count}×</span>
                    <span>Last: {fmtTimeAgo(r.last_fired_at)}</span>
                  </div>
                </div>
                <div className="shrink-0 flex items-center gap-1">
                  <Button size="icon" variant="ghost" onClick={() => openEdit(r)} className="h-7 w-7">
                    <Pencil className="w-3.5 h-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-destructive hover:text-destructive"
                    onClick={() => {
                      if (confirm(`Delete rule "${r.name}"?`)) deleteMutation.mutate(r.id);
                    }}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{draft.id ? 'Edit rule' : 'New rule'}</DialogTitle>
            <DialogDescription>
              Reads from the heartbeat state. Fires Slack or logs when conditions match.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div>
              <Label htmlFor="rule-name" className="text-xs">Name</Label>
              <Input
                id="rule-name"
                value={draft.name}
                placeholder="SPY flush below 710 + NOPE flip"
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                maxLength={120}
              />
            </div>

            <div>
              <Label htmlFor="rule-desc" className="text-xs">Description (optional)</Label>
              <Textarea
                id="rule-desc"
                value={draft.description}
                placeholder="Why this rule matters. You'll thank yourself in 3 months."
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                rows={2}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Match logic</Label>
                <Select
                  value={draft.match_logic}
                  onValueChange={(v) => setDraft({ ...draft, match_logic: v as 'all' | 'any' })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">ALL conditions must match (AND)</SelectItem>
                    <SelectItem value="any">ANY condition must match (OR)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Action</Label>
                <Select
                  value={draft.action}
                  onValueChange={(v) => setDraft({ ...draft, action: v as DraftRule['action'] })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="slack">Slack only</SelectItem>
                    <SelectItem value="log">Log only</SelectItem>
                    <SelectItem value="both">Slack + log</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Switch
                checked={draft.active}
                onCheckedChange={(v) => setDraft({ ...draft, active: v })}
              />
              <Label className="text-xs">Active</Label>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <Label className="text-xs">Conditions</Label>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs gap-1"
                  onClick={() => setDraft({ ...draft, conditions: [...draft.conditions, { ...EMPTY_CLAUSE }] })}
                  disabled={draft.conditions.length >= 10}
                >
                  <Plus className="w-3 h-3" /> Add condition
                </Button>
              </div>
              <div className="space-y-2">
                {draft.conditions.map((c, i) => {
                  const opMeta = OP_OPTIONS.find((o) => o.value === c.op);
                  return (
                    <div key={i} className="flex items-center gap-1.5">
                      <Select
                        value={c.field}
                        onValueChange={(v) => {
                          const next = [...draft.conditions];
                          next[i] = { ...next[i], field: v };
                          setDraft({ ...draft, conditions: next });
                        }}
                      >
                        <SelectTrigger className="w-[180px] h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="max-h-72">
                          {FIELD_OPTIONS.map((f) => (
                            <SelectItem key={f.field} value={f.field} className="text-xs">
                              {f.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select
                        value={c.op}
                        onValueChange={(v) => {
                          const next = [...draft.conditions];
                          const nextOp = v as RuleOp;
                          const meta = OP_OPTIONS.find((o) => o.value === nextOp);
                          next[i] = {
                            ...next[i],
                            op: nextOp,
                            value: meta?.needsValue ? next[i].value ?? 0 : undefined,
                            window_min: meta?.supportsWindow ? next[i].window_min ?? 5 : undefined,
                          };
                          setDraft({ ...draft, conditions: next });
                        }}
                      >
                        <SelectTrigger className="w-[130px] h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {OP_OPTIONS.map((o) => (
                            <SelectItem key={o.value} value={o.value} className="text-xs">
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {opMeta?.needsValue && (
                        <Input
                          className="h-8 w-[100px] text-xs"
                          placeholder="value"
                          value={c.value ?? ''}
                          onChange={(e) => {
                            const next = [...draft.conditions];
                            const raw = e.target.value;
                            const parsed = raw === '' ? '' : Number(raw);
                            next[i] = {
                              ...next[i],
                              value: raw === '' ? 0 : (Number.isFinite(parsed) ? (parsed as number) : raw),
                            };
                            setDraft({ ...draft, conditions: next });
                          }}
                        />
                      )}
                      {opMeta?.supportsWindow && (
                        <Input
                          className="h-8 w-[80px] text-xs"
                          placeholder="win min"
                          value={c.window_min ?? ''}
                          onChange={(e) => {
                            const next = [...draft.conditions];
                            const parsed = Number(e.target.value);
                            next[i] = {
                              ...next[i],
                              window_min: Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
                            };
                            setDraft({ ...draft, conditions: next });
                          }}
                        />
                      )}
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-destructive"
                        onClick={() => {
                          const next = draft.conditions.filter((_, idx) => idx !== i);
                          if (next.length === 0) next.push({ ...EMPTY_CLAUSE });
                          setDraft({ ...draft, conditions: next });
                        }}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            </div>

            {draftErrors.length > 0 && (
              <div className="text-xs text-destructive flex items-start gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <ul className="space-y-0.5">
                  {draftErrors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              </div>
            )}

            {testResult && (
              <Card className="p-3 text-xs">
                <div className="flex items-center gap-1.5 font-medium">
                  {testResult.matches ? (
                    <><CheckCircle2 className="w-4 h-4 text-green-500" /> Would fire right now.</>
                  ) : (
                    <><XCircle className="w-4 h-4 text-muted-foreground" /> Would NOT fire right now.</>
                  )}
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  Snapshot: {testResult.snapshot_ts ? new Date(testResult.snapshot_ts).toLocaleTimeString() : 'no heartbeat'}
                </div>
                <ul className="mt-2 space-y-0.5 font-mono text-[11px]">
                  {testResult.evaluations.map((e, i) => (
                    <li key={i} className={e.matched ? 'text-green-500' : 'text-muted-foreground'}>
                      {e.matched ? '✓' : '✗'} {e.clause.field} {e.clause.op}{e.clause.value !== undefined ? ` ${e.clause.value}` : ''}{' '}
                      — {e.reason}
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </div>

          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button type="button" variant="outline" onClick={runTest} className="gap-1.5">
              <Play className="w-3.5 h-3.5" /> Test against live state
            </Button>
            <div className="flex-1" />
            <Button type="button" variant="ghost" onClick={() => setEditorOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => saveMutation.mutate(draft)}
              disabled={draftErrors.length > 0 || saveMutation.isPending}
            >
              {saveMutation.isPending ? 'Saving…' : 'Save rule'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
