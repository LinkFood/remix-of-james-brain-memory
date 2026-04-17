/**
 * McpCallsPanel — live log of every MCP tool call Claude makes (UW data on
 * demand). Shows tool name, params, result preview. Expandable for the full
 * result JSON so you can audit exactly what Claude pulled and what came back.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ChevronDown, ChevronUp, Database, AlertCircle } from 'lucide-react';

interface McpCall {
  id: string;
  source: string;
  server_name: string | null;
  tool_name: string | null;
  tool_use_id: string | null;
  input: unknown;
  result: unknown;
  is_error: boolean;
  duration_ms: number | null;
  created_at: string;
}

function relTime(iso: string): string {
  const d = Date.now() - Date.parse(iso);
  const s = Math.floor(d / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

function previewJson(v: unknown, n = 140): string {
  if (v == null) return '(null)';
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > n ? s.slice(0, n) + '…' : s;
  } catch {
    return String(v).slice(0, n);
  }
}

function McpCallRow({ call }: { call: McpCall }) {
  const [expanded, setExpanded] = useState(false);
  const isUw = (call.server_name ?? '').toLowerCase().includes('unusual-whales');
  return (
    <div className={`p-2.5 border-l-2 ${call.is_error ? 'border-l-red-500' : isUw ? 'border-l-primary' : 'border-l-border'} hover:bg-muted/20 transition-colors`}>
      <div className="flex items-center gap-2 text-[10px] flex-wrap">
        {call.is_error && <AlertCircle className="w-3 h-3 text-red-500" />}
        <Database className="w-3 h-3 text-muted-foreground" />
        <span className="font-mono font-semibold text-foreground">{call.tool_name ?? 'unknown'}</span>
        <Badge variant="outline" className="text-[9px] px-1 py-0 font-mono">
          {call.source}
        </Badge>
        {call.server_name && (
          <span className="text-muted-foreground text-[9px]">{call.server_name}</span>
        )}
        <span className="text-muted-foreground ml-auto">{relTime(call.created_at)}</span>
      </div>
      <div className="mt-1 text-[10.5px] text-foreground/80 font-mono truncate">
        <span className="text-muted-foreground">in:</span> {previewJson(call.input)}
      </div>
      <div className="mt-0.5 text-[10.5px] text-foreground/60 font-mono truncate">
        <span className="text-muted-foreground">out:</span> {previewJson(call.result)}
      </div>
      {(call.input || call.result) && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-[9px] text-muted-foreground hover:text-foreground flex items-center gap-0.5 mt-1"
        >
          {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          {expanded ? 'hide full' : 'show full'}
        </button>
      )}
      {expanded && (
        <div className="mt-1 space-y-1">
          {call.input != null && (
            <pre className="text-[9.5px] bg-muted/30 p-2 rounded text-foreground/80 overflow-x-auto whitespace-pre-wrap break-all">
              <span className="text-muted-foreground">input:</span>
              {'\n'}
              {JSON.stringify(call.input, null, 2)}
            </pre>
          )}
          {call.result != null && (
            <pre className="text-[9.5px] bg-muted/30 p-2 rounded text-foreground/80 overflow-x-auto whitespace-pre-wrap break-all">
              <span className="text-muted-foreground">result:</span>
              {'\n'}
              {JSON.stringify(call.result, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export function McpCallsPanel() {
  const qc = useQueryClient();

  // Realtime subscription on INSERT — surfaces new calls the moment they land.
  useEffect(() => {
    const chan = supabase
      .channel('ct_mcp_calls_stream')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ct_mcp_calls' }, () => {
        qc.invalidateQueries({ queryKey: ['ct_mcp_calls'] });
      })
      .subscribe();
    return () => { supabase.removeChannel(chan); };
  }, [qc]);

  const { data: calls, isLoading } = useQuery<McpCall[]>({
    queryKey: ['ct_mcp_calls'],
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ct_mcp_calls')
        .select('id, source, server_name, tool_name, tool_use_id, input, result, is_error, duration_ms, created_at')
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as McpCall[];
    },
  });

  const toolCounts = new Map<string, number>();
  for (const c of calls ?? []) {
    const key = c.tool_name ?? 'unknown';
    toolCounts.set(key, (toolCounts.get(key) ?? 0) + 1);
  }
  const topTools = Array.from(toolCounts.entries()).sort(([, a], [, b]) => b - a).slice(0, 3);

  return (
    <Card className="divide-y divide-border">
      <div className="px-3 py-2 border-b border-border bg-muted/30 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Database className="w-3 h-3 text-primary" />
          <span className="text-xs font-semibold uppercase tracking-wide text-foreground">MCP Calls</span>
          <span className="text-[10px] text-muted-foreground">Claude ↔ UW live</span>
        </div>
        {calls && calls.length > 0 && (
          <span className="text-[10px] text-muted-foreground">
            {calls.length}
            {topTools.length > 0 && (
              <span className="ml-2">
                · {topTools.map(([t, n]) => `${t}×${n}`).join(', ')}
              </span>
            )}
          </span>
        )}
      </div>
      {isLoading ? (
        <div className="p-4 text-center text-xs text-muted-foreground">loading…</div>
      ) : !calls || calls.length === 0 ? (
        <div className="p-4 text-center text-xs text-muted-foreground">
          No MCP calls yet. Ask Claude something in chat that requires live UW data (e.g. "pull NVDA options chain") and it'll show up here.
        </div>
      ) : (
        <div className="max-h-[60vh] overflow-y-auto divide-y divide-border">
          {calls.map(c => <McpCallRow key={c.id} call={c} />)}
        </div>
      )}
    </Card>
  );
}
