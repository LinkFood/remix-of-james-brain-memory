/**
 * TradeAuditPanel — forensic audit trail for a single trade.
 *
 * Given a trade_id, renders every ct_trade_audit row as a timeline. Each row
 * expands to show:
 *   - source badge + timestamp
 *   - active biases count, MCP calls count, market regime
 *   - position-sizing inputs (book equity, size_pct, size_usd, prices)
 *   - "View raw UW state"      accordion → condensed snapshot JSON
 *   - "View raw Claude response" accordion → full text (truncated to 20KB at write time)
 *   - "View MCP calls"         accordion → per-tool input/output preview
 *   - "View active biases"     accordion → full bias list at commit time
 *
 * Multiple audit rows per trade are expected (open + modify + close). They're
 * rendered newest-first so James sees the latest decision at the top.
 *
 * No syntax highlighter dep — we render with a lightweight styled <pre>. If
 * we ever add one (prism, shiki) the JSON blocks here are the hook-in point.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { ChevronDown, ChevronUp, Shield, AlertCircle } from 'lucide-react';

interface McpCallPreview {
  tool?: string | null;
  input_preview?: string | null;
  output_preview?: string | null;
  ts?: string | null;
  is_error?: boolean;
}

interface BiasRow {
  id?: string;
  pattern?: string | null;
  instruments?: string[] | null;
  severity?: number | null;
}

interface TradeAuditRow {
  id: string;
  trade_id: string;
  created_at: string;
  source: string;
  uw_state_snapshot: unknown;
  mcp_calls: McpCallPreview[] | null;
  active_biases: BiasRow[] | null;
  sizing_computed: Record<string, unknown> | null;
  market_regime: string | null;
  heartbeat_id: string | null;
  triggering_alert_id: string | null;
  triggering_flag_id: string | null;
  prompt_version: string | null;
  raw_claude_response: string | null;
}

function relTime(iso: string): string {
  const d = Date.now() - Date.parse(iso);
  const s = Math.floor(d / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

function prettyJson(v: unknown): string {
  if (v == null) return '(none)';
  if (typeof v === 'string') {
    // If the string is valid JSON, pretty-print it. Otherwise return as-is.
    try {
      const parsed = JSON.parse(v);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return v;
    }
  }
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return '[unserializable]';
  }
}

function sourceBadgeClass(source: string): string {
  switch (source) {
    case 'claude-trade-open':
      return 'bg-sky-500/20 text-sky-300';
    case 'alert-book-commit':
      return 'bg-amber-500/20 text-amber-300';
    case 'chat':
      return 'bg-violet-500/20 text-violet-300';
    case 'manual':
      return 'bg-emerald-500/20 text-emerald-300';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

function useTradeAudit(tradeId: string) {
  return useQuery<TradeAuditRow[]>({
    queryKey: ['ct_trade_audit', tradeId],
    enabled: !!tradeId,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ct_trade_audit')
        .select('*')
        .eq('trade_id', tradeId)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as TradeAuditRow[];
    },
  });
}

function JsonBlock({ children }: { children: string }) {
  return (
    <pre className="max-h-80 overflow-auto rounded bg-background/60 border border-border p-2 text-[10px] font-mono leading-tight text-foreground/85 whitespace-pre-wrap break-all">
      {children}
    </pre>
  );
}

function AuditEvent({ row }: { row: TradeAuditRow }) {
  const [expanded, setExpanded] = useState(false);
  const biasCount = Array.isArray(row.active_biases) ? row.active_biases.length : 0;
  const mcpCount = Array.isArray(row.mcp_calls) ? row.mcp_calls.length : 0;
  const truncated = !!row.raw_claude_response && row.raw_claude_response.includes('[truncated');

  return (
    <div className="border border-border rounded">
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/10"
      >
        <Badge className={`text-[9px] px-1.5 py-0 ${sourceBadgeClass(row.source)}`}>
          {row.source}
        </Badge>
        <span className="text-[10px] text-muted-foreground">{relTime(row.created_at)}</span>
        <span className="text-[10px] text-muted-foreground">·</span>
        <span className="text-[10px]" title="active biases at commit">
          biases {biasCount}
        </span>
        <span className="text-[10px] text-muted-foreground">·</span>
        <span className="text-[10px]" title="MCP tool calls associated with decision">
          mcp {mcpCount}
        </span>
        {row.market_regime && (
          <>
            <span className="text-[10px] text-muted-foreground">·</span>
            <span className="text-[10px]" title="market regime at decision">
              {row.market_regime}
            </span>
          </>
        )}
        {row.prompt_version && (
          <Badge variant="outline" className="text-[9px] px-1 py-0 ml-1">
            {row.prompt_version}
          </Badge>
        )}
        {truncated && (
          <Badge className="text-[9px] px-1 py-0 bg-yellow-500/20 text-yellow-300" title="raw_claude_response was over 20KB and got truncated">
            <AlertCircle className="w-2.5 h-2.5 mr-0.5" />
            truncated
          </Badge>
        )}
        <span className="ml-auto">
          {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 pt-1 space-y-2 border-t border-border bg-muted/5">
          {/* Sizing + links — fast-read summary, no accordion */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] font-mono">
            {row.sizing_computed && Object.entries(row.sizing_computed).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2">
                <span className="text-muted-foreground">{k}</span>
                <span className="text-foreground/90 truncate" title={String(v)}>
                  {v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v)}
                </span>
              </div>
            ))}
            {row.heartbeat_id && (
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">heartbeat_id</span>
                <span className="text-foreground/90 truncate" title={row.heartbeat_id}>
                  {row.heartbeat_id.slice(0, 8)}…
                </span>
              </div>
            )}
            {row.triggering_alert_id && (
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">alert_id</span>
                <span className="text-foreground/90 truncate" title={row.triggering_alert_id}>
                  {row.triggering_alert_id.slice(0, 8)}…
                </span>
              </div>
            )}
            {row.triggering_flag_id && (
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">flag_id</span>
                <span className="text-foreground/90 truncate" title={row.triggering_flag_id}>
                  {row.triggering_flag_id.slice(0, 8)}…
                </span>
              </div>
            )}
          </div>

          <Accordion type="multiple" className="w-full">
            <AccordionItem value="uw">
              <AccordionTrigger className="text-[10px] py-1.5">
                View raw UW state
              </AccordionTrigger>
              <AccordionContent>
                <JsonBlock>{prettyJson(row.uw_state_snapshot)}</JsonBlock>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="raw">
              <AccordionTrigger className="text-[10px] py-1.5">
                View raw Claude response
              </AccordionTrigger>
              <AccordionContent>
                <JsonBlock>{row.raw_claude_response ?? '(none)'}</JsonBlock>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="mcp">
              <AccordionTrigger className="text-[10px] py-1.5">
                MCP calls ({mcpCount})
              </AccordionTrigger>
              <AccordionContent>
                {mcpCount === 0 ? (
                  <p className="text-[10px] text-muted-foreground italic px-1">No MCP calls recorded for this event.</p>
                ) : (
                  <div className="space-y-2">
                    {(row.mcp_calls ?? []).map((c, idx) => (
                      <div key={idx} className="border border-border rounded p-2 bg-background/40">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[10px] font-semibold">{c.tool ?? '(unknown)'}</span>
                          {c.is_error && <Badge className="text-[9px] px-1 py-0 bg-red-500/20 text-red-300">error</Badge>}
                          {c.ts && <span className="text-[9px] text-muted-foreground">{relTime(c.ts)}</span>}
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                          <div>
                            <div className="text-[9px] uppercase text-muted-foreground mb-0.5">input</div>
                            <JsonBlock>{prettyJson(c.input_preview)}</JsonBlock>
                          </div>
                          <div>
                            <div className="text-[9px] uppercase text-muted-foreground mb-0.5">output</div>
                            <JsonBlock>{prettyJson(c.output_preview)}</JsonBlock>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="biases">
              <AccordionTrigger className="text-[10px] py-1.5">
                Active biases ({biasCount})
              </AccordionTrigger>
              <AccordionContent>
                {biasCount === 0 ? (
                  <p className="text-[10px] text-muted-foreground italic px-1">No active biases at commit time.</p>
                ) : (
                  <ul className="space-y-1">
                    {(row.active_biases ?? []).map((b, idx) => (
                      <li key={b.id ?? idx} className="flex items-start gap-2 text-[10px] font-mono border-b border-border/50 pb-1 last:border-b-0 last:pb-0">
                        <Badge variant="outline" className="text-[9px] px-1 py-0 shrink-0">
                          sev {b.severity ?? '—'}
                        </Badge>
                        <div className="min-w-0">
                          <div className="text-foreground/90 break-words">{b.pattern ?? '(no pattern)'}</div>
                          {b.instruments && b.instruments.length > 0 && (
                            <div className="text-[9px] text-muted-foreground">
                              {b.instruments.join(', ')}
                            </div>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      )}
    </div>
  );
}

export function TradeAuditPanel({ tradeId }: { tradeId: string }) {
  const { data, isLoading, error } = useTradeAudit(tradeId);
  const rows = data ?? [];

  return (
    <Card className="overflow-hidden">
      <div className="px-3 py-2 border-b border-border bg-muted/20 flex items-center gap-2">
        <Shield className="w-3.5 h-3.5 text-primary" />
        <h4 className="text-[10px] font-semibold uppercase tracking-wide text-foreground">
          Forensic audit trail
        </h4>
        <span className="text-[9px] text-muted-foreground">{rows.length} events</span>
      </div>
      <div className="p-3">
        {isLoading ? (
          <p className="text-[10px] text-muted-foreground italic">loading audit rows…</p>
        ) : error ? (
          <p className="text-[10px] text-red-400">audit query failed: {error instanceof Error ? error.message : String(error)}</p>
        ) : rows.length === 0 ? (
          <p className="text-[10px] text-muted-foreground italic">
            No audit rows for this trade. Pre-audit trades (committed before the forensic trail shipped) won't have this data.
          </p>
        ) : (
          <div className="space-y-2">
            {rows.map(r => <AuditEvent key={r.id} row={r} />)}
          </div>
        )}
      </div>
    </Card>
  );
}

export default TradeAuditPanel;
