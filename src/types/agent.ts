export type TaskType = 'search' | 'save' | 'enrich' | 'report' | 'general' | 'research' | 'monitor';
export type TaskStatus = 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface AgentTask {
  id: string;
  user_id: string;
  parent_task_id: string | null;
  type: TaskType;
  status: TaskStatus;
  intent: string | null;
  agent: string | null;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: string | null;
  slack_notified: boolean;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
}

export interface JacMessage {
  role: 'user' | 'assistant';
  content: string;
  taskIds?: string[];
  timestamp: string;
}

export type LogStatus = 'started' | 'completed' | 'failed' | 'skipped';

export interface ActivityLogEntry {
  id: string;
  task_id: string;
  user_id: string;
  agent: string;
  step: string;
  status: LogStatus;
  detail: Record<string, unknown>;
  duration_ms: number | null;
  created_at: string;
}
