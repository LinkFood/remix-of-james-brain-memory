import { useState, useEffect, cloneElement, isValidElement } from 'react';
import { GripVertical, Minimize2, Maximize2, X, Expand } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { WidgetDefinition } from '@/types/widget';

interface WidgetChromeProps {
  definition: WidgetDefinition;
  instanceId: string;
  onRemove: () => void;
  onExpand?: (instanceId: string) => void;
  lastUpdated?: number | null;
  children: React.ReactNode;
}

function formatElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 5) return 'Live';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

function statusColor(lastUpdated: number | null | undefined): string {
  if (lastUpdated == null) return 'bg-white/20'; // gray — static
  const elapsed = Date.now() - lastUpdated;
  if (elapsed < 5 * 60 * 1000) return 'bg-emerald-400'; // green — recent
  return 'bg-amber-400'; // amber — stale
}

export default function WidgetChrome({
  definition,
  instanceId,
  onRemove,
  onExpand,
  lastUpdated,
  children,
}: WidgetChromeProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [elapsedLabel, setElapsedLabel] = useState('');
  const [activeTab, setActiveTab] = useState(definition.tabs?.[0]?.id ?? '');

  // Update elapsed label every 30s
  useEffect(() => {
    function update() {
      if (lastUpdated != null) {
        setElapsedLabel(formatElapsed(Date.now() - lastUpdated));
      }
    }
    update();
    const interval = setInterval(update, 30_000);
    return () => clearInterval(interval);
  }, [lastUpdated]);

  // Inject activeTab / onTabChange into children if widget supports tabs
  const enrichedChildren =
    definition.tabs && isValidElement(children)
      ? cloneElement(children as React.ReactElement<any>, {
          activeTab,
          onTabChange: setActiveTab,
        })
      : children;

  return (
    <div className="h-full flex flex-col rounded-xl bg-white/[0.03] backdrop-blur-sm border border-white/10 overflow-hidden">
      {/* Title bar / drag handle */}
      <div className={cn(
        'drag-handle',
        'flex items-center gap-2 px-3 h-8 border-b border-white/5 shrink-0 cursor-grab'
      )}>
        <GripVertical className="w-3 h-3 text-muted-foreground/50" />

        {/* Status dot */}
        <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', statusColor(lastUpdated))} />

        <definition.icon className="w-3 h-3 text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground truncate flex-1">
          {definition.name}
        </span>

        {onExpand && (
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 text-muted-foreground/50 hover:text-muted-foreground"
            onClick={() => onExpand(instanceId)}
          >
            <Expand className="w-3 h-3" />
          </Button>
        )}

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

      {/* Tab bar (if widget defines tabs) */}
      {!collapsed && definition.tabs && definition.tabs.length > 0 && (
        <div className="flex items-center gap-1 px-3 h-7 border-b border-white/5 shrink-0">
          {definition.tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'text-[10px] px-2 py-0.5 rounded transition-colors',
                activeTab === tab.id
                  ? 'bg-white/10 text-white/80'
                  : 'text-white/40 hover:text-white/60'
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {/* Content area */}
      {!collapsed && (
        <div className="flex-1 overflow-auto p-3">
          {enrichedChildren}
        </div>
      )}

      {/* Live timestamp footer */}
      {!collapsed && lastUpdated != null && (
        <div className="px-3 py-1 border-t border-white/5 shrink-0">
          <span className="text-[9px] text-white/25">{elapsedLabel}</span>
        </div>
      )}
    </div>
  );
}
