/**
 * ResearchResultsWidget — Dedicated widget for research briefs and reports.
 *
 * Two tabs (managed by WidgetChrome):
 *  - Latest: Full markdown-rendered research brief with sources
 *  - History: Scrollable list of past research tasks
 */

import { useState, useEffect, useCallback } from 'react';
import { Globe, ExternalLink, ChevronRight, Clock, BookOpen } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { supabase } from '@/integrations/supabase/client';
import type { WidgetProps } from '@/types/widget';
import type { RealtimeChannel } from '@supabase/supabase-js';

interface Source {
  title?: string;
  url?: string;
}

interface ResearchTask {
  id: string;
  type: string;
  intent: string | null;
  input: Record<string, unknown> | null;
  output: Record<string, unknown>;
  completed_at: string;
  cost_usd: number | null;
}

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function timeAgo(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  return `${Math.floor(diffH / 24)}d ago`;
}

function extractTitle(brief: string, input: Record<string, unknown> | null, intent: string | null): string {
  const firstLine = brief.split('\n').find(l => l.trim());
  if (firstLine) {
    const cleaned = firstLine.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim();
    if (cleaned.length > 3 && cleaned.length < 120) return cleaned;
  }
  if (input?.query) return String(input.query);
  if (input?.originalMessage) {
    const msg = String(input.originalMessage);
    return msg.length > 80 ? msg.slice(0, 77) + '...' : msg;
  }
  return intent || 'Research Brief';
}

function extractBody(brief: string): string {
  const lines = brief.split('\n');
  const firstContentIdx = lines.findIndex(l => l.trim());
  if (firstContentIdx < 0) return brief;
  const firstLine = lines[firstContentIdx].trim();
  if (firstLine.startsWith('#')) {
    return lines.slice(firstContentIdx + 1).join('\n').trim();
  }
  return brief;
}

