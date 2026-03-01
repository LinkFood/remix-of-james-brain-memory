import { useState } from 'react';
import { RotateCcw, Zap, Save, ChevronDown, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import WidgetPicker from './WidgetPicker';
import type { LayoutPreset } from '@/hooks/useSandboxLayout';

interface SandboxHeaderProps {
  activeTypeIds: Set<string>;
  onToggleWidget: (typeId: string) => void;
  onResetLayout: () => void;
  presets: LayoutPreset[];
  onLoadPreset: (presetId: string) => void;
  onSavePreset: (name: string) => void;
  onDeletePreset: (presetId: string) => void;
}

const SandboxHeader = ({
  activeTypeIds,
  onToggleWidget,
  onResetLayout,
  presets,
  onLoadPreset,
  onSavePreset,
  onDeletePreset,
}: SandboxHeaderProps) => {
  const [presetOpen, setPresetOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [showSaveInput, setShowSaveInput] = useState(false);

  const handleSave = () => {
    if (!saveName.trim()) return;
    onSavePreset(saveName.trim());
    setSaveName('');
    setShowSaveInput(false);
  };

  return (
    <header className="border-b border-border bg-card/50 backdrop-blur-sm shrink-0 z-40">
      <div className="flex items-center gap-3 px-3 h-10">
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4 text-primary/60" />
          <span className="text-sm font-semibold">JAC Dashboard</span>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* Presets dropdown */}
          <Popover open={presetOpen} onOpenChange={setPresetOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 text-xs gap-1">
                <ChevronDown className="w-3 h-3" />
                Layouts
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-56 p-0" align="end">
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground px-3 pt-2 pb-1">
                  Presets
                </p>
                {presets.map(preset => (
                  <div
                    key={preset.id}
                    className="flex items-center px-3 py-1.5 hover:bg-white/5 transition-colors"
                  >
                    <button
                      className="flex-1 text-left min-w-0"
                      onClick={() => {
                        onLoadPreset(preset.id);
                        setPresetOpen(false);
                      }}
                    >
                      <span className="text-sm font-medium block truncate">{preset.name}</span>
                      <span className="text-[10px] text-muted-foreground">{preset.description}</span>
                    </button>
                    {!preset.builtIn && (
                      <button
                        onClick={() => onDeletePreset(preset.id)}
                        className="p-1 rounded hover:bg-white/10 text-muted-foreground hover:text-red-400 transition-colors shrink-0 ml-2"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                ))}

                <div className="border-t border-border mt-1 pt-1 px-3 pb-2">
                  {showSaveInput ? (
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        value={saveName}
                        onChange={e => setSaveName(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && handleSave()}
                        placeholder="Layout name..."
                        className="flex-1 text-xs bg-transparent border border-border rounded px-2 py-1 outline-none focus:border-primary"
                        autoFocus
                      />
                      <Button variant="ghost" size="sm" className="h-6 text-xs px-2" onClick={handleSave}>
                        Save
                      </Button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setShowSaveInput(true)}
                      className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
                    >
                      <Save className="w-3 h-3" />
                      Save current layout
                    </button>
                  )}
                </div>
              </div>
            </PopoverContent>
          </Popover>

          {/* Widget toggle picker */}
          <WidgetPicker activeTypeIds={activeTypeIds} onToggle={onToggleWidget} />

          {/* Reset */}
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
