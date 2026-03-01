import { useState } from 'react';
import { Plus } from 'lucide-react';
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
  onAdd: (typeId: string) => void;
}

export default function WidgetPicker({ activeTypeIds, onAdd }: WidgetPickerProps) {
  const [open, setOpen] = useState(false);

  // Group WIDGET_DEFS by category, preserving CATEGORY_ORDER
  const grouped = CATEGORY_ORDER.reduce<Record<WidgetCategory, typeof WIDGET_DEFS[number][]>>(
    (acc, cat) => {
      acc[cat] = WIDGET_DEFS.filter(d => d.category === cat);
      return acc;
    },
    { agents: [], brain: [], code: [], insights: [], custom: [] }
  );

  function handleAdd(typeId: string) {
    onAdd(typeId);
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus className="w-3.5 h-3.5 mr-1.5" />
          Add Widget
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
                      disabled={active}
                      onClick={() => handleAdd(def.typeId)}
                      className={cn(
                        'w-full flex items-start gap-3 px-3 py-2 text-left transition-colors',
                        active
                          ? 'opacity-50 cursor-not-allowed'
                          : 'hover:bg-white/5 cursor-pointer'
                      )}
                    >
                      <def.icon className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium truncate">{def.name}</span>
                          {active && (
                            <span className="text-[10px] text-muted-foreground shrink-0">
                              (active)
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground truncate">{def.description}</p>
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
