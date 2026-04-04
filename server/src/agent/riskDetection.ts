import type { StructuredToolInterface } from "@langchain/core/tools";
import { tool } from "@langchain/core/tools";
import { resolve } from "path";
import { getAgentConfig, isAllToolsAllowed, type AgentRole } from "./roles.js";
import { listToolIds, getToolsByIds } from "../tools/index.js";
import { getMcpTools } from "../mcp/client.js";
import { approvalManager } from "./approvalManager.js";
import type { ApprovalRule } from "../config/userConfig.js";
import type { PlanStep } from "./planning.js";
import type { ConversationMode } from "./systemPrompt.js";
import type { HarnessConfig, HarnessEvent } from "./harness/types.js";

export type { AgentRole } from "./roles.js";
export type { ConversationMode } from "./systemPrompt.js";

export interface PlanStreamEvent {
  phase: "created" | "running" | "completed";
  steps: Array<PlanStep & { evidences: string[]; completed: boolean }>;
  currentStep: number;
  toolName?: string;
}

export interface AgentExecutionOptions {
  planningEnabled?: boolean;
  workspacePath?: string;
  subagentEnabled?: boolean;
  subagentDepth?: number;
  conversationMode?: ConversationMode;
  conversationId?: string;
  teamId?: string;
  subagentId?: string;
  subagentSystemPromptOverride?: string;
  subagentRole?: AgentRole;
  onSubagentEvent?: (event: SubagentStreamEvent) => void;
  /** AbortSignal to cancel agent execution (e.g., on client disconnect) */
  abortSignal?: AbortSignal;
}

export interface StreamAgentOptions extends AgentExecutionOptions {
  planProgressEnabled?: boolean;
  onPlanEvent?: (event: PlanStreamEvent) => void;
  /** Harness 中间件配置（Eval、循环检测、重规划）。为 undefined 时不启用。 */
  harnessConfig?: HarnessConfig;
  /** Harness 事件回调（eval 结果、循环检测、重规划决策） */
  onHarnessEvent?: (event: HarnessEvent) => void;
}

export type SubagentStreamEvent =
  | {
      kind: "lifecycle";
      phase: "started" | "completed" | "failed";
      subagentId: string;
      subagentName?: string;
      role?: AgentRole;
      dependsOn?: string[];
      depth: number;
      prompt: string;
      summary?: string;
      error?: string;
    }
  | {
      kind: "token";
      subagentId: string;
      content: string;
    }
  | {
      kind: "reasoning";
      subagentId: string;
      content: string;
    }
  | ({
      kind: "plan";
      subagentId: string;
    } & PlanStreamEvent)
  | {
      kind: "tool_call";
      subagentId: string;
      name: string;
      input: string;
    }
  | {
      kind: "tool_result";
      subagentId: string;
      name: string;
      output: string;
    }
  | {
      kind: "subagent_name";
      subagentId: string;
      subagentName: string;
    }
  | {
      kind: "approval_request";
      subagentId: string;
      requestId: string;
      operationType: string;
      operationDescription: string;
      details: Record<string, unknown>;
    }
  | {
      kind: "approval_response";
      subagentId: string;
      requestId: string;
      approved: boolean;
    };

export function filterToolsByRole(tools: StructuredToolInterface[], agentId: string): StructuredToolInterface[] {
  const config = getAgentConfig(agentId);
  if (!config || isAllToolsAllowed(config.allowedTools)) return tools;
  const allowed = new Set(config.allowedTools);
  return tools.filter((t) => allowed.has(t.name));
}

export const HIGH_RISK_COMMAND_PATTERNS = [
  /\brm\s+(-[^\s]*\s+)*-[^\s]*r/i,    // rm -rf, rm -r
  /\brm\s+.*--recursive/i,              // rm --recursive
  /\bgit\s+push\s+.*--force/i,         // git push --force
  /\bgit\s+reset\s+--hard/i,           // git reset --hard
  /\bDROP\s+(TABLE|DATABASE)/i,         // DROP TABLE / DROP DATABASE
  /\bDELETE\s+FROM\b/i,                // DELETE FROM
  /\bTRUNCATE\s+TABLE/i,               // TRUNCATE TABLE
  /\bgit\s+clean\s+-[^\s]*f/i,         // git clean -f
  /\bchmod\s+777\b/,                    // chmod 777
  /\bkill\s+-9\b/,                      // kill -9
];

export function isHighRiskCommand(command: string, customRules?: ApprovalRule[]): string | null {
  for (const pattern of HIGH_RISK_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return command.trim().slice(0, 120);
    }
  }
  if (customRules) {
    for (const rule of customRules) {
      if (rule.enabled && rule.operationType === "run_command") {
        try {
          if (new RegExp(rule.pattern).test(command)) {
            return `[${rule.name}] ${command.trim().slice(0, 120)}`;
          }
        } catch { /* ignore invalid regex */ }
      }
    }
  }
  return null;
}

