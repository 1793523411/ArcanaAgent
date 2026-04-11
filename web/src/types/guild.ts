export type AssetType = "repo" | "document" | "api" | "database" | "prompt" | "config" | "mcp_server" | "custom";
export type AgentStatus = "idle" | "working" | "offline";
export type TaskStatus = "open" | "bidding" | "in_progress" | "completed" | "failed" | "cancelled";
export type TaskPriority = "low" | "medium" | "high" | "urgent";

export interface AgentAsset {
  id: string;
  type: AssetType;
  name: string;
  uri: string;
  description?: string;
  metadata?: Record<string, unknown>;
  addedAt: string;
}

export interface AgentStats {
  tasksCompleted: number;
  totalWorkTimeMs: number;
  avgConfidence: number;
  successRate: number;
  lastActiveAt: string;
}

export interface GuildAgent {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  systemPrompt: string;
  allowedTools: string[];
  modelId?: string;
  memoryDir: string;
  assets: AgentAsset[];
  skills: string[];
  groupId?: string;
  status: AgentStatus;
  currentTaskId?: string;
  createdAt: string;
  updatedAt: string;
  stats: AgentStats;
}

export interface Group {
  id: string;
  name: string;
  description: string;
  guildId: string;
  agents: string[];
  sharedContext?: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
}

export interface Guild {
  id: string;
  name: string;
  description?: string;
  groups: string[];
  agentPool: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TaskResult {
  summary: string;
  artifacts?: string[];
  agentNotes?: string;
  memoryCreated?: string[];
}

export interface TaskBid {
  agentId: string;
  taskId: string;
  confidence: number;
  reasoning: string;
  estimatedComplexity: "low" | "medium" | "high";
  relevantAssets: string[];
  relevantMemories: string[];
  biddedAt: string;
}

export interface GuildTask {
  id: string;
  groupId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignedAgentId?: string;
  bids?: TaskBid[];
  dependsOn?: string[];
  result?: TaskResult;
  createdBy: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface AgentMemory {
  id: string;
  type: "experience" | "knowledge" | "preference";
  title: string;
  content: string;
  tags: string[];
  createdAt: string;
  accessCount: number;
}
