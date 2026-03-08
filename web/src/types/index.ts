export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/** 附件类型：image 已实现；file 等后续扩展 */
export interface StoredAttachment {
  type: "image" | string;
  mimeType?: string;
  /** base64 内联（旧消息兼容） */
  data?: string;
  /** 对话目录内相对路径，如 attachments/xxx.png */
  file?: string;
  /** 预留：文件名等 */
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
  /** 推理/思考过程（仅 ai，支持思考的模型） */
  reasoningContent?: string;
  tool_calls?: Array<{ name: string; args: string }>;
  /** 工具执行日志，持久化展示用 */
  toolLogs?: ToolLog[];
  attachments?: StoredAttachment[];
}

/** 全局配置的上下文策略；新对话创建时会快照到该对话，之后不随全局变更 */
export interface ContextStrategyConfig {
  strategy: "compress" | "trim";
  /** 截断策略：保留最近 N 条 */
  trimToLast: number;
  /** 当估算 token 超过模型上下文窗口的此比例（%）时触发，如 75 表示 75% */
  tokenThresholdPercent: number;
  /** 压缩策略：保留最近 N 条原文，其余做摘要 */
  compressKeepRecent: number;
}

export interface UserConfig {
  enabledToolIds: string[];
  mcpServers: unknown[];
  availableToolIds?: string[];
  modelId?: string;
  availableModels?: Array<{ id: string; name: string; provider: string }>;
  context?: ContextStrategyConfig;
}

export type StreamingStatus = "thinking" | "tool" | null;

export interface ArtifactMeta {
  name: string;
  path: string;
  size: number;
  mimeType: string;
  modifiedAt: string;
}
