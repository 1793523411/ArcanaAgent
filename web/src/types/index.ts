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

export interface StoredMessage {
  type: "human" | "ai" | "system";
  content: string;
  /** 产出该条 AI 回复的模型 ID */
  modelId?: string;
  reasoningContent?: string;
  tool_calls?: Array<{ name: string; args: string }>;
  toolLogs?: ToolLog[];
  attachments?: StoredAttachment[];
}

export interface ContextStrategyConfig {
  strategy: "compress" | "trim";
  trimToLast: number;
  tokenThresholdPercent: number;
  compressKeepRecent: number;
}

export interface McpServerConfig {
  name: string;
  transport: "stdio";
  command: string;
  args: string[];
}

export interface McpStatusItem {
  name: string;
  connected: boolean;
  toolCount: number;
}

export interface UserConfig {
  enabledToolIds: string[];
  mcpServers: McpServerConfig[];
  availableToolIds?: string[];
  modelId?: string;
  availableModels?: Array<{ id: string; name: string; provider: string }>;
  context?: ContextStrategyConfig;
  mcpStatus?: McpStatusItem[];
}

export type StreamingStatus = "thinking" | "tool" | null;

export interface ArtifactMeta {
  name: string;
  path: string;
  size: number;
  mimeType: string;
  modifiedAt: string;
}
