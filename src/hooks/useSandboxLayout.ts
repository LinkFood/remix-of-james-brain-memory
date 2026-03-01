import { useState, useCallback } from 'react';
import { useDebouncedCallback } from 'use-debounce';
import type { Layout } from 'react-grid-layout';
import type { SandboxLayout, LayoutCommand } from '@/types/widget';
import { getDefaultLayout, WIDGET_MAP, WIDGET_DEFS } from '@/lib/widget-registry';

const STORAGE_KEY = 'jac-sandbox-layout-v1';
const PRESETS_KEY = 'jac-sandbox-presets-v1';

// --- Built-in layout presets ---

export interface LayoutPreset {
  id: string;
  name: string;
  description: string;
  typeIds: string[];
  builtIn?: boolean;
}

const BUILT_IN_PRESETS: LayoutPreset[] = [
  {
    id: 'full',
    name: 'Full Dashboard',
    description: 'All widgets',
    typeIds: WIDGET_DEFS.map(d => d.typeId),
    builtIn: true,
  },
  {
    id: 'minimal',
    name: 'Minimal',
    description: 'Just the essentials',
    typeIds: ['system-pulse', 'insights', 'reminders', 'calendar'],
    builtIn: true,
  },
  {
    id: 'agents',
    name: 'Agent Focus',
    description: 'Agent monitoring',
    typeIds: ['agent-status', 'agent-activity', 'insights', 'code-sessions'],
    builtIn: true,
  },
  {
    id: 'brain',
    name: 'Brain Focus',
    description: 'Memory and entries',
    typeIds: ['brain-entries', 'reminders', 'calendar', 'triage-queue', 'reflections'],
    builtIn: true,
  },
];

function buildLayoutFromTypeIds(typeIds: string[]): SandboxLayout {
  const items: Layout[] = [];
  const typeMap: Record<string, string> = {};
  let y = 0;

  for (let i = 0; i < typeIds.length; i++) {
    const typeId = typeIds[i];
    const def = WIDGET_MAP.get(typeId);
    if (!def) continue;

    const instanceId = typeId;
    const x = def.defaultSize.w === 12 ? 0 : (items.length % 2 === 0 ? 0 : 6);

    items.push({
      i: instanceId,
      x,
      y,
      w: def.defaultSize.w,
      h: def.defaultSize.h,
      minW: def.minSize?.w,
      minH: def.minSize?.h,
    });
    typeMap[instanceId] = typeId;

    if (def.defaultSize.w === 12 || x === 6) {
      y += def.defaultSize.h;
    }
  }

  return { items, typeMap };
}

function loadUserPresets(): LayoutPreset[] {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as LayoutPreset[];
  } catch {
    return [];
  }
}

function saveUserPresets(presets: LayoutPreset[]): void {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
  } catch {}
}

function loadFromStorage(): SandboxLayout | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as SandboxLayout;
  } catch {
    return null;
  }
}

function saveToStorage(layout: SandboxLayout): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Storage full or unavailable — silently ignore
  }
}

