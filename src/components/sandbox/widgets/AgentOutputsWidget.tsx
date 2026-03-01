/**
 * AgentOutputsWidget — Surfaces recent completed agent task outputs on the dashboard.
 *
 * Queries agent_tasks with completed status + non-null output, then renders
 * the same artifact card components used in the chat view.
 */

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { BrainEntryCard } from '@/components/jac/artifacts/BrainEntryCard';
import { SearchResultsCard } from '@/components/jac/artifacts/SearchResultsCard';
import { CodeSessionCard } from '@/components/jac/artifacts/CodeSessionCard';
import { ResearchBriefCard } from '@/components/jac/artifacts/ResearchBriefCard';
import { ThreadCard } from '@/components/jac/artifacts/ThreadCard';
import type { WidgetProps } from '@/types/widget';
import type { RealtimeChannel } from '@supabase/supabase-js';

interface OutputTask {
  id: string;
  type: string;
  intent: string | null;
  output: Record<string, unknown>;
  completed_at: string;
}

function timeAgo(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'now';
  if (diffMin < 60) return `${diffMin}m`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h`;
  return `${Math.floor(diffH / 24)}d`;
}

function renderCard(task: OutputTask) {
  const output = task.output;

  switch (task.type) {
    case 'save':
      return <BrainEntryCard output={output} />;
    case 'search':
      return <SearchResultsCard output={output} />;
    case 'code':
      return <CodeSessionCard output={output} />;
    case 'research':
    case 'report':
      return <ResearchBriefCard output={output} />;
    default: {
      if (output.content_type === 'thread') {
        return <ThreadCard output={output} />;
      }
      return null;
    }
  }
}

export default function AgentOutputsWidget({ compact }: WidgetProps) {
  const [userId, setUserId] = useState('');
  const [tasks, setTasks] = useState<OutputTask[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) setUserId(session.user.id);
    });
  }, []);

  const fetchOutputs = useCallback(async () => {
    if (!userId) return;

    const { data } = await supabase
      .from('agent_tasks')
      .select('id, type, intent, output, completed_at')
      .eq('user_id', userId)
      .eq('status', 'completed')
      .neq('agent', 'jac-dispatcher')
      .not('output', 'is', null)
      .order('completed_at', { ascending: false })
      .limit(8);

    if (data) {
      setTasks(
        (data as Array<{
          id: string; type: string; intent: string | null;
          output: Record<string, unknown>; completed_at: string;
        }>).map(t => ({
          id: t.id,
          type: t.type,
          intent: t.intent,
          output: t.output,
          completed_at: t.completed_at,
        }))
      );
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    fetchOutputs().finally(() => setLoading(false));
  }, [userId, fetchOutputs]);

  // Realtime subscription for live updates
  useEffect(() => {
    if (!userId) return;

    const channel: RealtimeChannel = supabase
      .channel(`agent-outputs-${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'agent_tasks',
          filter: `user_id=eq.${userId}`,
        },
        () => { fetchOutputs(); }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [userId, fetchOutputs]);

  const visible = tasks.slice(0, compact ? 2 : 8);

  return (
    <div className="flex flex-col h-full bg-white/[0.03] backdrop-blur-sm border border-white/10 rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-white/10 flex items-center justify-between shrink-0">
        <span className="text-xs font-medium text-white/70">Agent Outputs</span>
        {!loading && (
          <span className="text-[10px] text-white/30">{tasks.length} results</span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {loading ? (
          <div className="flex items-center justify-center h-16">
            <span className="text-[10px] text-white/30">Loading...</span>
          </div>
        ) : visible.length === 0 ? (
          <div className="flex items-center justify-center h-16">
            <span className="text-[10px] text-white/30">No agent outputs yet</span>
          </div>
        ) : (
          visible.map(task => {
            const card = renderCard(task);
            if (!card) return null;
            return (
              <div key={task.id}>
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="text-[10px] text-white/40 capitalize">{task.intent || task.type}</span>
                  <span className="text-[10px] text-white/20">
                    {task.completed_at ? timeAgo(task.completed_at) : ''}
                  </span>
                </div>
                {card}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
