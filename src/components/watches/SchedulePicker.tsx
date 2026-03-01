/**
 * SchedulePicker — Visual cron expression builder.
 *
 * Presets: hourly, every_6h, daily, weekdays, weekly, custom.
 * Produces a standard 5-field cron expression.
 */

import { useState, useEffect, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';

type Frequency = 'hourly' | 'every_6h' | 'daily' | 'weekdays' | 'weekly' | 'custom';

interface SchedulePickerProps {
  value: string;
  onChange: (cron: string) => void;
}

const FREQ_OPTIONS: { value: Frequency; label: string }[] = [
  { value: 'hourly', label: 'Hourly' },
  { value: 'every_6h', label: 'Every 6h' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'custom', label: 'Custom' },
];

const DAYS = [
  { value: 1, label: 'M' },
  { value: 2, label: 'T' },
  { value: 3, label: 'W' },
  { value: 4, label: 'T' },
  { value: 5, label: 'F' },
  { value: 6, label: 'S' },
  { value: 0, label: 'S' },
];

function parseCronToState(cron: string): {
  frequency: Frequency;
  hour: number;
  minute: number;
  days: number[];
  customCron: string;
} {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return { frequency: 'custom', hour: 9, minute: 0, days: [], customCron: cron };

  const [min, hour, , , dow] = parts;

  if (min === '0' && hour === '*') return { frequency: 'hourly', hour: 9, minute: 0, days: [], customCron: '' };
  if (min === '0' && hour === '*/6') return { frequency: 'every_6h', hour: 9, minute: 0, days: [], customCron: '' };

  const h = parseInt(hour);
  const m = parseInt(min);
  if (isNaN(h) || isNaN(m)) return { frequency: 'custom', hour: 9, minute: 0, days: [], customCron: cron };

  if (dow === '1-5') return { frequency: 'weekdays', hour: h, minute: m, days: [], customCron: '' };
  if (dow === '*') return { frequency: 'daily', hour: h, minute: m, days: [], customCron: '' };

  // Weekly with specific days
  const dayNums = dow.split(',').map(Number).filter(n => !isNaN(n));
  if (dayNums.length > 0) return { frequency: 'weekly', hour: h, minute: m, days: dayNums, customCron: '' };

  return { frequency: 'custom', hour: 9, minute: 0, days: [], customCron: cron };
}

function buildCron(frequency: Frequency, hour: number, minute: number, days: number[], customCron: string): string {
  switch (frequency) {
    case 'hourly': return '0 * * * *';
    case 'every_6h': return '0 */6 * * *';
    case 'daily': return `${minute} ${hour} * * *`;
    case 'weekdays': return `${minute} ${hour} * * 1-5`;
    case 'weekly': {
      const dow = days.length > 0 ? days.sort((a, b) => a - b).join(',') : '1';
      return `${minute} ${hour} * * ${dow}`;
    }
    case 'custom': return customCron || '0 9 * * *';
  }
}

function prettyCronPreview(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour, , , dow] = parts;

  if (min === '0' && hour === '*') return 'Every hour, on the hour';
  if (min === '0' && hour === '*/6') return 'Every 6 hours';

  const h = parseInt(hour);
  const m = parseInt(min);
  if (isNaN(h) || isNaN(m)) return cron;

  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  const time = `${h12}:${m.toString().padStart(2, '0')} ${ampm}`;

  if (dow === '*') return `Daily at ${time} CT`;
  if (dow === '1-5') return `Weekdays at ${time} CT`;

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayNums = dow.split(',').map(Number).filter(n => !isNaN(n));
  if (dayNums.length > 0) {
    const names = dayNums.map(d => dayNames[d] || d).join(', ');
    return `${names} at ${time} CT`;
  }

  return `${time} CT (${dow})`;
}

