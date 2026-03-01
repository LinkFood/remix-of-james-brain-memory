/**
 * Widget system types for the Sandbox dashboard.
 *
 * WidgetProps is the contract every widget component implements.
 * WidgetDefinition is the registry entry for each widget type.
 * LayoutCommand is how JAC modifies the grid programmatically.
 */

import type { LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';
import type { Layout } from 'react-grid-layout';

/** Props injected into every widget component by WidgetChrome */
export interface WidgetProps {
  instanceId: string;
  compact: boolean;
  onRemove: () => void;
  onNavigate: (path: string) => void;
}

export type WidgetCategory = 'agents' | 'brain' | 'code' | 'insights' | 'custom';

/** Registry entry — one per widget type */
export interface WidgetDefinition {
  typeId: string;
  name: string;
  description: string;
  icon: LucideIcon;
  defaultSize: { w: number; h: number };
  minSize?: { w: number; h: number };
  component: ComponentType<WidgetProps>;
  category: WidgetCategory;
}

/** Persisted layout state */
export interface SandboxLayout {
  /** react-grid-layout Layout items — each has i (instanceId), x, y, w, h */
  items: Layout[];
  /** Map of instanceId -> typeId */
  typeMap: Record<string, string>;
}

/** Commands JAC can issue to modify the grid */
export type LayoutCommand =
  | { action: 'add_widget'; typeId: string }
  | { action: 'remove_widget'; typeId: string }
  | { action: 'prioritize_widget'; typeId: string }
  | { action: 'reset_layout' };