export default function ResearchResultsWidget({ compact, activeTab, onTabChange, onNavigate, expanded }: WidgetProps) {
  const [userId, setUserId] = useState('');
  const [tasks, setTasks] = useState<ResearchTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const tab = activeTab || 'latest';

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) setUserId(session.user.id);
    });
  }, []);

  const fetchResearch = useCallback(async () => {
    if (!userId) return;

    const { data } = await supabase
      .from('agent_tasks')
      .select('id, type, intent, input, output, completed_at, cost_usd')
      .eq('user_id', userId)
      .eq('status', 'completed')
      .in('type', ['research', 'report'])
      .not('output', 'is', null)
      .order('completed_at', { ascending: false })
      .limit(20);

    if (data) {
      setTasks(
        (data as Array<{
          id: string; type: string; intent: string | null;
          input: Record<string, unknown> | null;
          output: Record<string, unknown>; completed_at: string;
          cost_usd: number | null;
        }>).map(t => ({
          id: t.id,
          type: t.type,
          intent: t.intent,
          input: t.input,
          output: t.output,
          completed_at: t.completed_at,
          cost_usd: t.cost_usd,
        }))
      );
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    fetchResearch().finally(() => setLoading(false));
  }, [userId, fetchResearch]);

  // Realtime subscription
  useEffect(() => {
    if (!userId) return;

    const channel: RealtimeChannel = supabase
      .channel(`research-results-${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'agent_tasks',
          filter: `user_id=eq.${userId}`,
        },
        () => { fetchResearch(); }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [userId, fetchResearch]);

  // Determine which task to show in Latest tab
  const activeTask = selectedTaskId
    ? tasks.find(t => t.id === selectedTaskId) || tasks[0]
    : tasks[0];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="text-[10px] text-white/30">Loading...</span>
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-white/30">
        <Globe className="w-6 h-6" />
        <span className="text-[11px]">No research yet</span>
        <span className="text-[10px] text-white/20">Ask JAC to research something</span>
      </div>
    );
  }

  // --- HISTORY TAB ---
  if (tab === 'history') {
    const limit = compact ? 3 : expanded ? tasks.length : 10;
    const visible = tasks.slice(0, limit);

    return (
      <div className="flex flex-col h-full overflow-y-auto">
        {visible.map(task => {
          const brief = task.output.brief ? String(task.output.brief) : '';
          const sources = Array.isArray(task.output.sources) ? task.output.sources as Source[] : [];
          const title = extractTitle(brief, task.input, task.intent);

          return (
            <button
              key={task.id}
              onClick={() => {
                setSelectedTaskId(task.id);
                onTabChange?.('latest');
              }}
              className="flex items-center gap-2 px-3 py-2.5 text-left hover:bg-white/5 transition-colors border-b border-white/5 last:border-b-0 group"
            >
              <Globe className="w-3.5 h-3.5 text-blue-400/60 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-[11px] text-white/70 line-clamp-1">{title}</p>
                <div className="flex items-center gap-2 mt-0.5">
                  {sources.length > 0 && (
                    <span className="text-[9px] text-blue-400/50">{sources.length} sources</span>
                  )}
                  <span className="text-[9px] text-white/25">{timeAgo(task.completed_at)}</span>
                </div>
              </div>
              <ChevronRight className="w-3 h-3 text-white/20 group-hover:text-white/40 shrink-0" />
            </button>
          );
        })}
      </div>
    );
  }

  // --- LATEST TAB ---
  if (!activeTask) return null;

  const brief = activeTask.output.brief ? String(activeTask.output.brief) : '';
  const sources = Array.isArray(activeTask.output.sources) ? (activeTask.output.sources as Source[]) : [];
  const safeSources = sources.filter(s => s.url && isSafeUrl(s.url));
  const title = extractTitle(brief, activeTask.input, activeTask.intent);
  const body = extractBody(brief);
  const brainEntryId = activeTask.output.brainEntryId ? String(activeTask.output.brainEntryId) : null;
  const durationMs = typeof activeTask.output.durationMs === 'number' ? activeTask.output.durationMs : null;

  const displayBody = compact && !expanded && body.length > 300
    ? body.slice(0, 300) + '...'
    : body;

  return (
    <div className="flex flex-col h-full overflow-y-auto px-3 py-2 gap-2">
      {/* Title */}
      <h3 className="text-xs font-semibold text-white/80 leading-snug">{title}</h3>

      {/* Meta row */}
      <div className="flex items-center gap-2 flex-wrap">
        {safeSources.length > 0 && (
          <span className="inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-400/70">
            <Globe className="w-2.5 h-2.5" />
            {safeSources.length} source{safeSources.length !== 1 ? 's' : ''}
          </span>
        )}
        {durationMs !== null && (
          <span className="inline-flex items-center gap-1 text-[9px] text-white/30">
            <Clock className="w-2.5 h-2.5" />
            {(durationMs / 1000).toFixed(1)}s
          </span>
        )}
        <span className="text-[9px] text-white/20">{timeAgo(activeTask.completed_at)}</span>
      </div>

      {/* Markdown body */}
      <div className="prose prose-sm dark:prose-invert max-w-none
        prose-headings:text-white/80 prose-headings:text-xs prose-headings:font-semibold prose-headings:mt-3 prose-headings:mb-1
        prose-p:text-[11px] prose-p:text-white/60 prose-p:leading-relaxed prose-p:my-1
        prose-li:text-[11px] prose-li:text-white/60
        prose-ul:my-1 prose-ol:my-1
        prose-strong:text-white/80
        prose-a:text-cyan-400 prose-a:no-underline hover:prose-a:underline
        prose-hr:border-white/10 prose-hr:my-2">
        <ReactMarkdown>{displayBody}</ReactMarkdown>
      </div>

      {/* Sources — hidden in compact unless expanded */}
      {(!compact || expanded) && safeSources.length > 0 && (
        <div className="pt-2 border-t border-white/5 space-y-1">
          <span className="text-[9px] text-white/30 uppercase tracking-wider">Sources</span>
          {safeSources.slice(0, expanded ? 10 : 5).map((s, i) => (
            <a
              key={i}
              href={s.url!}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-[10px] text-cyan-400/70 hover:text-cyan-400 hover:underline truncate"
            >
              <ExternalLink className="w-2.5 h-2.5 shrink-0" />
              {s.title || s.url}
            </a>
          ))}
        </div>
      )}

      {/* View in Brain link */}
      {brainEntryId && (
        <button
          onClick={() => onNavigate(`/brain?entryId=${brainEntryId}`)}
          className="flex items-center gap-1.5 text-[10px] text-purple-400/70 hover:text-purple-400 mt-1"
        >
          <BookOpen className="w-3 h-3" />
          View in Brain
        </button>
      )}
    </div>
  );
}
