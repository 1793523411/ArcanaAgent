export type ConversationMode = "default" | "team";
export type AgentRole = string;

export interface AgentDefHarness {
  /** 启用循环检测（零 token 成本，默认 true） */
  loopDetection?: boolean;
  /** 启用 Eval 步骤验证（每步一次 LLM 调用，默认 false） */
  eval?: boolean;
  /** 启用动态重规划（循环或 eval 失败时生成新计划，默认 false） */
  replan?: boolean;
  /** 自动批准重规划（默认 true，设为 false 时重规划仅作为建议注入） */
  autoApproveReplan?: boolean;
  /** 启用外层重试（整轮失败后从头重新执行，默认 false） */
  outerRetry?: boolean;
}

export interface AgentDef {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  systemPrompt: string;
  allowedTools: string[];
  builtIn: boolean;
  /** 是否启用 Claude Code 能力（仅在全局开启时生效） */
  claudeCodeEnabled?: boolean;
  /** 子 agent Harness 配置（team 模式下生效） */
  harness?: AgentDefHarness;
}

export interface TeamDef {
  id: string;
  name: string;
  description: string;
  agents: string[];
  coordinatorPrompt?: string;
  builtIn: boolean;
}

export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  mode?: ConversationMode;
  teamId?: string;
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
  /** Claude Code 实时执行子日志 */
  subLogs?: Array<{ type: string; content: string }>;
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
  /** 角色类型（team 模式，对应 AgentDef ID） */
  role?: string;
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
  /** 子 agent Harness 事件（eval/loop_detection/replan） */
  harnessEvents?: Array<{ kind: string; data: Record<string, unknown>; timestamp?: string }>;
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
  harness?: HarnessLog;
  /** 外层重试时前几轮的中间回复内容（仅前端 merge 产生，不持久化） */
  previousIterations?: string[];
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

export interface McpToolInfo {
  name: string;
  description: string;
}

export interface McpStatusItem {
  name: string;
  connected: boolean;
  toolCount: number;
  tools?: McpToolInfo[];
  error?: string;
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

export interface ApprovalRule {
  id: string;
  name: string;
  pattern: string;
  operationType: "run_command" | "write_file" | "edit_file";
  enabled: boolean;
}

export type CodeIndexStrategy = "none" | "repomap" | "vector";

export interface ClaudeCodeConfig {
  /** 全局开关 */
  enabled: boolean;
  /** 使用的模型，如 "sonnet", "opus", "claude-sonnet-4-6" */
  model?: string;
  /** 默认最大轮次 */
  maxTurns?: number;
  /** 禁用的 Claude Code 工具 */
  disallowedTools?: string[];
}

export interface ExecutionEnhancementsConfig {
  evalGuard: boolean;
  loopDetection: boolean;
  replan: boolean;
  autoApproveReplan: boolean;
  outerRetry: boolean;
  maxReplanAttempts: number;
  maxOuterRetries: number;
  loopWindowSize: number;
  loopSimilarityThreshold: number;
}

export interface BuiltInRiskRule {
  name: string;
  pattern: string;
  operationType: "run_command" | "write_file";
  category: "bypass_immune";
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
  approvalRules?: ApprovalRule[];
  codeIndexStrategy?: CodeIndexStrategy;
  /** Claude Code 集成配置 */
  claudeCode?: ClaudeCodeConfig;
  /** 执行增强配置 */
  enhancements?: ExecutionEnhancementsConfig;
  /** 系统内置高危规则（只读，后端生成） */
  builtInRiskRules?: BuiltInRiskRule[];
}

export type StreamingStatus = "thinking" | "tool" | null;

// ─── Harness Types ──────────────────────────────────

export interface HarnessEvalEvent {
  kind: "eval";
  data: {
    stepIndex: number;
    verdict: "pass" | "weak" | "fail" | "inconclusive";
    reason: string;
  };
  timestamp: string;
}

export interface HarnessLoopEvent {
  kind: "loop_detection";
  data: {
    detected: boolean;
    type?: "exact_cycle" | "semantic_stall";
    description?: string;
    windowSnapshot?: string[];
  };
  timestamp: string;
}

export interface HarnessReplanEvent {
  kind: "replan";
  data: {
    shouldReplan: boolean;
    trigger: "eval_fail" | "loop_detected" | "none";
    revisedSteps?: Array<{ title: string; acceptance_checks: string[] }>;
    pendingApproval?: boolean;
  };
  timestamp: string;
}

export type HarnessEvent = HarnessEvalEvent | HarnessLoopEvent | HarnessReplanEvent;

export interface HarnessDriverEvent {
  kind: "driver_lifecycle";
  phase: "started" | "iteration_start" | "iteration_end" | "completed" | "max_retries_reached";
  iteration: number;
  maxRetries: number;
  harnessEventsInIteration?: HarnessEvent[];
  timestamp: string;
}

export interface HarnessLog {
  events: HarnessEvent[];
  driverEvents: HarnessDriverEvent[];
}

export interface ArtifactMeta {
  name: string;
  path: string;
  size: number;
  mimeType: string;
  modifiedAt: string;
}

// ─── Model Management Types ──────────────────────────

export interface ModelSpec {
  id: string;
  name: string;
  api: string;
  contextWindow: number;
  maxTokens: number;
  input?: string[];
  reasoning?: boolean;
}

export interface ProviderInfo {
  name: string;
  baseUrl: string;
  apiKeyMasked: string;
  api: string;
  models: ModelSpec[];
}

export interface ModelValidationResult {
  modelId: string;
  provider: string;
  modelName: string;
  status: "success" | "error" | "warning";
  connectivity: boolean;
  toolUse: boolean;
  latencyMs: number;
  error?: string;
}
