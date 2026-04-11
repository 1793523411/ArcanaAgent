// ─── Guild Mode Type Definitions ────────────────────────────────

export type AssetType =
  | "repo"
  | "document"
  | "api"
  | "database"
  | "prompt"
  | "config"
  | "mcp_server"
  | "custom";

export interface AgentAsset {
  id: string;
  type: AssetType;
  name: string;
  uri: string;
  description?: string;
  metadata?: Record<string, unknown>;
  addedAt: string;
  lastAccessedAt?: string;
}

export interface AgentStats {
  tasksCompleted: number;
  totalWorkTimeMs: number;
  avgConfidence: number;
  successRate: number;
  lastActiveAt: string;
}

export type AgentStatus = "idle" | "working" | "offline";

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

// ─── Task Types ─────────────────────────────────────────────────

export type TaskStatus = "open" | "bidding" | "in_progress" | "completed" | "failed" | "cancelled";
export type TaskPriority = "low" | "medium" | "high" | "urgent";

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

export interface TaskResult {
  summary: string;
  artifacts?: string[];
  agentNotes?: string;
  memoryCreated?: string[];
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
  blockedBy?: string[];
  result?: TaskResult;
  createdBy: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

// ─── Memory Types ───────────────────────────────────────────────

export type MemoryType = "experience" | "knowledge" | "preference";

export interface AgentMemory {
  id: string;
  type: MemoryType;
  title: string;
  content: string;
  tags: string[];
  relatedAssets?: string[];
  createdAt: string;
  accessCount: number;
  lastAccessedAt?: string;
}

// ─── Event Types ────────────────────────────────────────────────

export type GuildEvent =
  | { type: "task_created"; task: GuildTask }
  | { type: "task_bidding_start"; taskId: string; agents: string[] }
  | { type: "task_assigned"; taskId: string; agentId: string; bid?: TaskBid }
  | { type: "task_completed"; taskId: string; agentId: string; result: TaskResult }
  | { type: "task_failed"; taskId: string; agentId: string; error: string }
  | { type: "task_cancelled"; taskId: string }
  | { type: "agent_status_changed"; agentId: string; status: AgentStatus }
  | { type: "agent_output"; agentId: string; taskId: string; content: string }
  | { type: "agent_reasoning"; agentId: string; taskId: string; content: string }
  | { type: "agent_tool_call"; agentId: string; taskId: string; tool: string; input: unknown }
  | { type: "agent_tool_result"; agentId: string; taskId: string; tool: string; output: string }
  | { type: "agent_memory_settled"; agentId: string; memoryId: string }
  | { type: "group_updated"; groupId: string }
  | { type: "agent_updated"; agentId: string };

// ─── SSE Stream Event ───────────────────────────────────────────

export type GuildStreamEventKind =
  | "task_created"
  | "task_assigned"
  | "task_completed"
  | "task_failed"
  | "task_cancelled"
  | "agent_status"
  | "agent_token"
  | "agent_tool_call"
  | "agent_tool_result"
  | "agent_updated"
  | "group_updated";

export interface GuildStreamEvent {
  type: "guild";
  kind: GuildStreamEventKind;
  data: Record<string, unknown>;
}

// ─── Config ─────────────────────────────────────────────────────

export interface BiddingConfig {
  maxConcurrentTasks: number;
  loadDecayFactor: number;
  assetBonusWeight: number;
  taskTimeoutMs: number;
  minConfidenceThreshold: number;
}

// ─── Create Params ──────────────────────────────────────────────

export interface CreateAgentParams {
  name: string;
  description: string;
  icon?: string;
  color?: string;
  systemPrompt: string;
  allowedTools?: string[];
  modelId?: string;
  assets?: Omit<AgentAsset, "id" | "addedAt">[];
}

export interface CreateGroupParams {
  name: string;
  description: string;
  sharedContext?: string;
}

export interface CreateTaskParams {
  title: string;
  description: string;
  priority?: TaskPriority;
  dependsOn?: string[];
  createdBy?: string;
}
