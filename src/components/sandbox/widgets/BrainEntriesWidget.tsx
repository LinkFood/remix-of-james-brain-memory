/**
 * BrainEntriesWidget — Recent brain entries list.
 */

import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { useEntries } from '@/hooks/useEntries';
import type { WidgetProps } from '@/types/widget';

const TYPE_BADGES: Record<string, string> = {
  note: 'bg-blue-500/20 text-blue-400',
  idea: 'bg-violet-500/20 text-violet-400',
  link: 'bg-cyan-500/20 text-cyan-400',
  code: 'bg-indigo-500/20 text-indigo-400',
  contact: 'bg-emerald-500/20 text-emerald-400',
  event: 'bg-amber-500/20 text-amber-400',
  reminder: 'bg-red-500/20 text-red-400',
  list: 'bg-orange-500/20 text-orange-400',
};

function timeAgo(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'now';
  if (diffMin < 60) return `${diffMin}m`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h`;
  return `${Math.floor(diffH / 24)}d`;
}

export default function BrainEntriesWidget({ compact, onNavigate }: WidgetProps) {
  const [userId, setUserId] = useState('');

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) setUserId(session.user.id);
    });
  }, []);

  const { entries, loading, stats } = useEntries({ userId, pageSize: 10 });

  const visible = entries.slice(0, compact ? 5 : 10);

  return (
    <div className="flex flex-col h-full bg-white/[0.03] backdrop-blur-sm border border-white/10 rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-white/10 shrink-0 flex items-center justify-between">
        <span className="text-xs font-medium text-white/70">Brain Entries</span>
        {!loading && (
          <span className="text-[10px] text-white/30">{stats.today} today</span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-16">
            <span className="text-[10px] text-white/30">Loading...</span>
          </div>
        ) : visible.length === 0 ? (
          <div className="flex items-center justify-center h-16">
            <span className="text-[10px] text-white/30">No entries yet</span>
          </div>
        ) : (
          <div className="divide-y divide-white/5">
            {visible.map(entry => (
              <button
                key={entry.id}
                onClick={() => onNavigate('/dashboard')}
                className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/[0.04] transition-colors text-left"
              >
                <span
                  className={cn(
                    'text-[9px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wide shrink-0',
                    TYPE_BADGES[entry.content_type] ?? 'bg-white/10 text-white/50'
                  )}
                >
                  {entry.content_type}
                </span>
                <span className="text-xs text-white/70 flex-1 truncate">
                  {entry.title || entry.content?.slice(0, 60) || 'Untitled'}
                </span>
                <span className="text-[10px] text-white/30 shrink-0">
                  {timeAgo(entry.created_at)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {!loading && stats.total > 0 && (
        <button
          onClick={() => onNavigate('/dashboard')}
          className="px-3 py-2 border-t border-white/10 text-[10px] text-white/40 hover:text-white/60 transition-colors text-center shrink-0"
        >
          {stats.total} total entries
        </button>
      )}
    </div>
  );
}
