/**
 * DriftRadarWidget — Surfaces important entries the user is neglecting.
 *
 * Two tabs (managed by WidgetChrome):
 *  - Drifting: List of high-importance entries not accessed recently
 *  - Stats: Summary breakdown of drifting entries
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import type { WidgetProps } from '@/types/widget';
import type { RealtimeChannel } from '@supabase/supabase-js';

interface DriftEntry {
  id: string;
  title: string;
  content_type: string;
  tags: string[] | null;
  importance_score: number;
  access_count: number;
  last_accessed_at: string | null;
  created_at: string;
}

const DRIFT_THRESHOLD_DAYS = 5;

function driftLabel(lastAccessed: string | null): string {
  if (!lastAccessed) return 'never';
  const diffMs = Date.now() - new Date(lastAccessed).getTime();
  const days = Math.floor(diffMs / 86400000);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}

function driftDays(lastAccessed: string | null, createdAt: string): number {
  const ref = lastAccessed || createdAt;
  return Math.floor((Date.now() - new Date(ref).getTime()) / 86400000);
}

function importanceColor(score: number): string {
  if (score >= 9) return 'bg-red-500/20 text-red-400';
  if (score >= 7) return 'bg-amber-500/20 text-amber-400';
  return 'bg-yellow-500/15 text-yellow-400/70';
}

function typeColor(type: string): string {
  switch (type) {
    case 'idea': return 'bg-purple-400';
    case 'code': return 'bg-green-400';
    case 'link': return 'bg-cyan-400';
    case 'event': return 'bg-blue-400';
    case 'reminder': return 'bg-orange-400';
    case 'contact': return 'bg-pink-400';
    case 'list': return 'bg-teal-400';
    default: return 'bg-white/40';
  }
}

export default function DriftRadarWidget({ compact, activeTab, onNavigate, expanded }: WidgetProps) {
  const [userId, setUserId] = useState('');
  const [entries, setEntries] = useState<DriftEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const tab = activeTab || 'drifting';

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) setUserId(session.user.id);
    });
  }, []);

  const fetchDrifting = useCallback(async () => {
    if (!userId) return;

    const cutoff = new Date(Date.now() - DRIFT_THRESHOLD_DAYS * 86400000).toISOString();

    // Fetch entries with importance >= 6, not archived, and either never accessed or not accessed in 5+ days
    const { data } = await supabase
      .from('entries')
      .select('id, title, content_type, tags, importance_score, access_count, last_accessed_at, created_at')
      .eq('user_id', userId)
      .gte('importance_score', 6)
      .or('archived.is.null,archived.eq.false')
      .or(`last_accessed_at.is.null,last_accessed_at.lt.${cutoff}`)
      .order('importance_score', { ascending: false })
      .order('last_accessed_at', { ascending: true, nullsFirst: true })
      .limit(20);

    if (data) {
      setEntries(
        (data as Array<{
          id: string; title: string; content_type: string; tags: string[] | null;
          importance_score: number; access_count: number; last_accessed_at: string | null;
          created_at: string;
        }>).map(e => ({
          id: e.id,
          title: e.title,
          content_type: e.content_type,
          tags: e.tags,
          importance_score: e.importance_score,
          access_count: e.access_count,
          last_accessed_at: e.last_accessed_at,
          created_at: e.created_at,
        }))
      );
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    fetchDrifting().finally(() => setLoading(false));
  }, [userId, fetchDrifting]);

  // Realtime subscription
  useEffect(() => {
    if (!userId) return;

    const channel: RealtimeChannel = supabase
      .channel(`drift-radar-${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'entries',
          filter: `user_id=eq.${userId}`,
        },
        () => { fetchDrifting(); }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [userId, fetchDrifting]);

  // Stats computation
  const stats = useMemo(() => {
    if (entries.length === 0) return null;

    const totalDays = entries.reduce((sum, e) => sum + driftDays(e.last_accessed_at, e.created_at), 0);
    const avgDrift = Math.round(totalDays / entries.length);

    const typeCounts: Record<string, number> = {};
    for (const e of entries) {
      typeCounts[e.content_type] = (typeCounts[e.content_type] || 0) + 1;
    }

    const mostNeglectedType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0];

    return {
      total: entries.length,
      avgDriftDays: avgDrift,
      mostNeglectedType: mostNeglectedType ? { type: mostNeglectedType[0], count: mostNeglectedType[1] } : null,
      typeCounts,
    };
  }, [entries]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="text-[10px] text-white/30">Loading...</span>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-white/30">
        <ShieldCheck className="w-6 h-6" />
        <span className="text-[11px]">Nothing drifting — you're on top of it</span>
      </div>
    );
  }

  // --- STATS TAB ---
  if (tab === 'stats') {
    if (!stats) return null;

    const typeBreakdown = Object.entries(stats.typeCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => `${count} ${type}${count !== 1 ? 's' : ''}`)
      .join(', ');

    return (
      <div className="flex flex-col h-full px-3 py-2 gap-3">
        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-white/50">Drifting entries</span>
            <span className="text-sm font-semibold text-white/80">{stats.total}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-white/50">Avg drift time</span>
            <span className="text-sm font-semibold text-white/80">
              {stats.avgDriftDays < 7
                ? `${stats.avgDriftDays}d`
                : stats.avgDriftDays < 30
                  ? `${Math.round(stats.avgDriftDays / 7)}w`
                  : `${Math.round(stats.avgDriftDays / 30)}mo`}
            </span>
          </div>
          {stats.mostNeglectedType && (
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-white/50">Most neglected type</span>
              <span className="text-sm font-semibold text-white/80 capitalize">
                {stats.mostNeglectedType.type}
              </span>
            </div>
          )}
        </div>

        <div className="pt-2 border-t border-white/5">
          <span className="text-[9px] text-white/30 uppercase tracking-wider">Breakdown</span>
          <p className="text-[11px] text-white/50 mt-1 leading-relaxed">{typeBreakdown}</p>
        </div>
      </div>
    );
  }

  // --- DRIFTING TAB ---
  const limit = compact ? 3 : expanded ? entries.length : 8;
  const visible = entries.slice(0, limit);

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {visible.map(entry => (
        <button
          key={entry.id}
          onClick={() => onNavigate(`/brain?entryId=${entry.id}`)}
          className="flex items-center gap-2 px-3 py-2 text-left hover:bg-white/5 transition-colors border-b border-white/5 last:border-b-0 group"
        >
          {/* Type dot */}
          <span className={`w-2 h-2 rounded-full shrink-0 ${typeColor(entry.content_type)}`} />

          {/* Title + tags */}
          <div className="flex-1 min-w-0">
            <p className="text-[11px] text-white/70 line-clamp-1">{entry.title || 'Untitled'}</p>
            {entry.tags && entry.tags.length > 0 && (
              <div className="flex gap-1 mt-0.5">
                {entry.tags.slice(0, 2).map(tag => (
                  <span key={tag} className="text-[8px] px-1 py-px rounded bg-white/5 text-white/30">
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Importance badge */}
          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${importanceColor(entry.importance_score)} shrink-0`}>
            {entry.importance_score}
          </span>

          {/* Drift time */}
          <span className="text-[10px] text-white/30 shrink-0 w-10 text-right">
            {driftLabel(entry.last_accessed_at)}
          </span>
        </button>
      ))}
    </div>
  );
}
