/**
 * useHealthData — batches all /health page queries in parallel.
 *
 * Refresh: 60s. Read-only. No mutations.
 *
 * Sources:
 *   - get_cron_status RPC           → ct_* crons (filtered client-side)
 *   - ct_uw_usage_latest view       → today's UW count / limit / pct
 *   - ct_uw_usage table             → last 7 days mini-line
 *   - ct_chat_tokens_today view     → today's chat cost + 7-day rolling
 *   - ct_attention_stream table     → last 24h attention_score histogram
 *   - ct_mcp_calls table            → last 20 calls
 *   - ct_book / ct_trades tables    → today's session + open positions
 *
 * Notes on cost attribution:
 *   v1 only tracks ct_chat_tokens cost. Watcher / curiosity / recap / brief
 *   don't persist per-call cost yet — surfaced as "not yet tracked" in UI.
 */

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HealthCronRow {
  jobid: number;
  jobname: string;
  schedule: string;
  command: string;
  active: boolean;
  last_run_status: string | null;
  last_run_at: string | null;
  last_run_duration: string | null;
}

export interface UwUsageLatest {
  session_date: string;
  observed_at: string;
  daily_count: number;
  daily_limit: number;
  pct: number;
}

export interface UwUsageDaily {
  session_date: string;
  daily_count: number;
  daily_limit: number | null;
}

export interface ChatTokensDaily {
  session_date: string;
  turns: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  mcp_calls: number;
  avg_ms: number;
}

export interface AttentionBucket {
  bucket: string;   // e.g. "0-10", "10-20"
  floor: number;    // numeric floor for sorting
  count: number;
}

export interface McpCallRow {
  id: string;
  source: string;
  server_name: string | null;
  tool_name: string | null;
  is_error: boolean;
  created_at: string;
}

export interface BookSnapshot {
  starting_balance: number | null;
  current_equity: number | null;
  realized_pnl_today: number | null;
  open_positions: number;
  session_date: string | null;
}

export interface HealthData {
  crons: HealthCronRow[];
  uwLatest: UwUsageLatest | null;
  uwDaily: UwUsageDaily[];
  chatToday: ChatTokensDaily | null;
  chatDaily: ChatTokensDaily[];
  attentionBuckets: AttentionBucket[];
  attentionTotal: number;
  mcpCalls: McpCallRow[];
  book: BookSnapshot;
}

// ---------------------------------------------------------------------------
// Fetchers (each isolated so a single failure doesn't nuke the whole page)
// ---------------------------------------------------------------------------

async function fetchCtCrons(): Promise<HealthCronRow[]> {
  const { data, error } = await supabase.rpc('get_cron_status');
  if (error) {
    console.warn('[useHealthData] get_cron_status failed:', error.message);
    return [];
  }
  const rows = (data as HealthCronRow[]) || [];
  return rows
    .filter((r) => (r.jobname ?? '').toLowerCase().startsWith('ct-') || (r.jobname ?? '').toLowerCase().startsWith('ct_'))
    .sort((a, b) => {
      const ta = a.last_run_at ? Date.parse(a.last_run_at) : 0;
      const tb = b.last_run_at ? Date.parse(b.last_run_at) : 0;
      return tb - ta;
    });
}

async function fetchUwLatest(): Promise<UwUsageLatest | null> {
  const { data, error } = await supabase
    .from('ct_uw_usage_latest')
    .select('*')
    .order('session_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn('[useHealthData] ct_uw_usage_latest failed:', error.message);
    return null;
  }
  return (data as UwUsageLatest | null) ?? null;
}

async function fetchUwDaily(): Promise<UwUsageDaily[]> {
  // Pull last 7 days of raw usage, take the max daily_count per session_date
  // (count only goes up during a day, so max = end-of-day value).
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('ct_uw_usage')
    .select('session_date, daily_count, daily_limit')
    .gte('session_date', since)
    .order('session_date', { ascending: true })
    .order('observed_at', { ascending: false });
  if (error) {
    console.warn('[useHealthData] ct_uw_usage failed:', error.message);
    return [];
  }
  const byDay = new Map<string, UwUsageDaily>();
  for (const r of (data ?? []) as UwUsageDaily[]) {
    const prev = byDay.get(r.session_date);
    if (!prev || (r.daily_count ?? 0) > (prev.daily_count ?? 0)) {
      byDay.set(r.session_date, r);
    }
  }
  return Array.from(byDay.values()).sort((a, b) => a.session_date.localeCompare(b.session_date));
}