export function isHighRiskWrite(path: string, workspacePath?: string, customRules?: ApprovalRule[]): string | null {
  if (workspacePath) {
    const resolvedWorkspace = resolve(workspacePath);
    const resolvedPath = resolve(path);
    if (!resolvedPath.startsWith(`${resolvedWorkspace}/`) && resolvedPath !== resolvedWorkspace) {
      return `Writing outside workspace: ${path}`;
    }
  }
  const riskyPatterns = [/\.env$/, /credentials/, /\.pem$/, /\.key$/, /config\.json$/, /\.gitignore$/];
  for (const pattern of riskyPatterns) {
    if (pattern.test(path)) {
      return `Writing to sensitive file: ${path}`;
    }
  }
  if (customRules) {
    for (const rule of customRules) {
      if (rule.enabled && (rule.operationType === "write_file" || rule.operationType === "edit_file")) {
        try {
          if (new RegExp(rule.pattern).test(path)) {
            return `[${rule.name}] ${path}`;
          }
        } catch { /* ignore invalid regex */ }
      }
    }
  }
  return null;
}

export function wrapToolWithApproval(
  originalTool: StructuredToolInterface,
  toolName: string,
  getRiskDescription: (input: Record<string, unknown>) => string | null,
  context: {
    conversationId: string;
    subagentId: string;
    role?: AgentRole;
    onSubagentEvent?: (event: SubagentStreamEvent) => void;
  }
): StructuredToolInterface {
  const wrapped = tool(
    async (input: Record<string, unknown>) => {
      const riskDesc = getRiskDescription(input);
      if (!riskDesc) {
        return String(await originalTool.invoke(input));
      }
      // High-risk: create approval request
      const { requestId, promise } = approvalManager.createRequest({
        conversationId: context.conversationId,
        subagentId: context.subagentId,
        role: context.role,
        operationType: toolName,
        operationDescription: riskDesc,
        details: input,
      });
      context.onSubagentEvent?.({
        kind: "approval_request",
        subagentId: context.subagentId,
        requestId,
        operationType: toolName,
        operationDescription: riskDesc,
        details: input,
      });
      const approved = await promise;
      context.onSubagentEvent?.({
        kind: "approval_response",
        subagentId: context.subagentId,
        requestId,
        approved,
      });
      if (!approved) {
        return `[blocked] Operation rejected by user: ${riskDesc}`;
      }
      return String(await originalTool.invoke(input));
    },
    {
      name: originalTool.name,
      description: (originalTool as unknown as { description?: string }).description ?? originalTool.name,
      schema: (originalTool as unknown as { schema: unknown }).schema as never,
    }
  );
  return wrapped as unknown as StructuredToolInterface;
}

export function getAllTools(): StructuredToolInterface[] {
  const allIds = listToolIds();
  const builtIn = getToolsByIds(allIds);
  const mcp = getMcpTools();
  return [...builtIn, ...mcp];
}

export interface RuntimeToolBuildContext {
  modelId?: string;
  skillContext?: string;
  options?: AgentExecutionOptions;
  subagentResults?: Map<string, { name: string; summary: string }>;
}

export function isPathInWorkspace(pathText: string, workspacePath: string): boolean {
  const workspace = resolve(workspacePath);
  const target = resolve(pathText);
  return target === workspace || target.startsWith(`${workspace}/`);
}

export function isLikelyProjectMirrorPath(pathText: string): boolean {
  const normalized = pathText.replace(/\\/g, "/").replace(/^['"]|['"]$/g, "");
  return (
    normalized.startsWith("data/conversations/") ||
    normalized.startsWith("./data/conversations/") ||
    normalized.includes("/data/conversations/")
  );
}

export function findForbiddenOutputPath(command: string, workspacePath: string): string | null {
  const outputFlagRegex = /(?:^|\s)(?:-o|--output|--out|--out-dir|--output-dir)\s+([^\s"']+|"[^"]+"|'[^']+')/g;
  for (const m of command.matchAll(outputFlagRegex)) {
    const raw = (m[1] ?? "").trim().replace(/^['"]|['"]$/g, "");
    if (isLikelyProjectMirrorPath(raw)) return raw;
    if (raw.startsWith("/") && !isPathInWorkspace(raw, workspacePath)) return raw;
  }
  const redirectRegex = /(?:^|[;&]\s*|&&\s*|\|\|\s*)>\s*([^\s"']+|"[^"]+"|'[^']+')/g;
  for (const m of command.matchAll(redirectRegex)) {
    const raw = (m[1] ?? "").trim().replace(/^['"]|['"]$/g, "");
    if (isLikelyProjectMirrorPath(raw)) return raw;
    if (raw.startsWith("/") && !isPathInWorkspace(raw, workspacePath)) return raw;
  }
  const cdRegex = /(?:^|[;&]\s*|&&\s*|\|\|\s*)cd\s+([^\s"']+|"[^"]+"|'[^']+')/g;
  for (const m of command.matchAll(cdRegex)) {
    const raw = (m[1] ?? "").trim().replace(/^['"]|['"]$/g, "");
    if (isLikelyProjectMirrorPath(raw)) return raw;
    if (raw.startsWith("/") && !isPathInWorkspace(raw, workspacePath)) return raw;
  }
  return null;
}
