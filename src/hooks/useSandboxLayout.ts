import { useState, useCallback, useEffect } from 'react';
import { useDebouncedCallback } from 'use-debounce';
import type { Layout } from 'react-grid-layout';
import type { SandboxLayout, LayoutCommand } from '@/types/widget';
import { getDefaultLayout, WIDGET_MAP } from '@/lib/widget-registry';

const STORAGE_KEY = 'jac-sandbox-layout-v1';

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
      y: Infinity,
      w: def.defaultSize.w,
      h: def.defaultSize.h,
      minW: def.minSize?.w,
      minH: def.minSize?.h,
    };

    setLayout(prev => {
      const updated: SandboxLayout = {
        items: [...prev.items, newItem],
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

  return {
    layout,
    onLayoutChange,
    addWidget,
    removeWidget,
    resetLayout,
    applyCommands,
  };
}
