/**
 * Widget Registry — single source of truth for all widget types.
 *
 * Mirrors the pattern from src/lib/agents.ts.
 * To add a new widget: create the component, add an entry here.
 */

import {
  Activity, Users, Brain, Bell, GitBranch,
  Lightbulb, Gauge, AlertTriangle,
} from 'lucide-react';
import type { WidgetDefinition, SandboxLayout } from '@/types/widget';
import type { Layout } from 'react-grid-layout';

import AgentActivityWidget from '@/components/sandbox/widgets/AgentActivityWidget';
import AgentStatusWidget from '@/components/sandbox/widgets/AgentStatusWidget';
import BrainEntriesWidget from '@/components/sandbox/widgets/BrainEntriesWidget';
import RemindersWidget from '@/components/sandbox/widgets/RemindersWidget';
import CodeSessionsWidget from '@/components/sandbox/widgets/CodeSessionsWidget';
import InsightsWidget from '@/components/sandbox/widgets/InsightsWidget';
import SystemPulseWidget from '@/components/sandbox/widgets/SystemPulseWidget';
import TriageQueueWidget from '@/components/sandbox/widgets/TriageQueueWidget';

export const WIDGET_DEFS: WidgetDefinition[] = [
  {
    typeId: 'system-pulse',
    name: 'System Pulse',
    description: 'Greeting, briefing, and live stats',
    icon: Gauge,
    defaultSize: { w: 12, h: 3 },
    minSize: { w: 6, h: 2 },
    component: SystemPulseWidget,
    category: 'insights',
  },
  {
    typeId: 'agent-status',
    name: 'Agent Status',
    description: 'Live status pills for all 5 agents',
    icon: Users,
    defaultSize: { w: 6, h: 2 },
    minSize: { w: 3, h: 2 },
    component: AgentStatusWidget,
    category: 'agents',
  },
  {
    typeId: 'agent-activity',
    name: 'Agent Activity',
    description: 'Recent completed agent tasks',
    icon: Activity,
    defaultSize: { w: 6, h: 3 },
    minSize: { w: 3, h: 2 },
    component: AgentActivityWidget,
    category: 'agents',
  },
  {
    typeId: 'insights',
    name: 'Insights',
    description: 'AI-generated signals and patterns',
    icon: Lightbulb,
    defaultSize: { w: 6, h: 3 },
    minSize: { w: 3, h: 2 },
    component: InsightsWidget,
    category: 'insights',
  },
  {
    typeId: 'reminders',
    name: 'Reminders',
    description: 'Today and overdue reminders',
    icon: Bell,
    defaultSize: { w: 6, h: 3 },
    minSize: { w: 3, h: 2 },
    component: RemindersWidget,
    category: 'brain',
  },
  {
    typeId: 'brain-entries',
    name: 'Brain Entries',
    description: 'Recent entries from your brain',
    icon: Brain,
    defaultSize: { w: 6, h: 4 },
    minSize: { w: 3, h: 2 },
    component: BrainEntriesWidget,
    category: 'brain',
  },
  {
    typeId: 'code-sessions',
    name: 'Code Sessions',
    description: 'Latest code agent sessions',
    icon: GitBranch,
    defaultSize: { w: 6, h: 3 },
    minSize: { w: 3, h: 2 },
    component: CodeSessionsWidget,
    category: 'code',
  },
  {
    typeId: 'triage-queue',
    name: 'Triage Queue',
    description: 'Items needing attention',
    icon: AlertTriangle,
    defaultSize: { w: 6, h: 4 },
    minSize: { w: 3, h: 2 },
    component: TriageQueueWidget,
    category: 'brain',
  },
];

/** Map of typeId -> WidgetDefinition for fast lookup */
export const WIDGET_MAP = new Map(WIDGET_DEFS.map(w => [w.typeId, w]));

/** Generate the default layout with all widgets */
export function getDefaultLayout(): SandboxLayout {
  const items: Layout[] = [];
  const typeMap: Record<string, string> = {};

  let y = 0;
  for (const def of WIDGET_DEFS) {
    const instanceId = def.typeId; // default layout uses typeId as instanceId
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
    typeMap[instanceId] = def.typeId;

    // Advance y when we fill a row or widget is full-width
    if (def.defaultSize.w === 12 || x === 6) {
      y += def.defaultSize.h;
    }
  }

  return { items, typeMap };
}
