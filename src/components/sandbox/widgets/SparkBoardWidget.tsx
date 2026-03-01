/**
 * SparkBoardWidget — Ideas ranked by potential, hot to cold.
 *
 * Two tabs (managed by WidgetChrome):
 *  - Hot (default): Ideas sorted by heat score descending
 *  - Cold: Ideas sorted by heat score ascending (graveyard)
 *
 * Heat = importance_score * recencyWeight
 * recencyWeight: 1.0 (<3d), 0.8 (<7d), 0.6 (<14d), 0.4 (<30d), 0.2 (older)
 */

import { useState, useEffect, useCallback } from 'react';
import { Lightbulb, Star } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import type { WidgetProps } from '@/types/widget';
import type { RealtimeChannel } from '@supabase/supabase-js';

interface IdeaEntry {
  id: string;
  title: string;
  content: string | null;
  tags: string[] | null;
  importance_score: number | null;
  access_count: number | null;
  starred: boolean | null;
  created_at: string;
}

interface ScoredIdea extends IdeaEntry {
  heat: number;
}

function timeAgo(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 7) return `${diffD}d ago`;
  const diffW = Math.floor(diffD / 7);
  if (diffW < 5) return `${diffW}w ago`;
  return `${Math.floor(diffD / 30)}mo ago`;
}

function recencyWeight(createdAt: string): number {
  const diffMs = Date.now() - new Date(createdAt).getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  if (diffDays < 3) return 1.0;
  if (diffDays < 7) return 0.8;
  if (diffDays < 14) return 0.6;
  if (diffDays < 30) return 0.4;
  return 0.2;
}

function computeHeat(idea: IdeaEntry): number {
  const importance = idea.importance_score ?? 5;
  return importance * recencyWeight(idea.created_at);
}

function heatColor(heat: number): { bg: string; text: string; bar: string } {
  if (heat >= 7) return { bg: 'bg-red-500/10', text: 'text-red-400', bar: 'bg-red-500' };
  if (heat >= 4) return { bg: 'bg-amber-500/10', text: 'text-amber-400', bar: 'bg-amber-500' };
  return { bg: 'bg-blue-500/10', text: 'text-blue-400', bar: 'bg-blue-500' };
}

export default function SparkBoardWidget({ compact, activeTab, expanded, onNavigate }: WidgetProps) {
  const [userId, setUserId] = useState('');
  const [ideas, setIdeas] = useState<ScoredIdea[]>([]);
  const [loading, setLoading] = useState(true);

  const tab = activeTab || 'hot';

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) setUserId(session.user.id);
    });
  }, []);

  const fetchIdeas = useCallback(async () => {
    if (!userId) return;

    const { data } = await supabase
      .from('entries')
      .select('id, title, content, tags, importance_score, access_count, starred, created_at')
      .eq('user_id', userId)
      .eq('content_type', 'idea')
      .or('archived.is.null,archived.eq.false')
      .order('importance_score', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(20);

    if (data) {
      const scored: ScoredIdea[] = (data as IdeaEntry[]).map(idea => ({
        ...idea,
        heat: computeHeat(idea),
      }));
      setIdeas(scored);
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    fetchIdeas().finally(() => setLoading(false));
  }, [userId, fetchIdeas]);

  // Realtime subscription
  useEffect(() => {
    if (!userId) return;

    const channel: RealtimeChannel = supabase
      .channel(`spark-board-${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'entries',
          filter: `user_id=eq.${userId}`,
        },
        () => { fetchIdeas(); }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [userId, fetchIdeas]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="text-[10px] text-white/30">Loading...</span>
      </div>
    );
  }

  if (ideas.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-white/30">
        <Lightbulb className="w-6 h-6" />
        <span className="text-[11px]">No ideas saved yet</span>
        <span className="text-[10px] text-white/20">Dump some thoughts to JAC</span>
      </div>
    );
  }

  // Sort by heat
  const sorted = [...ideas].sort((a, b) =>
    tab === 'hot' ? b.heat - a.heat : a.heat - b.heat
  );

  const limit = compact ? 3 : expanded ? sorted.length : 8;
  const visible = sorted.slice(0, limit);

  const isColdTab = tab === 'cold';

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {visible.map(idea => {
        const colors = isColdTab
          ? { bg: 'bg-blue-500/10', text: 'text-blue-400', bar: 'bg-blue-500/60' }
          : heatColor(idea.heat);
        const maxHeat = 10; // importance_score max is 10, recencyWeight max is 1.0
        const barWidth = Math.min(100, (idea.heat / maxHeat) * 100);

        return (
          <button
            key={idea.id}
            onClick={() => onNavigate(`/brain?entryId=${idea.id}`)}
            className="flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-white/5 transition-colors border-b border-white/5 last:border-b-0 group"
          >
            {/* Heat bar */}
            <div className="flex flex-col items-center gap-0.5 shrink-0 w-8">
              <span className={`text-[10px] font-mono font-medium ${colors.text}`}>
                {idea.heat.toFixed(1)}
              </span>
              <div className="w-full h-1 rounded-full bg-white/5">
                <div
                  className={`h-full rounded-full ${colors.bar} transition-all`}
                  style={{ width: `${barWidth}%` }}
                />
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              <p className="text-[11px] text-white/70 line-clamp-1 group-hover:text-white/90 transition-colors">
                {idea.title || 'Untitled idea'}
              </p>
              <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                {/* Tags — max 2 */}
                {idea.tags?.slice(0, 2).map(tag => (
                  <span
                    key={tag}
                    className={`text-[9px] px-1.5 py-0.5 rounded-full ${colors.bg} ${colors.text}`}
                  >
                    {tag}
                  </span>
                ))}
                <span className="text-[9px] text-white/25">{timeAgo(idea.created_at)}</span>
              </div>
            </div>

            {/* Starred */}
            {idea.starred && (
              <Star className="w-3 h-3 text-amber-400/70 fill-amber-400/70 shrink-0" />
            )}
          </button>
        );
      })}
    </div>
  );
}
