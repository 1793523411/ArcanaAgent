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

export type AssetScope = "agent" | "group";

export type ArtifactStrategy = "isolated" | "collaborative";

export interface ArtifactManifestEntry {
  createdBy: { taskId: string; agentId: string; at: string };
  modifiedBy: Array<{ taskId: string; agentId: string; at: string }>;
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
  /** "agent" = private to an agent; "group" = shared resource pool on the group. */
  scope?: AssetScope;
  /** Primary responsible agent for a group-scoped asset. */
  ownerAgentId?: string;
  /** Domain/tech tags used by the planner and bidding for targeting. */
  tags?: string[];
}

export interface AgentStats {
  tasksCompleted: number;
  tasksFailed: number;
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
  /** Optional lead agent used by the planner when decomposing requirements. */
  leadAgentId?: string;
  /** Group-level shared resource pool (repos, specs, docs). */
  assets?: AgentAsset[];
  sharedContext?: string;
  /** Controls how task artifacts are organized: "isolated" = per-task dirs, "collaborative" = shared root with manifest. */
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

// ─── Task Types ─────────────────────────────────────────────────

export type TaskStatus =
  | "open"
  | "bidding"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "planning"   // requirement waiting for lead decomposition
  | "blocked";   // subtask waiting for upstream deps
export type TaskPriority = "low" | "medium" | "high" | "urgent";
export type TaskKind = "requirement" | "subtask" | "adhoc" | "pipeline";

export interface TaskHandoffArtifact {
  kind: "commit" | "file" | "url" | "note";
  ref: string;
  description?: string;
}

/** Runtime state of a declared output — tracked as the pipeline runs. */
export type DeclaredOutputStatus = "pending" | "produced" | "missing";

/**
 * Structured artifact declaration threaded from `PipelineStepSpec.outputs` /
 * `PipelineTemplate.outputs` onto the task itself. Gives the scheduler +
 * UI a contract: this task is expected to produce these named deliverables,
 * and we can verify against the actual handoff after completion.
 */
export interface TaskDeclaredOutput {
  ref: string;
  label?: string;
  kind: "file" | "url" | "data" | "commit";
  description?: string;
  /** Surfaced as a top-level deliverable of the pipeline (not just intermediate). */
  isFinal?: boolean;
  /** Runtime status — updated when the producing task completes + hands off. */
  status?: DeclaredOutputStatus;
  /** Who/when produced this. Only set when status === "produced". */
  producedBy?: { taskId: string; agentId: string; at: string };
}

export interface TaskHandoffMemory {
  type: "knowledge" | "preference";
  title: string;
  content: string;
  tags?: string[];
}

export interface TaskHandoff {
  fromAgentId: string;
  /** Target subtask id if directed; undefined means parent/lead aggregation. */
  toSubtaskId?: string;
  summary: string;
  artifacts: TaskHandoffArtifact[];
  inputsConsumed?: string[];
  openQuestions?: string[];
  memories?: TaskHandoffMemory[];
  createdAt: string;
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
  /** Detailed per-dimension score breakdown for UI/debug. */
  scoreBreakdown?: ScoreBreakdown;
  /** "bidding" = won via normal path, "fallback" = round-robin idle rescue,
   *  "below_threshold" = evaluated candidate that didn't clear the bar (kept
   *  around so the UI can explain *why* an agent wasn't chosen). */
  via?: "bidding" | "fallback" | "below_threshold";
}

export interface TaskResult {
  summary: string;
  artifacts?: string[];
  agentNotes?: string;
  memoryCreated?: string[];
  handoff?: TaskHandoff;
  /** Free-form key/value payload extracted from the agent's ```pipeline-output``` fence.
   *  Consumed by branch/foreach expansion in downstream pipeline steps. */
  structuredOutput?: Record<string, unknown>;
}

export interface TaskRetryFallback {
  title: string;
  description: string;
  suggestedSkills?: string[];
  suggestedAgentId?: string;
  acceptanceCriteria?: string;
}

export interface TaskRetryPolicy {
  max: number;
  backoffMs?: number;
  onExhausted?: "fail" | "fallback" | "skip";
  preferSameAgent?: boolean;
  /** Pre-substituted fallback task spec; applied when onExhausted="fallback". */
  fallback?: TaskRetryFallback;
}

/** Machine-runnable acceptance assertions — verified by the harness at
 *  completion time, *in addition* to the human-readable acceptanceCriteria
 *  prompt text. A task that fails its assertions is rejected from the
 *  completed state even if the agent claims done.
 *
 *  - file_exists: the ref must exist as a regular file under the task's cwd.
 *  - file_contains: the ref must exist AND its text contents must contain
 *    the given substring (or match the given regex if `regex: true`).
 */
export type AcceptanceAssertion =
  | { type: "file_exists"; ref: string; description?: string }
  | { type: "file_contains"; ref: string; pattern: string; regex?: boolean; description?: string };

export interface GuildTask {
  id: string;
  groupId: string;
  /** Defaults to "adhoc" for backward compatibility with pre-collab tasks. */
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
  /** Collaboration fields */
  parentTaskId?: string;
  subtaskIds?: string[];
  suggestedSkills?: string[];
  suggestedAgentId?: string;
  /** Human-readable guidance surfaced to the agent in its prompt. */
  acceptanceCriteria?: string;
  /** Machine-runnable assertions the harness enforces on completion —
   *  orthogonal to acceptanceCriteria (which is prose for the agent). */
  acceptanceAssertions?: AcceptanceAssertion[];
  /** Agents that rejected this task — excluded from future bidding. */
  _rejectedBy?: string[];
  /** Path of the workspace markdown this task lives under. */
  workspaceRef?: string;
  /** Handoff produced when a subtask completes. */
  handoff?: TaskHandoff;
  /** For kind === "pipeline" parents: id of the template that was expanded. */
  pipelineId?: string;
  /** For kind === "pipeline" parents: user-supplied input values at creation. */
  pipelineInputs?: Record<string, string>;
  /** Retry behavior when the task fails (populated from pipeline step.retry). */
  retryPolicy?: TaskRetryPolicy;
  /** How many times the task has already been retried. */
  retryCount?: number;
  /** ISO timestamp — scheduler/bidding skip this task until now >= retryAt. */
  retryAt?: string;
  /** Populated when the task was resolved via skip/fallback/branch-miss. */
  skippedReason?: string;
  /** Artifact contracts declared by the pipeline template. On pipeline parents
   *  this aggregates template-level + step-level `isFinal` outputs; on subtasks
   *  this mirrors the step's own declared outputs. Reconciled against handoff
   *  artifacts when the producing task completes. */
  declaredOutputs?: TaskDeclaredOutput[];
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
  /** Short (≤400 char) distilled takeaway — what to recall at a glance. */
  summary?: string;
  /** Full body — task description, handoff details, notes, etc. */
  content: string;
  tags: string[];
  relatedAssets?: string[];
  /** Task id this memory was distilled from, if any. */
  sourceTaskId?: string;
  /** Group id this memory belongs to, if any — lets us scope recall. */
  groupId?: string;
  /** Reinforcement score (0..10). Incremented on reuse, decayed on prune. */
  strength: number;
  /** Pinned memories are never pruned regardless of strength. */
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  accessCount: number;
  lastAccessedAt?: string;
  /** Schema version for forward migrations. */
  v: 2;
}

// ─── Scheduler log (persisted per group) ─────────────────────────

export interface GuildSchedulerLogEntry {
  id: string;
  at: string;
  kind: "dispatched" | "stalled";
  groupId: string;
  taskId?: string;
  agentId?: string;
  taskTitle?: string;
  confidence?: number;
  openTaskCount?: number;
  message: string;
}

// ─── Event Types ────────────────────────────────────────────────

export type GuildEvent =
  | { type: "task_created"; task: GuildTask }
  | { type: "task_updated"; task: GuildTask }
  | { type: "task_bidding_start"; taskId: string; agents: string[] }
  | { type: "task_assigned"; taskId: string; agentId: string; bid?: TaskBid }
  | { type: "task_completed"; taskId: string; agentId: string; result: TaskResult }
  | { type: "task_failed"; taskId: string; agentId: string; error: string }
  | { type: "task_cancelled"; taskId: string }
  | { type: "task_removed"; taskId: string; groupId: string }
  | { type: "agent_status_changed"; agentId: string; status: AgentStatus }
  | { type: "agent_output"; agentId: string; taskId: string; content: string }
  | { type: "agent_reasoning"; agentId: string; taskId: string; content: string }
  | { type: "agent_tool_call"; agentId: string; taskId: string; tool: string; input: unknown }
  | { type: "agent_tool_result"; agentId: string; taskId: string; tool: string; output: string }
  | { type: "agent_plan"; agentId: string; taskId: string; phase: string; payload: unknown }
  | { type: "agent_harness"; agentId: string; taskId: string; kind: string; payload: unknown }
  | { type: "agent_memory_settled"; agentId: string; memoryId: string }
  | { type: "group_updated"; groupId: string }
  | { type: "agent_updated"; agentId: string }
  | {
      type: "scheduler_task_dispatched";
      groupId: string;
      taskId: string;
      agentId: string;
      taskTitle: string;
      confidence: number;
      schedulerLogEntry: GuildSchedulerLogEntry;
    }
  | {
      type: "scheduler_dispatch_stalled";
      groupId: string;
      openTaskCount: number;
      message: string;
      schedulerLogEntry: GuildSchedulerLogEntry;
    };

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
  /** Bonus applied when an agent owns a group asset matching the task. */
  ownerBonusWeight: number;
  /** Prior used for new agents so they aren't permanently cold-started. */
  successRatePrior: number;
  /** When true, requirement-kind tasks are routed to the planner instead of bidding. */
  skipParentRequirement: boolean;
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
  /** Semantic embedding similarity [0,1]. Present only when the embedding model is warmed. */
  embedding?: number;
  /** LLM-based score [0,10]. Present only when llmScorer was warmed for this agent+task. */
  llmScore?: number;
  /** Short rationale from the LLM scorer. */
  llmReason?: string;
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
  leadAgentId?: string;
  assets?: Omit<AgentAsset, "id" | "addedAt">[];
  artifactStrategy?: ArtifactStrategy;
}

export interface CreateTaskParams {
  title: string;
  description: string;
  priority?: TaskPriority;
  dependsOn?: string[];
  createdBy?: string;
  kind?: TaskKind;
  parentTaskId?: string;
  suggestedSkills?: string[];
  suggestedAgentId?: string;
  acceptanceCriteria?: string;
  acceptanceAssertions?: AcceptanceAssertion[];
  workspaceRef?: string;
  pipelineId?: string;
  pipelineInputs?: Record<string, string>;
  retryPolicy?: TaskRetryPolicy;
  declaredOutputs?: TaskDeclaredOutput[];
  /** Initial status — defaults to "open". Use "blocked" to create a task that
   *  the scheduler won't pick up until its status is later flipped to "open"
   *  (e.g. planner 2-pass: create all children then wire deps atomically). */
  initialStatus?: TaskStatus;
}
