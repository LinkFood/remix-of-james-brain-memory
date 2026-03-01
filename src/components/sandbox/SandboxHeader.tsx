import { RotateCcw, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import WidgetPicker from './WidgetPicker';

interface SandboxHeaderProps {
  activeTypeIds: Set<string>;
  onAddWidget: (typeId: string) => void;
  onResetLayout: () => void;
}

const SandboxHeader = ({ activeTypeIds, onAddWidget, onResetLayout }: SandboxHeaderProps) => {
  return (
    <header className="border-b border-border bg-card/50 backdrop-blur-sm shrink-0 z-40">
      <div className="flex items-center gap-3 px-3 h-10">
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4 text-primary/60" />
          <span className="text-sm font-semibold">JAC Sandbox</span>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <WidgetPicker activeTypeIds={activeTypeIds} onAdd={onAddWidget} />
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="Reset layout"
            onClick={onResetLayout}
          >
            <RotateCcw className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </header>
  );
};

export default SandboxHeader;
