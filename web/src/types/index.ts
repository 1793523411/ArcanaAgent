export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredMessage {
  type: "human" | "ai" | "system";
  content: string;
  tool_calls?: Array<{ name: string; args: string }>;
}

export interface UserConfig {
  enabledSkillIds: string[];
  mcpServers: unknown[];
  availableSkillIds?: string[];
  modelId?: string;
  availableModels?: Array<{ id: string; name: string; provider: string }>;
}

export type StreamingStatus = "thinking" | "tool" | null;
