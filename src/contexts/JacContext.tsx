/**
 * JacContext — Shares useJacAgent state across all authenticated pages.
 *
 * Instantiated once in AuthLayout, consumed by JacSidebar and any page
 * that needs JAC agent state.
 */

import { createContext, useContext } from 'react';
import type { JacMessage, AgentTask, ActivityLogEntry } from '@/types/agent';

export interface JacContextValue {
  messages: JacMessage[];
  tasks: AgentTask[];
  activityLogs: Map<string, ActivityLogEntry[]>;
  loading: boolean;
  sending: boolean;
  backendReady: boolean;
  sendMessage: (text: string) => void;
  loadTaskLogs: (taskId: string) => void;
  stopTask: (taskId: string) => void;
  stopAllTasks: () => void;
}

export const JacContext = createContext<JacContextValue | null>(null);

export function useJacContext(): JacContextValue {
  const ctx = useContext(JacContext);
  if (!ctx) throw new Error('useJacContext must be used within JacContext.Provider');
  return ctx;
}