export function SchedulePicker({ value, onChange }: SchedulePickerProps) {
  const initial = useMemo(() => parseCronToState(value || '0 9 * * *'), []);
  const [frequency, setFrequency] = useState<Frequency>(initial.frequency);
  const [hour, setHour] = useState(initial.hour);
  const [minute, setMinute] = useState(initial.minute);
  const [days, setDays] = useState<number[]>(initial.days);
  const [customCron, setCustomCron] = useState(initial.customCron);

  const showTimePicker = frequency !== 'hourly' && frequency !== 'every_6h' && frequency !== 'custom';
  const showDayPicker = frequency === 'weekly';
  const showCustomInput = frequency === 'custom';

  // Convert 24h to 12h for display
  const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  const ampm = hour >= 12 ? 'PM' : 'AM';

  const cron = buildCron(frequency, hour, minute, days, customCron);

  useEffect(() => {
    onChange(cron);
  }, [cron, onChange]);

  const toggleDay = (day: number) => {
    setDays(prev => prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day]);
  };

  const setAmPm = (val: 'AM' | 'PM') => {
    if (val === 'AM' && hour >= 12) setHour(hour - 12);
    if (val === 'PM' && hour < 12) setHour(hour + 12);
  };

  const setDisplayHour = (h12: number) => {
    const h24 = ampm === 'PM' ? (h12 === 12 ? 12 : h12 + 12) : (h12 === 12 ? 0 : h12);
    setHour(h24);
  };

  return (
    <div className="space-y-3">
      {/* Frequency presets */}
      <div>
        <label className="text-xs text-white/50 mb-1.5 block">Frequency</label>
        <div className="flex flex-wrap gap-1.5">
          {FREQ_OPTIONS.map(opt => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setFrequency(opt.value)}
              className={cn(
                'text-xs px-3 py-1.5 rounded-md border transition-colors',
                frequency === opt.value
                  ? 'bg-blue-500/20 border-blue-500/40 text-blue-400'
                  : 'bg-white/5 border-white/10 text-white/50 hover:text-white/70',
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Time picker */}
      {showTimePicker && (
        <div>
          <label className="text-xs text-white/50 mb-1.5 block">Time</label>
          <div className="flex items-center gap-2">
            <select
              value={displayHour}
              onChange={e => setDisplayHour(parseInt(e.target.value))}
              className="bg-white/5 border border-white/10 rounded-md px-2 py-1.5 text-xs text-white outline-none"
            >
              {Array.from({ length: 12 }, (_, i) => i + 1).map(h => (
                <option key={h} value={h}>{h}</option>
              ))}
            </select>
            <span className="text-white/40">:</span>
            <select
              value={minute}
              onChange={e => setMinute(parseInt(e.target.value))}
              className="bg-white/5 border border-white/10 rounded-md px-2 py-1.5 text-xs text-white outline-none"
            >
              {[0, 15, 30, 45].map(m => (
                <option key={m} value={m}>{m.toString().padStart(2, '0')}</option>
              ))}
            </select>
            <div className="flex gap-0.5">
              {(['AM', 'PM'] as const).map(val => (
                <button
                  key={val}
                  type="button"
                  onClick={() => setAmPm(val)}
                  className={cn(
                    'text-[10px] px-2 py-1 rounded border transition-colors',
                    ampm === val
                      ? 'bg-blue-500/20 border-blue-500/40 text-blue-400'
                      : 'bg-white/5 border-white/10 text-white/40',
                  )}
                >
                  {val}
                </button>
              ))}
            </div>
            <span className="text-[10px] text-white/30 ml-1">CT</span>
          </div>
        </div>
      )}

      {/* Day picker (weekly only) */}
      {showDayPicker && (
        <div>
          <label className="text-xs text-white/50 mb-1.5 block">Days</label>
          <div className="flex gap-1.5">
            {DAYS.map((day, i) => (
              <button
                key={`${day.value}-${i}`}
                type="button"
                onClick={() => toggleDay(day.value)}
                className={cn(
                  'w-8 h-8 rounded-md border text-xs font-medium transition-colors',
                  days.includes(day.value)
                    ? 'bg-blue-500/20 border-blue-500/40 text-blue-400'
                    : 'bg-white/5 border-white/10 text-white/40 hover:text-white/60',
                )}
              >
                {day.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Custom cron input */}
      {showCustomInput && (
        <div>
          <label className="text-xs text-white/50 mb-1.5 block">Cron Expression</label>
          <Input
            value={customCron}
            onChange={e => setCustomCron(e.target.value)}
            placeholder="0 9 * * 1-5"
            className="bg-white/5 border-white/10 text-white font-mono text-xs placeholder:text-white/30"
          />
        </div>
      )}

      {/* Preview */}
      <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-white/[0.03] border border-white/5">
        <span className="text-[10px] text-white/30">Preview:</span>
        <span className="text-xs text-white/60">{prettyCronPreview(cron)}</span>
        <span className="text-[10px] text-white/20 font-mono ml-auto">{cron}</span>
      </div>
    </div>
  );
}
