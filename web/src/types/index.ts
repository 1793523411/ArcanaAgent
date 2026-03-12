export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
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

export interface SubagentLog {
  subagentId: string;
  /** 语义化展示名（由任务 prompt 派生） */
  subagentName?: string;
  depth: number;
  prompt: string;
  phase: "started" | "completed" | "failed";
  status: StreamingStatus;
  content: string;
  reasoning: string;
  toolLogs: ToolLog[];
  plan?: PlanLog;
  summary?: string;
  error?: string;
}

export interface StoredMessage {
  type: "human" | "ai" | "system";
  content: string;
  /** 产出该条 AI 回复的模型 ID */
  modelId?: string;
  reasoningContent?: string;
  tool_calls?: Array<{ name: string; args: string }>;
  toolLogs?: ToolLog[];
  plan?: PlanLog;
  subagents?: SubagentLog[];
  attachments?: StoredAttachment[];
  /** 本轮对话 token 消耗（仅 ai） */
  usageTokens?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export interface ContextStrategyConfig {
  strategy: "compress" | "trim";
  trimToLast: number;
  tokenThresholdPercent: number;
  compressKeepRecent: number;
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
  availableModels?: Array<{ id: string; name: string; provider: string }>;
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
