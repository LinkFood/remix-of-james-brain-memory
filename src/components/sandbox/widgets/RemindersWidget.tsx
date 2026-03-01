/**
 * RemindersWidget — Today and overdue reminders with done/delete/view actions.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { useEntryActions } from '@/hooks/useEntryActions';
import { CheckCircle, Check, Trash2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import EntryView from '@/components/EntryView';
import { parseListItems } from '@/lib/parseListItems';
import type { Entry } from '@/types';
import type { WidgetProps } from '@/types/widget';

function dateLabel(eventDate: string): { label: string; className: string } {
  const todayStr = new Date().toISOString().split('T')[0];
  if (eventDate < todayStr) return { label: 'Overdue', className: 'text-red-400' };
  if (eventDate === todayStr) return { label: 'Today', className: 'text-amber-400' };
  return { label: 'Upcoming', className: 'text-emerald-400' };
}

function toEntry(data: any): Entry {
  return {
    ...data,
    tags: data.tags || [],
    extracted_data: (data.extracted_data as Record<string, unknown>) || {},
    list_items: parseListItems(data.list_items),
  };
}

export default function RemindersWidget({ onNavigate }: WidgetProps) {
  const [userId, setUserId] = useState('');
  const [reminderEntries, setReminderEntries] = useState<Entry[]>([]);
  const [loadingEntries, setLoadingEntries] = useState(true);
  const [viewEntry, setViewEntry] = useState<Entry | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) setUserId(session.user.id);
    });
  }, []);

  const handleRemove = useCallback((entryId: string) => {
    setReminderEntries(prev => prev.filter(e => e.id !== entryId));
  }, []);

  const handleUpdate = useCallback((entryId: string, updates: Partial<Entry>) => {
    setReminderEntries(prev =>
      prev.map(e => (e.id === entryId ? { ...e, ...updates } : e))
    );
  }, []);

  const { toggleArchive, deleteEntry } = useEntryActions({
    onEntryRemove: handleRemove,
    onEntryUpdate: handleUpdate,
  });

  useEffect(() => {
    if (!userId) return;
    const todayStr = new Date().toISOString().split('T')[0];
    supabase
      .from('entries')
      .select('*')
      .eq('user_id', userId)
      .eq('archived', false)
      .lte('event_date', todayStr)
      .in('content_type', ['reminder', 'event'])
      .order('event_date', { ascending: true })
      .limit(10)
      .then(({ data }) => {
        if (data) setReminderEntries(data.map(toEntry));
        setLoadingEntries(false);
      });
  }, [userId]);

  // Derive counts from local state for instant feedback
  const { overdueCount, todayCount } = useMemo(() => {
    const todayStr = new Date().toISOString().split('T')[0];
    let overdue = 0;
    let today = 0;
    for (const e of reminderEntries) {
      if (e.event_date && e.event_date < todayStr) overdue++;
      else if (e.event_date === todayStr) today++;
    }
    return { overdueCount: overdue, todayCount: today };
  }, [reminderEntries]);

  const loading = loadingEntries;
  const allClear = !loading && overdueCount === 0 && todayCount === 0;

  return (
    <div className="flex flex-col h-full bg-white/[0.03] backdrop-blur-sm border border-white/10 rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-white/10 shrink-0 flex items-center gap-2">
        <span className="text-xs font-medium text-white/70">Reminders</span>
        {!loading && overdueCount > 0 && (
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 font-medium">
            {overdueCount} overdue
          </span>
        )}
        {!loading && todayCount > 0 && (
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 font-medium">
            {todayCount} today
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-16">
            <span className="text-[10px] text-white/30">Loading...</span>
          </div>
        ) : allClear ? (
          <div className="flex flex-col items-center justify-center h-full gap-1.5 text-emerald-400/60">
            <CheckCircle className="w-5 h-5" />
            <span className="text-[10px]">All clear</span>
          </div>
        ) : (
          <div className="divide-y divide-white/5">
            {reminderEntries.map(entry => {
              const { label, className } = entry.event_date
                ? dateLabel(entry.event_date)
                : { label: '', className: '' };
              return (
                <div
                  key={entry.id}
                  className="group w-full flex items-center gap-2 px-3 py-2 hover:bg-white/[0.04] transition-colors text-left"
                >
                  <span
                    className={cn(
                      'text-[9px] font-medium shrink-0 w-12',
                      className
                    )}
                  >
                    {label}
                  </span>
                  <button
                    onClick={() => setViewEntry(entry)}
                    className="text-xs text-white/70 flex-1 truncate text-left hover:text-white/90 transition-colors"
                  >
                    {entry.title || entry.content?.slice(0, 60) || 'Untitled'}
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); toggleArchive(entry.id); }}
                    className="shrink-0 p-0.5 text-white/20 hover:text-emerald-400 transition-colors opacity-0 group-hover:opacity-100"
                    title="Mark done"
                  >
                    <Check className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setDeleteId(entry.id); }}
                    className="shrink-0 p-0.5 text-white/20 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
                    title="Delete"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* EntryView modal */}
      <EntryView
        entry={viewEntry}
        open={!!viewEntry}
        onClose={() => setViewEntry(null)}
        onUpdate={(updated) => {
          handleUpdate(updated.id, updated);
          setViewEntry(updated);
        }}
        onDelete={(id) => {
          handleRemove(id);
          setViewEntry(null);
        }}
      />

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteId} onOpenChange={(open) => { if (!open) setDeleteId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete reminder?</AlertDialogTitle>
            <AlertDialogDescription>
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => {
                if (deleteId) deleteEntry(deleteId);
                setDeleteId(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
