export type ConversationMode = "default" | "team";
export type AgentRole = "planner" | "coder" | "reviewer" | "tester";

export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  mode?: ConversationMode;
}

export interface StoredAttachment {
  type: "image" | string;
  mimeType?: string;
  data?: string;
  file?: string;
  name?: string;
}

export interface ToolLog {
  name: string;
  input: string;
  output: string;
}

export interface PlanLog {
  phase: "created" | "running" | "completed";
  steps: Array<{
    title: string;
    acceptance_checks: string[];
    evidences: string[];
    completed: boolean;
  }>;
  currentStep: number;
  toolName?: string;
}

export interface ApprovalLog {
  requestId: string;
  operationType: string;
  operationDescription: string;
  approved: boolean;
  createdAt: string;
}

export interface SubagentLog {
  subagentId: string;
  /** 语义化展示名（由任务 prompt 派生） */
  subagentName?: string;
  /** 角色类型（team 模式） */
  role?: AgentRole;
  /** 依赖的已完成子 agent ID（team 模式多轮协作） */
  dependsOn?: string[];
  depth: number;
  prompt: string;
  phase: "started" | "completed" | "failed";
  status: StreamingStatus;
  content: string;
  reasoning: string;
  toolLogs: ToolLog[];
  plan?: PlanLog;
  /** 审批记录（team 模式） */
  approvalLogs?: ApprovalLog[];
  summary?: string;
  error?: string;
}

export interface StoredMessage {
  type: "human" | "ai" | "system" | "tool";
  content: string;
  /** 产出该条 AI 回复的模型 ID */
  modelId?: string;
  reasoningContent?: string;
  tool_calls?: Array<{ name: string; args: string }>;
  /** 工具消息的 ID（仅 tool 类型） */
  tool_call_id?: string;
  /** 工具名称（仅 tool 类型） */
  name?: string;
  toolLogs?: ToolLog[];
  plan?: PlanLog;
  subagents?: SubagentLog[];
  attachments?: StoredAttachment[];
  /** 本轮对话 token 消耗（仅 ai） */
  usageTokens?: { promptTokens: number; completionTokens: number; totalTokens: number };
  contextUsage?: {
    strategy: "full" | "trim" | "compress";
    contextWindow: number;
    thresholdTokens: number;
    tokenThresholdPercent: number;
    contextMessageCount: number;
    estimatedTokens?: number;
    promptTokens?: number;
    trimToLast?: number;
    olderCount?: number;
    recentCount?: number;
  };
}

export interface ContextStrategyConfig {
  strategy: "compress" | "trim";
  trimToLast: number;
  tokenThresholdPercent: number;
  compressKeepRecent: number;
  saveToolMessages?: boolean;
}

export type McpServerConfig =
  | {
      name: string;
      transport: "stdio";
      command: string;
      args: string[];
      env?: Record<string, string>;
    }
  | {
      name: string;
      transport: "streamablehttp";
      url: string;
      headers?: Record<string, string>;
    };

export interface McpStatusItem {
  name: string;
  connected: boolean;
  toolCount: number;
}

export interface PromptTemplate {
  id: string;
  name: string;
  content: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlanningConfig {
  enabled: boolean;
  streamProgress: boolean;
}

export interface UserConfig {
  enabledToolIds: string[];
  mcpServers: McpServerConfig[];
  availableToolIds?: string[];
  modelId?: string;
  availableModels?: Array<{ id: string; name: string; provider: string; contextWindow: number; maxTokens: number }>;
  context?: ContextStrategyConfig;
  planning?: PlanningConfig;
  mcpStatus?: McpStatusItem[];
  templates?: PromptTemplate[];
}

export type StreamingStatus = "thinking" | "tool" | null;

export interface ArtifactMeta {
  name: string;
  path: string;
  size: number;
  mimeType: string;
  modifiedAt: string;
}
