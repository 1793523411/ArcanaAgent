/**
 * 定时任务类型定义（前端）
 */

export type TaskType = 'conversation' | 'webhook' | 'system' | 'skill';

export interface ScheduledTask {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  type: TaskType;
  config: Record<string, any>;
  schedule?: string;
  executeAt?: string;
  dependsOn?: string[];
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
  executionCount: number;
}

export interface TaskExecution {
  id: string;
  taskId: string;
  taskName: string;
  executedAt: string;
  status: 'success' | 'failed' | 'skipped';
  duration: number;
  output?: string;
  error?: string;
  trigger: 'scheduled' | 'manual' | 'dependency';
  conversationId?: string;
}

export interface CreateTaskRequest {
  name: string;
  description?: string;
  type: TaskType;
  config: Record<string, any>;
  schedule?: string;
  executeAt?: string;
  dependsOn?: string[];
  enabled?: boolean;
}

export interface UpdateTaskRequest {
  name?: string;
  description?: string;
  config?: Record<string, any>;
  schedule?: string;
  executeAt?: string;
  dependsOn?: string[];
  enabled?: boolean;
}
