export type TaskType = 'search' | 'save' | 'enrich' | 'report' | 'general' | 'research' | 'monitor' | 'code';
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

export interface CodeProject {
  id: string;
  user_id: string;
  name: string;
  repo_full_name: string;
  default_branch: string;
  description: string | null;
  tech_stack: string[] | null;
  last_synced_at: string | null;
  file_tree_cache: string[] | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CodeSession {
  id: string;
  user_id: string;
  project_id: string;
  task_id: string | null;
  branch_name: string;
  status: 'active' | 'completed' | 'failed' | 'awaiting_ci';
  intent: string;
  files_read: string[] | null;
  files_written: string[] | null;
  commits: string[] | null;
  pr_number: number | null;
  pr_url: string | null;
  ci_status: string | null;
  iteration_count: number;
  max_iterations: number;
  context: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}