async function fetchChatDaily(): Promise<ChatTokensDaily[]> {
  // ct_chat_tokens_today is a view grouped by session_date. Limit 14 so we
  // get at least 7 days even with gaps.
  const { data, error } = await supabase
    .from('ct_chat_tokens_today')
    .select('*')
    .order('session_date', { ascending: false })
    .limit(14);
  if (error) {
    console.warn('[useHealthData] ct_chat_tokens_today failed:', error.message);
    return [];
  }
  // Re-sort ascending for chart rendering.
  return ((data ?? []) as ChatTokensDaily[]).slice().sort((a, b) =>
    a.session_date.localeCompare(b.session_date),
  );
}

async function fetchAttentionHistogram(): Promise<{ buckets: AttentionBucket[]; total: number }> {
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const { data, error } = await supabase
    .from('ct_attention_stream')
    .select('attention_score')
    .gte('created_at', since)
    .not('attention_score', 'is', null)
    .limit(5000);
  if (error) {
    console.warn('[useHealthData] ct_attention_stream failed:', error.message);
    return { buckets: emptyAttentionBuckets(), total: 0 };
  }
  const buckets = emptyAttentionBuckets();
  const rows = (data ?? []) as Array<{ attention_score: number | null }>;
  for (const r of rows) {
    if (r.attention_score == null) continue;
    const idx = Math.min(9, Math.max(0, Math.floor(r.attention_score / 10)));
    buckets[idx].count += 1;
  }
  return { buckets, total: rows.length };
}

function emptyAttentionBuckets(): AttentionBucket[] {
  const out: AttentionBucket[] = [];
  for (let i = 0; i < 10; i++) {
    const lo = i * 10;
    const hi = i === 9 ? 100 : lo + 10;
    out.push({ bucket: `${lo}-${hi}`, floor: lo, count: 0 });
  }
  return out;
}

async function fetchMcpCalls(): Promise<McpCallRow[]> {
  const { data, error } = await supabase
    .from('ct_mcp_calls')
    .select('id, source, server_name, tool_name, is_error, created_at')
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) {
    console.warn('[useHealthData] ct_mcp_calls failed:', error.message);
    return [];
  }
  return (data ?? []) as McpCallRow[];
}

async function fetchBookSnapshot(): Promise<BookSnapshot> {
  const today = new Date().toISOString().slice(0, 10);

  const [bookRes, tradesRes] = await Promise.all([
    supabase
      .from('ct_book')
      .select('session_date, starting_balance, ending_balance, realized_pnl, unrealized_pnl')
      .eq('session_date', today)
      .maybeSingle(),
    supabase
      .from('ct_trades')
      .select('status')
      .eq('session_date', today),
  ]);

  const book = bookRes.data as
    | {
        session_date: string;
        starting_balance: number;
        ending_balance: number | null;
        realized_pnl: number | null;
        unrealized_pnl: number | null;
      }
    | null;

  const trades = (tradesRes.data ?? []) as Array<{ status: string }>;
  const openPositions = trades.filter((t) => t.status === 'open' || t.status === 'planned').length;

  if (!book) {
    return {
      starting_balance: null,
      current_equity: null,
      realized_pnl_today: null,
      open_positions: openPositions,
      session_date: null,
    };
  }

  const currentEquity =
    book.ending_balance ??
    book.starting_balance + (book.realized_pnl ?? 0) + (book.unrealized_pnl ?? 0);

  return {
    starting_balance: book.starting_balance,
    current_equity: currentEquity,
    realized_pnl_today: book.realized_pnl ?? 0,
    open_positions: openPositions,
    session_date: book.session_date,
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useHealthData() {
  return useQuery<HealthData>({
    queryKey: ['health-data'],
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const [
        crons,
        uwLatest,
        uwDaily,
        chatDaily,
        attention,
        mcpCalls,
        book,
      ] = await Promise.all([
        fetchCtCrons(),
        fetchUwLatest(),
        fetchUwDaily(),
        fetchChatDaily(),
        fetchAttentionHistogram(),
        fetchMcpCalls(),
        fetchBookSnapshot(),
      ]);

      const today = new Date().toISOString().slice(0, 10);
      const chatToday = chatDaily.find((d) => d.session_date === today) ?? null;

      return {
        crons,
        uwLatest,
        uwDaily,
        chatToday,
        chatDaily,
        attentionBuckets: attention.buckets,
        attentionTotal: attention.total,
        mcpCalls,
        book,
      };
    },
  });
}
