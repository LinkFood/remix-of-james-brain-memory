/**
 * PreTradeChecklist — renders the 7-check compliance gate for a draft trade.
 *
 * Usage:
 *   <PreTradeChecklist trade={{ instrument: 'SPY', side: 'long', size_pct: 15 }} />
 *
 * Behavior:
 *   - Debounces the draft (250ms) then calls ct-pre-trade-check.
 *   - Renders 7 stable rows in the same order the backend gate emits them,
 *     with pass/warn/block status icons and the detail string.
 *   - "Override" button shows ONLY if zero block-level checks are present.
 *     Block-level checks (kill switch, drawdown urgent, concentration,
 *     high-sev bias, cooldown) are hard — no UI override.
 *   - Surfaces the ct_config threshold_key each blocker cites so James can
 *     jump to /ct-settings and tune.
 *
 * Two surfaces from one body:
 *   - <PreTradeChecklist /> — card form, drop-in on /book or in a modal.
 *   - <PreTradeChecklistFloat /> — wrapped in a fixed floating card anchor.
 */
import { useEffect, useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Loader2,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';

// Stable order — must match preTradeGate.ts
const CHECK_ORDER = [
  'kill_switch',
  'drawdown_tier',
  'concentration',
  'bias_alignment',
  'uw_usage',
  'cooldown',
  'session_context',
] as const;

const CHECK_LABELS: Record<typeof CHECK_ORDER[number], string> = {
  kill_switch:     'Kill switch',
  drawdown_tier:   'Drawdown tier',
  concentration:   'Concentration',
  bias_alignment:  'Bias alignment',
  uw_usage:        'UW usage',
  cooldown:        'Cooldown (alert)',
  session_context: 'Session context',
};

// These checks are block-capable — the UI surfaces that inline so operators
// know "this one is a hard wall if it flips."
const BLOCK_CAPABLE: Record<typeof CHECK_ORDER[number], boolean> = {
  kill_switch:     true,
  drawdown_tier:   true,
  concentration:   true,
  bias_alignment:  true,
  uw_usage:        false,
  cooldown:        true,
  session_context: false,
};

type CheckStatus = 'pass' | 'warn' | 'block';

interface Check {
  name: typeof CHECK_ORDER[number] | string;
  status: CheckStatus;
  detail: string;
  threshold_key?: string;
}

interface GateResult {
  passed: boolean;
  checks: Check[];
  blockers: Check[];
}

export interface PreTradeChecklistTrade {
  instrument?: string | null;
  side?: 'long' | 'short' | null;
  size_pct?: number | null;
  size_usd?: number | null;
  contract_type?: 'underlying' | 'call' | 'put' | null;
  thesis_theme?: string | null;
  source?: 'chat' | 'alert' | 'claude-trade-open' | 'manual' | null;
}

export interface PreTradeChecklistProps {
  /** Draft trade. Optional — missing fields render as pass-with-skip. */
  trade?: PreTradeChecklistTrade;
  /**
   * Called when the user clicks Override (only fires when no block-level
   * checks are present). Parent can use this to re-issue a commit with
   * the --force flag. If unset, button is hidden.
   */
  onOverride?: (checks: Check[]) => void;
  /** Render without an outer Card shell — for modal bodies. */
  compact?: boolean;
}

export function PreTradeChecklist({ trade, onOverride, compact }: PreTradeChecklistProps) {
  const [result, setResult] = useState<GateResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Debounce the draft so we don't spam the edge function on every keystroke.
  const key = JSON.stringify({
    i: trade?.instrument ?? null,
    s: trade?.side ?? null,
    p: trade?.size_pct ?? null,
    u: trade?.size_usd ?? null,
    c: trade?.contract_type ?? 'underlying',
    t: trade?.thesis_theme ?? null,
    src: trade?.source ?? 'chat',
  });

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const { data, error: err } = await supabase.functions.invoke('ct-pre-trade-check', {
          body: { trade: JSON.parse(key) },
        });
        if (cancelled) return;
        if (err) {
          setError(err.message ?? 'gate read failed');
          setResult(null);
          return;
        }
        setResult(data as GateResult);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [key]);

  // Index by name so we render in the canonical order even if the backend
  // ever reorders. Missing checks render as "—" rows so the card height
  // stays constant.
  const byName = useMemo(() => {
    const map: Record<string, Check> = {};
    for (const c of result?.checks ?? []) map[c.name] = c;
    return map;
  }, [result]);

  const hasBlocker = (result?.blockers?.length ?? 0) > 0;
  const hasWarn = (result?.checks ?? []).some(c => c.status === 'warn');

  const body = (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          {hasBlocker ? (
            <ShieldAlert className="h-4 w-4 text-red-600" />
          ) : (
            <ShieldCheck className="h-4 w-4 text-emerald-600" />
          )}
          <span>Pre-trade gate</span>
          {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        </div>
        <div className="text-xs text-muted-foreground">
          {result
            ? hasBlocker
              ? `${result.blockers.length} blocker${result.blockers.length === 1 ? '' : 's'}`
              : hasWarn
                ? `${result.checks.filter(c => c.status === 'warn').length} warn`
                : 'all clear'
            : '—'}
        </div>
      </div>

      <ul className="divide-y divide-border/60 rounded-md border border-border/60">
        {CHECK_ORDER.map((name) => {
          const check = byName[name];
          return <ChecklistRow key={name} name={name} check={check} />;
        })}
      </ul>

      {error && (
        <div className="text-xs text-amber-600">gate read error: {error}</div>
      )}

      {/*
        Override button — appears ONLY if we have a result AND there are no
        block-level checks. Warns can be overridden via --force on the backend;
        block-level checks (kill switch, drawdown urgent, concentration,
        cooldown, high-sev bias) are hard and cannot be bypassed from here.
      */}
      {onOverride && result && !hasBlocker && hasWarn && (
        <div className="flex items-center justify-end pt-1">
          <Button
            size="sm"
            variant="outline"
            onClick={() => onOverride(result.checks)}
            className="text-xs"
          >
            Override warnings (--force)
          </Button>
        </div>
      )}
      {onOverride && result && hasBlocker && (
        <div className="text-xs text-muted-foreground pt-1">
          Block-level checks cannot be overridden. Tune thresholds in /ct-settings.
        </div>
      )}
    </div>
  );

  if (compact) return body;

  return (
    <Card className="p-3">
      {body}
    </Card>
  );
}

function ChecklistRow({
  name,
  check,
}: {
  name: typeof CHECK_ORDER[number];
  check?: Check;
}) {
  const status: CheckStatus | 'unknown' = check?.status ?? 'unknown';
  const Icon = status === 'pass' ? CheckCircle2
             : status === 'warn' ? AlertTriangle
             : status === 'block' ? XCircle
             : Loader2;
  const iconClass = status === 'pass'  ? 'text-emerald-600'
                  : status === 'warn'  ? 'text-amber-600'
                  : status === 'block' ? 'text-red-600'
                  : 'text-muted-foreground animate-spin';

  return (
    <li className="flex items-start gap-2 px-2 py-1.5 text-xs">
      <Icon className={`h-3.5 w-3.5 mt-0.5 shrink-0 ${iconClass}`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium">
            {CHECK_LABELS[name]}
            {BLOCK_CAPABLE[name] && (
              <span className="ml-1 text-[10px] font-normal text-muted-foreground">· block-capable</span>
            )}
          </span>
          {check?.threshold_key && (
            <code className="text-[10px] text-muted-foreground font-mono shrink-0">
              {check.threshold_key}
            </code>
          )}
        </div>
        <div className="text-muted-foreground truncate" title={check?.detail ?? ''}>
          {check?.detail ?? 'pending…'}
        </div>
      </div>
    </li>
  );
}

/**
 * Floating variant — fixed-position card for /book. Sits in a corner so the
 * operator sees the gate state as they tweak the draft.
 */
export function PreTradeChecklistFloat(props: PreTradeChecklistProps) {
  return (
    <div className="fixed bottom-4 right-4 w-80 z-40 shadow-lg">
      <PreTradeChecklist {...props} />
    </div>
  );
}
