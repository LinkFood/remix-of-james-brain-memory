/**
 * TheWireWidget — Surfaces surprising connections between brain entries.
 *
 * Queries entry_relationships, enriches with entry metadata, computes
 * "surprise score" (similarity * time gap * type diff), renders as
 * linked pairs. Two tabs: Surprising (weighted) and Strongest (raw).
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import type { WidgetProps } from '@/types/widget';
import type { RealtimeChannel } from '@supabase/supabase-js';

interface EntryMeta {
  id: string;
  title: string | null;
  content_type: string;
  tags: string[] | null;
  importance_score: number | null;
  created_at: string;
}

interface RawRelationship {
  id: string;
  source_entry_id: string;
  related_entry_id: string;
  similarity_score: number;
  relationship_type: string;
  created_at: string;
}

interface EnrichedConnection {
  id: string;
  source: EntryMeta;
  related: EntryMeta;
  similarity: number;
  surprise: number;
  crossType: boolean;
}

const TYPE_COLORS: Record<string, string> = {
  idea: 'bg-amber-400',
  code: 'bg-emerald-400',
  note: 'bg-blue-400',
  link: 'bg-cyan-400',
  event: 'bg-purple-400',
  reminder: 'bg-rose-400',
  contact: 'bg-pink-400',
  list: 'bg-orange-400',
  document: 'bg-teal-400',
  image: 'bg-indigo-400',
};

function typeColor(ct: string): string {
  return TYPE_COLORS[ct] || 'bg-white/40';
}

function timeAgo(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'now';
  if (diffMin < 60) return `${diffMin}m`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 30) return `${diffD}d`;
  return `${Math.floor(diffD / 30)}mo`;
}

function computeSurprise(sim: number, source: EntryMeta, related: EntryMeta): number {
  const daysBetween = Math.abs(
    (new Date(source.created_at).getTime() - new Date(related.created_at).getTime()) / (1000 * 60 * 60 * 24)
  );
  const timeGapWeight = Math.min(daysBetween / 30, 2.0);
  const typeDiffBonus = source.content_type !== related.content_type ? 1.5 : 1.0;
  return sim * Math.max(timeGapWeight, 0.3) * typeDiffBonus;
}

export default function TheWireWidget({ compact, expanded, activeTab, onNavigate }: WidgetProps) {
  const [userId, setUserId] = useState('');
  const [connections, setConnections] = useState<EnrichedConnection[]>([]);
  const [loading, setLoading] = useState(true);

  const tab = activeTab || 'surprising';

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) setUserId(session.user.id);
    });
  }, []);

  const fetchConnections = useCallback(async () => {
    if (!userId) return;

    // 1. Fetch relationships
    const { data: relData } = await (supabase
      .from('entry_relationships' as any)
      .select('id, source_entry_id, related_entry_id, similarity_score, relationship_type, created_at')
      .eq('user_id', userId)
      .order('similarity_score', { ascending: false })
      .limit(50) as any);

    if (!relData || (relData as any[]).length === 0) {
      setConnections([]);
      return;
    }

    const rels = relData as unknown as RawRelationship[];

    // 2. Collect all unique entry IDs
    const entryIds = new Set<string>();
    for (const r of rels) {
      entryIds.add(r.source_entry_id);
      entryIds.add(r.related_entry_id);
    }

    // 3. Fetch entry metadata
    const { data: entryData } = await supabase
      .from('entries')
      .select('id, title, content_type, tags, importance_score, created_at')
      .in('id', Array.from(entryIds));

    const entryMap = new Map<string, EntryMeta>();
    if (entryData) {
      for (const e of entryData as Array<EntryMeta>) {
        entryMap.set(e.id, e);
      }
    }

    // 4. Enrich and compute surprise scores
    const enriched: EnrichedConnection[] = [];
    for (const r of rels) {
      const source = entryMap.get(r.source_entry_id);
      const related = entryMap.get(r.related_entry_id);
      if (!source || !related) continue;

      enriched.push({
        id: r.id,
        source,
        related,
        similarity: r.similarity_score,
        surprise: computeSurprise(r.similarity_score, source, related),
        crossType: source.content_type !== related.content_type,
      });
    }

    setConnections(enriched);
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    fetchConnections().finally(() => setLoading(false));
  }, [userId, fetchConnections]);

  // Realtime subscription
  useEffect(() => {
    if (!userId) return;

    const channel: RealtimeChannel = supabase
      .channel(`the-wire-${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'entry_relationships',
          filter: `user_id=eq.${userId}`,
        },
        () => { fetchConnections(); }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [userId, fetchConnections]);

  // Sort based on active tab
  const sorted = useMemo(() => {
    const copy = [...connections];
    if (tab === 'strongest') {
      copy.sort((a, b) => b.similarity - a.similarity);
    } else {
      copy.sort((a, b) => b.surprise - a.surprise);
    }
    return copy;
  }, [connections, tab]);

  const limit = compact ? 2 : expanded ? 15 : 5;
  const visible = sorted.slice(0, limit);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="text-[10px] text-white/30">Loading...</span>
      </div>
    );
  }

  if (connections.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-white/30">
        <Link2 className="w-6 h-6" />
        <span className="text-[11px]">No connections yet</span>
        <span className="text-[10px] text-white/20">JAC builds these as you save entries</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {visible.map(conn => (
        <div
          key={conn.id}
          className={cn(
            'flex items-center gap-2 px-3 py-2.5 border-b border-white/5 last:border-b-0',
            conn.crossType && 'border-l-2 border-l-cyan-500/20'
          )}
        >
          {/* Source entry */}
          <button
            onClick={() => onNavigate(`/brain?entryId=${conn.source.id}`)}
            className="flex-1 min-w-0 text-left hover:bg-white/5 rounded px-1.5 py-1 transition-colors"
          >
            <div className="flex items-center gap-1.5">
              <div className={cn('w-2 h-2 rounded-full shrink-0', typeColor(conn.source.content_type))} />
              <span className="text-[11px] text-white/70 line-clamp-1">
                {conn.source.title || conn.source.content_type}
              </span>
            </div>
            <span className="text-[9px] text-white/25 ml-3.5">{timeAgo(conn.source.created_at)}</span>
          </button>

          {/* Similarity badge */}
          <div className="flex items-center gap-1 shrink-0">
            <Link2 className="w-2.5 h-2.5 text-white/20" />
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-white/10 text-white/50">
              {Math.round(conn.similarity * 100)}%
            </span>
          </div>

          {/* Related entry */}
          <button
            onClick={() => onNavigate(`/brain?entryId=${conn.related.id}`)}
            className="flex-1 min-w-0 text-right hover:bg-white/5 rounded px-1.5 py-1 transition-colors"
          >
            <div className="flex items-center justify-end gap-1.5">
              <span className="text-[11px] text-white/70 line-clamp-1">
                {conn.related.title || conn.related.content_type}
              </span>
              <div className={cn('w-2 h-2 rounded-full shrink-0', typeColor(conn.related.content_type))} />
            </div>
            <span className="text-[9px] text-white/25 mr-3.5">{timeAgo(conn.related.created_at)}</span>
          </button>
        </div>
      ))}
    </div>
  );
}
