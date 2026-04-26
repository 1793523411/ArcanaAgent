export type AssetType = "repo" | "document" | "api" | "database" | "prompt" | "config" | "mcp_server" | "custom";
export type AssetScope = "agent" | "group";
export type ArtifactStrategy = "isolated" | "collaborative";

export interface ArtifactManifestEntry {
  createdBy: { taskId: string; agentId: string; at: string };
  modifiedBy: Array<{ taskId: string; agentId: string; at: string }>;
}
export type AgentStatus = "idle" | "working" | "offline";
export type TaskStatus =
  | "open"
  | "bidding"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "planning"
  | "blocked";
export type TaskPriority = "low" | "medium" | "high" | "urgent";
export type TaskKind = "requirement" | "subtask" | "adhoc" | "pipeline";

export interface PipelineInputSpec {
  name: string;
  label?: string;
  required?: boolean;
  default?: string;
}

export interface PipelineRetryPolicy {
  max: number;
  backoffMs?: number;
  onExhausted?: "fail" | "fallback" | "skip";
  preferSameAgent?: boolean;
  fallback?: PipelineStepSpec;
}

export type PipelineStepKind = "task" | "branch" | "foreach";

export type Expression = Record<string, unknown>;

export type PipelineArtifactKind = "file" | "url" | "data" | "commit";

export interface PipelineArtifactSpec {
  ref: string;
  label?: string;
  kind?: PipelineArtifactKind;
  description?: string;
  /** Elevates this artifact to the pipeline's final deliverable list. */
  isFinal?: boolean;
}

export interface PipelineStepSpec {
  kind?: PipelineStepKind;
  title: string;
  description: string;
  suggestedSkills?: string[];
  suggestedAgentId?: string;
  dependsOn?: number[];
  priority?: TaskPriority;
  acceptanceCriteria?: string;
  acceptanceAssertions?: AcceptanceAssertion[];
  retry?: PipelineRetryPolicy;
  outputs?: PipelineArtifactSpec[];
  // branch
  when?: Expression;
  then?: PipelineStepSpec[];
  else?: PipelineStepSpec[];
  // foreach
  items?: string;
  as?: string;
  body?: PipelineStepSpec[];
  join?: PipelineStepSpec;
}

export interface PipelineTemplate {
  id: string;
  name: string;
  description?: string;
  inputs?: PipelineInputSpec[];
  steps: PipelineStepSpec[];
  /** Pipeline-level final deliverables. Automatically treated as isFinal=true. */
  outputs?: PipelineArtifactSpec[];
}

export type DeclaredOutputStatus = "pending" | "produced" | "missing";

/** Machine-runnable acceptance assertion — mirrors the server's type. Displayed
 *  read-only in DetailPanel; verified server-side at task completion. */
export type AcceptanceAssertion =
  | { type: "file_exists"; ref: string; description?: string }
  | { type: "file_contains"; ref: string; pattern: string; regex?: boolean; description?: string };

export interface TaskDeclaredOutput {
  ref: string;
  label?: string;
  kind: PipelineArtifactKind;
  description?: string;
  isFinal?: boolean;
  status?: DeclaredOutputStatus;
  producedBy?: { taskId: string; agentId: string; at: string };
}

export interface AgentAsset {
  id: string;
  type: AssetType;
  name: string;
  uri: string;
  description?: string;
  metadata?: Record<string, unknown>;
  addedAt: string;
  lastAccessedAt?: string;
  scope?: AssetScope;
  ownerAgentId?: string;
  tags?: string[];
}

export interface AgentStats {
  tasksCompleted: number;
  tasksFailed?: number;
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
  leadAgentId?: string;
  assets?: AgentAsset[];
  sharedContext?: string;
  artifactStrategy?: ArtifactStrategy;
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

export interface TaskHandoffArtifact {
  kind: "commit" | "file" | "url" | "note";
  ref: string;
  description?: string;
}

export interface TaskHandoff {
  fromAgentId: string;
  toSubtaskId?: string;
  summary: string;
  artifacts: TaskHandoffArtifact[];
  inputsConsumed?: string[];
  openQuestions?: string[];
  createdAt: string;
}

export interface TaskResult {
  summary: string;
  artifacts?: string[];
  agentNotes?: string;
  memoryCreated?: string[];
  handoff?: TaskHandoff;
}

export interface ScoreBreakdown {
  asset: number;
  memory: number;
  skill: number;
  success: number;
  ownerBonus: number;
  assetBonus: number;
  loadPenalty: number;
  threshold: number;
  final: number;
  /** Semantic embedding similarity [0,1]. Present when embedding model is active. */
  embedding?: number;
  /** LLM scorer result [0,10]. Present when LLM scoring is active (small groups). */
  llmScore?: number;
  /** LLM scorer rationale. */
  llmReason?: string;
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
  scoreBreakdown?: ScoreBreakdown;
  via?: "bidding" | "suggested" | "fallback" | "below_threshold";
}

export interface GuildTask {
  id: string;
  groupId: string;
  kind?: TaskKind;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignedAgentId?: string;
  bids?: TaskBid[];
  dependsOn?: string[];
  blockedBy?: string[];
  result?: TaskResult;
  parentTaskId?: string;
  subtaskIds?: string[];
  suggestedSkills?: string[];
  suggestedAgentId?: string;
  acceptanceCriteria?: string;
  acceptanceAssertions?: AcceptanceAssertion[];
  workspaceRef?: string;
  handoff?: TaskHandoff;
  /** Agents that rejected this task; auto-bidding skips them. */
  _rejectedBy?: string[];
  /** Pipeline-declared artifact contracts with live status tracking. */
  declaredOutputs?: TaskDeclaredOutput[];
  /** For kind==="pipeline" parents: id of the expanded template. */
  pipelineId?: string;
  createdBy: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface AgentMemory {
  id: string;
  type: "experience" | "knowledge" | "preference";
  title: string;
  summary?: string;
  content: string;
  tags: string[];
  relatedAssets?: string[];
  sourceTaskId?: string;
  groupId?: string;
  strength: number;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  accessCount: number;
  lastAccessedAt?: string;
  v: 2;
}
