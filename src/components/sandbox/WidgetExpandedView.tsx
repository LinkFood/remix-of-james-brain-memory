/**
 * WidgetExpandedView — Full-size overlay for a single widget.
 *
 * Uses Dialog (radix) to render the widget at expanded size.
 */

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { WIDGET_MAP } from '@/lib/widget-registry';
import { useNavigate } from 'react-router-dom';

interface WidgetExpandedViewProps {
  widgetId: string | null;
  onClose: () => void;
}

export default function WidgetExpandedView({ widgetId, onClose }: WidgetExpandedViewProps) {
  const navigate = useNavigate();

  const def = widgetId ? WIDGET_MAP.get(widgetId) : undefined;

  return (
    <Dialog open={!!widgetId && !!def} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-4xl w-[90vw] h-[80vh] flex flex-col p-0 gap-0">
        {def && (
          <>
            <DialogHeader className="px-4 pt-4 pb-2 shrink-0 flex flex-row items-center gap-2 space-y-0">
              <def.icon className="w-4 h-4 text-muted-foreground" />
              <DialogTitle className="text-sm font-medium">{def.name}</DialogTitle>
            </DialogHeader>
            <div className="flex-1 overflow-auto p-4">
              <def.component
                instanceId={widgetId!}
                compact={false}
                expanded={true}
                onRemove={onClose}
                onNavigate={navigate}
              />
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
