/**
 * CreateEventModal — Shared create event/reminder dialog.
 * Extracted from Calendar.tsx for reuse in CalendarWidget.
 */

import { useState, useMemo } from 'react';
import { format } from 'date-fns';
import { Plus, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import type { CreateEventData } from '@/hooks/useCalendarEntries';

interface CreateEventModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultDate: Date | null;
  onSubmit: (data: CreateEventData) => Promise<void>;
}

export function CreateEventModal({
  open,
  onOpenChange,
  defaultDate,
  onSubmit,
}: CreateEventModalProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [type, setType] = useState<'event' | 'reminder'>('event');
  const [reminderMinutes, setReminderMinutes] = useState(30);
  const [isRecurring, setIsRecurring] = useState(false);
  const [recurrencePattern, setRecurrencePattern] = useState('weekly');
  const [submitting, setSubmitting] = useState(false);

  // Reset form when modal opens with a new date
  const dateStr = defaultDate ? format(defaultDate, 'yyyy-MM-dd') : '';
  useMemo(() => {
    if (open) {
      setTitle('');
      setDescription('');
      setDate(dateStr);
      setTime('');
      setType('event');
      setReminderMinutes(30);
      setIsRecurring(false);
      setRecurrencePattern('weekly');
    }
  }, [open, dateStr]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !date) return;
    setSubmitting(true);
    try {
      await onSubmit({
        title: title.trim(),
        description: description.trim() || undefined,
        date,
        time: time || undefined,
        type,
        reminderMinutes: type === 'reminder' ? reminderMinutes : undefined,
        isRecurring,
        recurrencePattern: isRecurring ? recurrencePattern : undefined,
      });
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-zinc-900 border-white/10 text-white max-w-md">
        <DialogHeader>
          <DialogTitle className="text-white">New event</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Title */}
          <div>
            <label className="text-xs text-white/50 mb-1 block">Title *</label>
            <Input
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="What's happening?"
              className="bg-white/5 border-white/10 text-white placeholder:text-white/30"
              autoFocus
              required
            />
          </div>

          {/* Description */}
          <div>
            <label className="text-xs text-white/50 mb-1 block">Description</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Optional details..."
              rows={2}
              className="w-full rounded-md bg-white/5 border border-white/10 text-white placeholder:text-white/30 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500/40"
            />
          </div>

          {/* Date + Time row */}
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-xs text-white/50 mb-1 block">Date *</label>
              <Input
                type="date"
                value={date}
                onChange={e => setDate(e.target.value)}
                className="bg-white/5 border-white/10 text-white"
                required
              />
            </div>
            <div className="flex-1">
              <label className="text-xs text-white/50 mb-1 block">Time</label>
              <Input
                type="time"
                value={time}
                onChange={e => setTime(e.target.value)}
                className="bg-white/5 border-white/10 text-white"
              />
            </div>
          </div>

          {/* Type toggle */}
          <div>
            <label className="text-xs text-white/50 mb-1 block">Type</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setType('event')}
                className={cn(
                  'flex-1 text-xs py-2 rounded-md border transition-colors',
                  type === 'event'
                    ? 'bg-blue-500/20 border-blue-500/40 text-blue-400'
                    : 'bg-white/5 border-white/10 text-white/50 hover:text-white/70',
                )}
              >
                Event
              </button>
              <button
                type="button"
                onClick={() => setType('reminder')}
                className={cn(
                  'flex-1 text-xs py-2 rounded-md border transition-colors',
                  type === 'reminder'
                    ? 'bg-amber-500/20 border-amber-500/40 text-amber-400'
                    : 'bg-white/5 border-white/10 text-white/50 hover:text-white/70',
                )}
              >
                Reminder
              </button>
            </div>
          </div>

          {/* Reminder minutes (only for reminders) */}
          {type === 'reminder' && (
            <div>
              <label className="text-xs text-white/50 mb-1 block">Remind me (minutes before)</label>
              <Input
                type="number"
                value={reminderMinutes}
                onChange={e => setReminderMinutes(parseInt(e.target.value, 10) || 0)}
                min={0}
                className="bg-white/5 border-white/10 text-white w-32"
              />
            </div>
          )}

          {/* Recurring */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id="recurring"
                checked={isRecurring}
                onCheckedChange={(checked) => setIsRecurring(checked === true)}
                className="border-white/20 data-[state=checked]:bg-blue-500 data-[state=checked]:border-blue-500"
              />
              <label htmlFor="recurring" className="text-xs text-white/60 cursor-pointer">
                Recurring
              </label>
            </div>
            {isRecurring && (
              <div className="flex gap-2 pl-6">
                {['daily', 'weekly', 'monthly', 'yearly'].map(p => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setRecurrencePattern(p)}
                    className={cn(
                      'text-[10px] px-2 py-1 rounded border transition-colors capitalize',
                      recurrencePattern === p
                        ? 'bg-violet-500/20 border-violet-500/40 text-violet-400'
                        : 'bg-white/5 border-white/10 text-white/40 hover:text-white/60',
                    )}
                  >
                    {p}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Submit */}
          <div className="flex justify-end pt-2">
            <Button
              type="submit"
              disabled={!title.trim() || !date || submitting}
              className="bg-blue-600 hover:bg-blue-700 text-white text-xs px-4"
            >
              {submitting ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Plus className="w-3 h-3 mr-1" />}
              Create
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
