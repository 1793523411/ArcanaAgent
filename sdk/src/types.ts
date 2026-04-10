import type { StructuredToolInterface } from "@langchain/core/tools";
import type { BaseMessage } from "@langchain/core/messages";

export type ModelProvider = "openai" | "anthropic";

export interface ModelConfig {
  provider: ModelProvider;
  apiKey: string;
  modelId: string;
  baseUrl?: string;
  reasoning?: boolean;
  temperature?: number;
  maxTokens?: number;
}

export interface ToolConfig {
  builtinTools?: BuiltinToolId[];
  excludeTools?: BuiltinToolId[];
  customTools?: StructuredToolInterface[];
}

export interface SkillConfig {
  dirs?: string[];
  skills?: Array<{ name: string; description: string; dirPath: string }>;
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

export type BuiltinToolId =
  | "run_command"
  | "read_file"
  | "write_file"
  | "edit_file"
  | "search_code"
  | "list_files"
  | "git_operations"
  | "test_runner"
  | "web_search"
  | "fetch_url"
  | "get_time"
  | "background_run"
  | "background_check"
  | "background_cancel";

export interface AgentConfig {
  model: ModelConfig;
  tools?: ToolConfig;
  skills?: SkillConfig;
  mcpServers?: McpServerConfig[];
  systemPrompt?: string;
  workspacePath?: string;
  maxRounds?: number;
  planningEnabled?: boolean;
  harnessConfig?: import("@arcana-agent/core").HarnessConfig;
  abortSignal?: AbortSignal;
}

export type StopReason =
  | "completed"
  | "aborted"
  | "max_rounds"
  | "model_error"
  | "harness_abort"
  | "tool_error_cascade"
  | "context_overflow"
  | "empty_response";

export type AgentEventType =
  | "token"
  | "reasoning_token"
  | "tool_call"
  | "tool_result"
  | "plan_update"
  | "usage"
  | "stop"
  | "error";

export interface TokenEvent {
  type: "token";
  content: string;
}

export interface ReasoningTokenEvent {
  type: "reasoning_token";
  content: string;
}

export interface ToolCallEvent {
  type: "tool_call";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResultEvent {
  type: "tool_result";
  id: string;
  name: string;
  result: string;
}

export interface PlanUpdateEvent {
  type: "plan_update";
  steps: Array<{ title: string; status: "pending" | "in_progress" | "completed" | "failed" }>;
  currentStepIndex: number;
}

export interface UsageEvent {
  type: "usage";
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface StopEvent {
  type: "stop";
  reason: StopReason;
}

export interface ErrorEvent {
  type: "error";
  message: string;
  recoverable: boolean;
}

export type AgentEvent =
  | TokenEvent
  | ReasoningTokenEvent
  | ToolCallEvent
  | ToolResultEvent
  | PlanUpdateEvent
  | UsageEvent
  | StopEvent
  | ErrorEvent;

export interface AgentRunResult {
  content: string;
  stopReason: StopReason;
  toolCallCount: number;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  messages: BaseMessage[];
}
