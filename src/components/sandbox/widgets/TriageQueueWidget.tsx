/**
 * TriageQueueWidget — Items needing attention.
 */

import { useState, useEffect, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { useEntries } from '@/hooks/useEntries';
import { useProactiveInsights } from '@/hooks/useProactiveInsights';
import { AlertTriangle } from 'lucide-react';
import type { WidgetProps } from '@/types/widget';

interface TriageItem {
  id: string;
  title: string;
  contentType: string;
  reason: 'overdue' | 'unchecked' | 'stale' | 'flagged';
}

const REASON_BADGE: Record<string, string> = {
  overdue:  'bg-red-500/20 text-red-400',
  unchecked: 'bg-orange-500/20 text-orange-400',
  stale:    'bg-amber-500/20 text-amber-400',
  flagged:  'bg-purple-500/20 text-purple-400',
};

export default function TriageQueueWidget({ compact, onNavigate }: WidgetProps) {
  const [userId, setUserId] = useState<string | undefined>(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) setUserId(session.user.id);
    });
  }, []);

  const { entries, loading: entriesLoading } = useEntries({ userId: userId ?? '', pageSize: 50 });
  const { insights, loading: insightsLoading } = useProactiveInsights(userId);

  const loading = entriesLoading || insightsLoading;

  const items = useMemo((): TriageItem[] => {
    const todayStr = new Date().toISOString().split('T')[0];
    const twoWeeksAgo = new Date();
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
    const twoWeeksAgoStr = twoWeeksAgo.toISOString();

    const seen = new Set<string>();
    const result: TriageItem[] = [];

    // Overdue reminders/events
    for (const entry of entries) {
      if (
        entry.event_date &&
        entry.event_date < todayStr &&
        (entry.content_type === 'reminder' || entry.content_type === 'event')
      ) {
        if (!seen.has(entry.id)) {
          seen.add(entry.id);
          result.push({
            id: entry.id,
            title: entry.title || entry.content?.slice(0, 60) || 'Untitled',
            contentType: entry.content_type,
            reason: 'overdue',
          });
        }
      }
    }

    // Unchecked lists (lists with list_items where not all are checked)
    for (const entry of entries) {
      if (entry.content_type === 'list' && Array.isArray(entry.list_items)) {
        const hasUnchecked = (entry.list_items as Array<{ checked?: boolean }>).some(item => !item.checked);
        if (hasUnchecked && !seen.has(entry.id)) {
          seen.add(entry.id);
          result.push({
            id: entry.id,
            title: entry.title || 'Untitled list',
            contentType: entry.content_type,
            reason: 'unchecked',
          });
        }
      }
    }

    // Stale important entries (importance >= 7, updated > 14 days ago)
    for (const entry of entries) {
      if (
        (entry.importance_score ?? 0) >= 7 &&
        entry.updated_at < twoWeeksAgoStr &&
        !seen.has(entry.id)
      ) {
        seen.add(entry.id);
        result.push({
          id: entry.id,
          title: entry.title || entry.content?.slice(0, 60) || 'Untitled',
          contentType: entry.content_type,
          reason: 'stale',
        });
      }
    }

    // Insight-flagged entries
    const flaggedIds = new Set(insights.flatMap(i => i.entryIds));
    for (const entry of entries) {
      if (flaggedIds.has(entry.id) && !seen.has(entry.id)) {
        seen.add(entry.id);
        result.push({
          id: entry.id,
          title: entry.title || entry.content?.slice(0, 60) || 'Untitled',
          contentType: entry.content_type,
          reason: 'flagged',
        });
      }
    }

    return result;
  }, [entries, insights]);

  const visible = items.slice(0, compact ? 5 : items.length);

  return (
    <div className="flex flex-col h-full bg-white/[0.03] backdrop-blur-sm border border-white/10 rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-white/10 shrink-0 flex items-center gap-2">
        <AlertTriangle className="w-3.5 h-3.5 text-red-400/80 shrink-0" />
        <span className="text-xs font-medium text-white/70">Needs Attention</span>
        {!loading && items.length > 0 && (
          <span className="ml-auto text-[9px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 font-medium">
            {items.length}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-16">
            <span className="text-[10px] text-white/30">Loading...</span>
          </div>
        ) : visible.length === 0 ? (
          <div className="flex items-center justify-center h-16">
            <span className="text-[10px] text-white/30">Nothing needs attention</span>
          </div>
        ) : (
          <div className="divide-y divide-white/5">
            {visible.map(item => (
              <button
                key={item.id}
                onClick={() => onNavigate('/dashboard')}
                className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/[0.04] transition-colors text-left"
              >
                <span
                  className={cn(
                    'text-[9px] px-1.5 py-0.5 rounded font-medium capitalize shrink-0',
                    REASON_BADGE[item.reason]
                  )}
                >
                  {item.reason}
                </span>
                <span className="text-xs text-white/70 flex-1 truncate">
                  {item.title}
                </span>
                <span className="text-[10px] text-white/30 shrink-0 capitalize">
                  {item.contentType}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
