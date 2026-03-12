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
  /** 单次执行超时（毫秒）*/
  timeoutMs?: number;
  /** 失败后重试次数 */
  retries?: number;
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
  /** 单次执行超时（毫秒），不传则不设超时 */
  timeoutMs?: number;
  /** 失败后重试次数，不传则 0 */
  retries?: number;
}

export interface UpdateTaskRequest {
  name?: string;
  description?: string;
  config?: Record<string, any>;
  schedule?: string;
  executeAt?: string;
  dependsOn?: string[];
  enabled?: boolean;
  timeoutMs?: number;
  retries?: number;
}
