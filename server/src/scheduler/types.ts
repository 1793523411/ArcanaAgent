/**
 * 定时任务类型定义
 */

// ─── 任务类型 ─────────────────────────────────────────────

export type TaskType =
  | 'conversation'  // 对话任务：向指定对话发送消息
  | 'webhook'       // Webhook 任务：发送 HTTP 请求（飞书等）
  | 'system'        // 系统任务：清理、备份等
  | 'skill';        // Skill 任务：执行特定 Skill

// ─── 任务配置 ─────────────────────────────────────────────

export interface TaskConfigConversation {
  message: string;
  /** 预创建的对话ID（仅内部使用）*/
  _preCreatedConversationId?: string;
}

export interface TaskConfigWebhook {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  /** 飞书群聊机器人专用 */
  feishu?: {
    msgType: 'text' | 'interactive';
    content: string | Record<string, unknown>;
  };
  /** 是否使用模型输出作为内容 */
  useModelOutput?: boolean;
  /** 提示词（当 useModelOutput 为 true 时需要）*/
  prompt?: string;
  /** 预创建的对话ID（仅内部使用）*/
  _preCreatedConversationId?: string;
}

export interface TaskConfigSystem {
  action: 'cleanup_logs' | 'cleanup_conversations' | 'backup';
  params?: Record<string, unknown>;
}

export interface TaskConfigSkill {
  skillName: string;
  params?: Record<string, unknown>;
  /** 预创建的对话ID（仅内部使用）*/
  _preCreatedConversationId?: string;
}

export type TaskConfig =
  | TaskConfigConversation
  | TaskConfigWebhook
  | TaskConfigSystem
  | TaskConfigSkill;

// ─── 定时任务 ─────────────────────────────────────────────

export interface ScheduledTask {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;

  /** 任务类型 */
  type: TaskType;

  /** 任务配置 */
  config: TaskConfig;

  /**
   * Cron 表达式（周期任务）
   * 例如: "0 8 * * *" 表示每天早上 8 点
   * 格式: 秒 分 时 日 月 周
   */
  schedule?: string;

  /**
   * 一次性任务执行时间（UTC）
   * 如果设置，则忽略 schedule
   */
  executeAt?: string;

  /**
   * 任务依赖 - 需要等待这些任务完成才能执行
   */
  dependsOn?: string[];

  /** 创建时间 */
  createdAt: string;

  /** 更新时间 */
  updatedAt: string;

  /** 最后执行时间 */
  lastRunAt?: string;

  /** 下次执行时间（仅周期任务）*/
  nextRunAt?: string;

  /** 执行次数 */
  executionCount: number;
}

// ─── 任务执行历史 ─────────────────────────────────────────

export interface TaskExecution {
  id: string;
  taskId: string;
  taskName: string;
  executedAt: string;
  status: 'success' | 'failed' | 'skipped';
  duration: number; // 毫秒
  output?: string;
  error?: string;
  /** 触发方式 */
  trigger: 'scheduled' | 'manual' | 'dependency';
  /** 关联的会话ID（如果任务与会话相关）*/
  conversationId?: string;
}

// ─── 存储格式 ─────────────────────────────────────────────

export interface TasksStorage {
  tasks: ScheduledTask[];
  version: number;
}

export interface TaskHistoryStorage {
  executions: TaskExecution[];
  version: number;
}

// ─── API 请求/响应 ─────────────────────────────────────────

export interface CreateTaskRequest {
  name: string;
  description?: string;
  type: TaskType;
  config: TaskConfig;
  schedule?: string;
  executeAt?: string;
  dependsOn?: string[];
  enabled?: boolean;
}

export interface UpdateTaskRequest {
  name?: string;
  description?: string;
  config?: TaskConfig;
  schedule?: string;
  executeAt?: string;
  dependsOn?: string[];
  enabled?: boolean;
}

export interface TaskListResponse {
  tasks: ScheduledTask[];
  total: number;
}

export interface TaskHistoryResponse {
  executions: TaskExecution[];
  total: number;
}
