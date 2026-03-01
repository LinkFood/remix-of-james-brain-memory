import { useState } from 'react';
import { GripVertical, Minimize2, Maximize2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { WidgetDefinition } from '@/types/widget';

interface WidgetChromeProps {
  definition: WidgetDefinition;
  instanceId: string;
  onRemove: () => void;
  children: React.ReactNode;
}

export default function WidgetChrome({
  definition,
  instanceId: _instanceId,
  onRemove,
  children,
}: WidgetChromeProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="h-full flex flex-col rounded-xl bg-white/[0.03] backdrop-blur-sm border border-white/10 overflow-hidden">
      {/* Title bar / drag handle */}
      <div className={cn(
        'drag-handle',
        'flex items-center gap-2 px-3 h-8 border-b border-white/5 shrink-0 cursor-grab'
      )}>
        <GripVertical className="w-3 h-3 text-muted-foreground/50" />
        <definition.icon className="w-3 h-3 text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground truncate flex-1">
          {definition.name}
        </span>

        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 text-muted-foreground/50 hover:text-muted-foreground"
          onClick={() => setCollapsed(c => !c)}
        >
          {collapsed
            ? <Maximize2 className="w-3 h-3" />
            : <Minimize2 className="w-3 h-3" />
          }
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 text-muted-foreground/50 hover:text-red-400"
          onClick={onRemove}
        >
          <X className="w-3 h-3" />
        </Button>
      </div>

      {/* Content area */}
      {!collapsed && (
        <div className="flex-1 overflow-auto p-3">
          {children}
        </div>
      )}
    </div>
  );
}