export function useSandboxLayout() {
  const [layout, setLayout] = useState<SandboxLayout>(() => {
    return loadFromStorage() ?? getDefaultLayout();
  });

  const debouncedSave = useDebouncedCallback((l: SandboxLayout) => {
    saveToStorage(l);
  }, 300);

  const onLayoutChange = useCallback((newLayout: Layout[]) => {
    setLayout(prev => {
      const updated: SandboxLayout = {
        items: newLayout,
        typeMap: prev.typeMap,
      };
      debouncedSave(updated);
      return updated;
    });
  }, [debouncedSave]);

  const addWidget = useCallback((typeId: string) => {
    const def = WIDGET_MAP.get(typeId);
    if (!def) return;

    const instanceId = `${typeId}-${Date.now()}`;
    const newItem: Layout = {
      i: instanceId,
      x: 0,
      y: 0, // Top of grid — react-grid-layout compacts everything down
      w: def.defaultSize.w,
      h: def.defaultSize.h,
      minW: def.minSize?.w,
      minH: def.minSize?.h,
    };

    setLayout(prev => {
      // Push existing items down to make room
      const shifted = prev.items.map(item => ({
        ...item,
        y: item.y + def.defaultSize.h,
      }));
      const updated: SandboxLayout = {
        items: [newItem, ...shifted],
        typeMap: { ...prev.typeMap, [instanceId]: typeId },
      };
      debouncedSave(updated);
      return updated;
    });
  }, [debouncedSave]);

  const removeWidget = useCallback((instanceId: string) => {
    setLayout(prev => {
      const typeMap = { ...prev.typeMap };
      delete typeMap[instanceId];
      const updated: SandboxLayout = {
        items: prev.items.filter(item => item.i !== instanceId),
        typeMap,
      };
      debouncedSave(updated);
      return updated;
    });
  }, [debouncedSave]);

  const removeWidgetByType = useCallback((typeId: string) => {
    setLayout(prev => {
      const instanceId = Object.entries(prev.typeMap).find(
        ([, tid]) => tid === typeId
      )?.[0];
      if (!instanceId) return prev;

      const typeMap = { ...prev.typeMap };
      delete typeMap[instanceId];
      const updated: SandboxLayout = {
        items: prev.items.filter(item => item.i !== instanceId),
        typeMap,
      };
      debouncedSave(updated);
      return updated;
    });
  }, [debouncedSave]);

  const resetLayout = useCallback(() => {
    const defaultLayout = getDefaultLayout();
    setLayout(defaultLayout);
    saveToStorage(defaultLayout);
  }, []);

  const applyCommands = useCallback((commands: LayoutCommand[]) => {
    for (const command of commands) {
      if (command.action === 'add_widget') {
        addWidget(command.typeId);
      } else if (command.action === 'remove_widget') {
        setLayout(prev => {
          const instanceId = Object.entries(prev.typeMap).find(
            ([, tid]) => tid === command.typeId
          )?.[0];
          if (!instanceId) return prev;

          const typeMap = { ...prev.typeMap };
          delete typeMap[instanceId];
          const updated: SandboxLayout = {
            items: prev.items.filter(item => item.i !== instanceId),
            typeMap,
          };
          debouncedSave(updated);
          return updated;
        });
      } else if (command.action === 'prioritize_widget') {
        setLayout(prev => {
          const instanceId = Object.entries(prev.typeMap).find(
            ([, tid]) => tid === command.typeId
          )?.[0];
          if (!instanceId) return prev;

          const updated: SandboxLayout = {
            items: prev.items.map(item =>
              item.i === instanceId ? { ...item, x: 0, y: 0 } : item
            ),
            typeMap: prev.typeMap,
          };
          debouncedSave(updated);
          return updated;
        });
      } else if (command.action === 'reset_layout') {
        resetLayout();
      }
    }
  }, [addWidget, resetLayout, debouncedSave]);

  const toggleWidget = useCallback((typeId: string) => {
    setLayout(prev => {
      const existingInstance = Object.entries(prev.typeMap).find(
        ([, tid]) => tid === typeId
      )?.[0];

      if (existingInstance) {
        // Remove it
        const typeMap = { ...prev.typeMap };
        delete typeMap[existingInstance];
        const updated: SandboxLayout = {
          items: prev.items.filter(item => item.i !== existingInstance),
          typeMap,
        };
        debouncedSave(updated);
        return updated;
      } else {
        // Add it at the top
        const def = WIDGET_MAP.get(typeId);
        if (!def) return prev;

        const instanceId = `${typeId}-${Date.now()}`;
        const newItem: Layout = {
          i: instanceId,
          x: 0,
          y: 0,
          w: def.defaultSize.w,
          h: def.defaultSize.h,
          minW: def.minSize?.w,
          minH: def.minSize?.h,
        };
        const shifted = prev.items.map(item => ({
          ...item,
          y: item.y + def.defaultSize.h,
        }));
        const updated: SandboxLayout = {
          items: [newItem, ...shifted],
          typeMap: { ...prev.typeMap, [instanceId]: typeId },
        };
        debouncedSave(updated);
        return updated;
      }
    });
  }, [debouncedSave]);

  // --- Presets ---
  const allPresets = [...BUILT_IN_PRESETS, ...loadUserPresets()];

  const loadPreset = useCallback((presetId: string) => {
    const preset = [...BUILT_IN_PRESETS, ...loadUserPresets()].find(p => p.id === presetId);
    if (!preset) return;
    const newLayout = buildLayoutFromTypeIds(preset.typeIds);
    setLayout(newLayout);
    saveToStorage(newLayout);
  }, []);

  const saveCurrentAsPreset = useCallback((name: string) => {
    const typeIds = [...new Set(Object.values(layout.typeMap))];
    const preset: LayoutPreset = {
      id: `custom-${Date.now()}`,
      name,
      description: `${typeIds.length} widgets`,
      typeIds,
    };
    const existing = loadUserPresets();
    saveUserPresets([...existing, preset]);
    return preset;
  }, [layout]);

  const deletePreset = useCallback((presetId: string) => {
    const existing = loadUserPresets();
    saveUserPresets(existing.filter(p => p.id !== presetId));
  }, []);

  return {
    layout,
    onLayoutChange,
    addWidget,
    removeWidget,
    removeWidgetByType,
    toggleWidget,
    resetLayout,
    applyCommands,
    // Presets
    presets: allPresets,
    loadPreset,
    saveCurrentAsPreset,
    deletePreset,
  };
}
