import { useState } from 'react';
import { Plus, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { WIDGET_DEFS } from '@/lib/widget-registry';
import type { WidgetCategory } from '@/types/widget';

const CATEGORY_LABELS: Record<WidgetCategory, string> = {
  agents: 'Agents',
  brain: 'Brain',
  code: 'Code',
  insights: 'Insights',
  custom: 'Custom',
};

const CATEGORY_ORDER: WidgetCategory[] = ['agents', 'brain', 'code', 'insights', 'custom'];

interface WidgetPickerProps {
  activeTypeIds: Set<string>;
  onToggle: (typeId: string) => void;
}

export default function WidgetPicker({ activeTypeIds, onToggle }: WidgetPickerProps) {
  const [open, setOpen] = useState(false);

  const grouped = CATEGORY_ORDER.reduce<Record<WidgetCategory, typeof WIDGET_DEFS[number][]>>(
    (acc, cat) => {
      acc[cat] = WIDGET_DEFS.filter(d => d.category === cat);
      return acc;
    },
    { agents: [], brain: [], code: [], insights: [], custom: [] }
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus className="w-3.5 h-3.5 mr-1.5" />
          Widgets
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="end">
        <div>
          {CATEGORY_ORDER.map(cat => {
            const defs = grouped[cat];
            if (defs.length === 0) return null;

            return (
              <div key={cat}>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground px-3 pt-2 pb-1">
                  {CATEGORY_LABELS[cat]}
                </p>
                {defs.map(def => {
                  const active = activeTypeIds.has(def.typeId);
                  return (
                    <button
                      key={def.typeId}
                      onClick={() => onToggle(def.typeId)}
                      className="w-full flex items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-white/5 cursor-pointer"
                    >
                      {/* Toggle indicator */}
                      <div
                        className={cn(
                          'w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors',
                          active
                            ? 'bg-primary border-primary'
                            : 'border-muted-foreground/30'
                        )}
                      >
                        {active && <Check className="w-3 h-3 text-primary-foreground" />}
                      </div>
                      <def.icon className={cn(
                        'w-4 h-4 shrink-0 transition-colors',
                        active ? 'text-foreground' : 'text-muted-foreground'
                      )} />
                      <div className="flex-1 min-w-0">
                        <span className={cn(
                          'text-sm font-medium truncate block',
                          !active && 'text-muted-foreground'
                        )}>
                          {def.name}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
