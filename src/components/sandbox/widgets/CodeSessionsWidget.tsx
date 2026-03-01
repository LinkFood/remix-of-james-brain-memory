/**
 * CodeSessionsWidget — Latest code agent sessions.
 */

import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { ExternalLink } from 'lucide-react';
import type { WidgetProps } from '@/types/widget';

interface CodeSession {
  id: string;
  branch_name: string;
  status: 'active' | 'completed' | 'failed' | 'awaiting_ci';
  pr_url: string | null;
  intent: string;
  updated_at: string;
}

const STATUS_BADGE: Record<string, string> = {
  completed: 'bg-emerald-500/20 text-emerald-400',
  active: 'bg-blue-500/20 text-blue-400',
  awaiting_ci: 'bg-blue-500/20 text-blue-400',
  failed: 'bg-red-500/20 text-red-400',
};

export default function CodeSessionsWidget({ onNavigate }: WidgetProps) {
  const [userId, setUserId] = useState('');
  const [sessions, setSessions] = useState<CodeSession[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) setUserId(session.user.id);
    });
  }, []);

  useEffect(() => {
    if (!userId) return;
    supabase
      .from('code_sessions')
      .select('id, branch_name, status, pr_url, intent, updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(5)
      .then(({ data }) => {
        if (data) setSessions(data as CodeSession[]);
        setLoading(false);
      });
  }, [userId]);

  return (
    <div className="flex flex-col h-full bg-white/[0.03] backdrop-blur-sm border border-white/10 rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-white/10 shrink-0">
        <span className="text-xs font-medium text-white/70">Code Sessions</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-16">
            <span className="text-[10px] text-white/30">Loading...</span>
          </div>
        ) : sessions.length === 0 ? (
          <div className="flex items-center justify-center h-16">
            <span className="text-[10px] text-white/30">No code sessions</span>
          </div>
        ) : (
          <div className="divide-y divide-white/5">
            {sessions.map(session => (
              <div
                key={session.id}
                className="flex items-center gap-2 px-3 py-2 hover:bg-white/[0.04] transition-colors"
              >
                <button
                  onClick={() => onNavigate('/code')}
                  className="flex-1 flex items-center gap-2 text-left min-w-0"
                >
                  <span
                    className={cn(
                      'text-[9px] px-1.5 py-0.5 rounded font-medium capitalize shrink-0',
                      STATUS_BADGE[session.status] ?? 'bg-white/10 text-white/50'
                    )}
                  >
                    {session.status === 'awaiting_ci' ? 'CI' : session.status}
                  </span>
                  <span className="text-xs text-white/70 truncate">
                    {session.branch_name}
                  </span>
                </button>
                {session.pr_url && (
                  <a
                    href={session.pr_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={e => e.stopPropagation()}
                    className="shrink-0 text-indigo-400/70 hover:text-indigo-400 transition-colors"
                  >
                    <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
