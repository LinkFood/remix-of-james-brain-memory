/**
 * useSidebarState — Persists JAC sidebar collapsed/expanded state to localStorage.
 */

import { useState, useCallback } from 'react';

const STORAGE_KEY = 'jac-sidebar-state';
const DEFAULT_WIDTH = 320;

interface SidebarState {
  collapsed: boolean;
  width: number;
}

function loadState(): SidebarState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { collapsed: false, width: DEFAULT_WIDTH };
    return JSON.parse(raw) as SidebarState;
  } catch {
    return { collapsed: false, width: DEFAULT_WIDTH };
  }
}

function saveState(state: SidebarState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore storage errors
  }
}

export function useSidebarState() {
  const [state, setState] = useState<SidebarState>(loadState);

  const toggleCollapsed = useCallback(() => {
    setState(prev => {
      const next = { ...prev, collapsed: !prev.collapsed };
      saveState(next);
      return next;
    });
  }, []);

  const setCollapsed = useCallback((collapsed: boolean) => {
    setState(prev => {
      const next = { ...prev, collapsed };
      saveState(next);
      return next;
    });
  }, []);

  const setSidebarWidth = useCallback((width: number) => {
    setState(prev => {
      const next = { ...prev, width };
      saveState(next);
      return next;
    });
  }, []);

  return {
    isCollapsed: state.collapsed,
    sidebarWidth: state.width,
    toggleCollapsed,
    setCollapsed,
    setSidebarWidth,
  };
}
