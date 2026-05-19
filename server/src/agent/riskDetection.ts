import type { StructuredToolInterface } from "@langchain/core/tools";
import { tool } from "@langchain/core/tools";
import { resolve } from "path";
import { realpathSync } from "fs";
import { getAgentConfig, isAllToolsAllowed, type AgentRole } from "./roles.js";
import { listToolIds, getToolsByIds } from "../tools/index.js";
import { getMcpTools } from "../mcp/client.js";
import { approvalManager } from "./approvalManager.js";
import type { ApprovalRule } from "../config/userConfig.js";
import type { PlanStep } from "./planning.js";
import type { ConversationMode } from "./systemPrompt.js";
import type { HarnessConfig, HarnessEvent } from "./harness/types.js";
import type { ExecutionEnhancementsConfig } from "../config/userConfig.js";
import type { StopReason } from "./messageUtils.js";

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
  /** 执行增强配置（用于生成 system prompt 中的增强指令） */
  enhancements?: ExecutionEnhancementsConfig;
  /** 工具白名单（Guild Agent 等外部调用方使用）。["*"] 或 undefined = 全部工具。 */
  allowedTools?: string[];
}

export interface StreamAgentOptions extends AgentExecutionOptions {
  planProgressEnabled?: boolean;
  onPlanEvent?: (event: PlanStreamEvent) => void;
  /** Harness 中间件配置（Eval、循环检测、重规划）。为 undefined 时不启用。 */
  harnessConfig?: HarnessConfig;
  /** Harness 事件回调（eval 结果、循环检测、重规划决策） */
  onHarnessEvent?: (event: HarnessEvent) => void;
  /** Agent Loop 终止原因回调 */
  onStopReason?: (reason: StopReason) => void;
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
    }
  | {
      kind: "harness";
      subagentId: string;
      [key: string]: unknown;
    };

export function filterToolsByRole(tools: StructuredToolInterface[], agentId: string): StructuredToolInterface[] {
  const config = getAgentConfig(agentId);
  if (!config || isAllToolsAllowed(config.allowedTools)) return tools;
  const allowed = new Set(config.allowedTools);
  return tools.filter((t) => allowed.has(t.name));
}

/** Filter tools by an explicit allowlist (Guild Agent etc.).
 *  - undefined → no filter (all tools, matches legacy callers that never set this)
 *  - ["*"]     → no filter (explicit "all")
 *  - []        → zero tools (agent explicitly denied every tool)
 *  - [names…]  → only those names
 */
export function filterToolsByAllowedList(
  tools: StructuredToolInterface[],
  allowedTools?: string[],
): StructuredToolInterface[] {
  if (!allowedTools) return tools;
  if (isAllToolsAllowed(allowedTools)) return tools;
  const allowed = new Set(allowedTools);
  return tools.filter((t) => allowed.has(t.name));
}

// HIGH_RISK patterns are now managed as builtin approvalRules in userConfig.ts
// Only BYPASS_IMMUNE patterns remain hardcoded (see below)

// ── Structured bypass-immune rules for frontend display (truly non-disablable) ──

export interface BuiltInRiskRule {
  name: string;
  pattern: string;
  operationType: "run_command" | "write_file";
  category: "bypass_immune";
}

export function getBuiltInRiskRules(): BuiltInRiskRule[] {
  return [
    { name: "Force push to remote", pattern: "\\bgit\\s+push\\s+.*--force", operationType: "run_command", category: "bypass_immune" },
    { name: "Force push to remote (-f)", pattern: "\\bgit\\s+push\\b.*\\s-f\\b", operationType: "run_command", category: "bypass_immune" },
    { name: "递归删除根路径", pattern: "\\brm\\s+(-[^\\s]*\\s+)*-[^\\s]*r[^\\s]*\\s+(\\./?|/|~/?)(\\s|$)", operationType: "run_command", category: "bypass_immune" },
    { name: "写入 .git/ 目录", pattern: "/\\.git/", operationType: "write_file", category: "bypass_immune" },
    { name: "写入 .env 文件", pattern: "/\\.env$", operationType: "write_file", category: "bypass_immune" },
    { name: "写入 .env.* 文件", pattern: "/\\.env\\.", operationType: "write_file", category: "bypass_immune" },
    { name: "写入凭证/密钥文件", pattern: "/(credentials|\\.pem|\\.key|id_rsa)", operationType: "write_file", category: "bypass_immune" },
  ];
}

// ── Bypass-immune rules: cannot be overridden by user approvalRules ──

const BYPASS_IMMUNE_WRITE_PATTERNS = [
  { pattern: /\/\.git\//, description: "Writing to .git/ directory" },
  { pattern: /\/\.env$/, description: "Writing to .env file" },
  { pattern: /\/\.env\./, description: "Writing to .env.* file" },
  { pattern: /\/(credentials|\.pem|\.key|id_rsa)/, description: "Writing to credential/key file" },
];

const BYPASS_IMMUNE_COMMAND_PATTERNS = [
  { pattern: /\bgit\s+push\s+.*--force/i, description: "Force push to remote" },
  { pattern: /\bgit\s+push\b.*\s-f\b/i, description: "Force push to remote" },
  { pattern: /\brm\s+(-[^\s]*\s+)*-[^\s]*r[^\s]*\s+(\.\/?|\/|~\/?)(\s|$)/i, description: "Recursive delete at root-level path" },
];

/**
 * Check if an operation is bypass-immune (always requires approval regardless of user config).
 * Returns a description string if bypass-immune, null otherwise.
 */
export function isBypassImmune(operationType: string, input: Record<string, unknown>): string | null {
  if ((operationType === "write_file" || operationType === "edit_file") && typeof input.path === "string") {
    const path = input.path;
    for (const rule of BYPASS_IMMUNE_WRITE_PATTERNS) {
      if (rule.pattern.test(path)) return `[bypass-immune] ${rule.description}: ${path}`;
    }
  }
  if (operationType === "run_command" && typeof input.command === "string") {
    const command = input.command;
    for (const rule of BYPASS_IMMUNE_COMMAND_PATTERNS) {
      if (rule.pattern.test(command)) return `[bypass-immune] ${rule.description}`;
    }
  }
  return null;
}

export function isHighRiskCommand(command: string, customRules?: ApprovalRule[]): string | null {
  if (customRules) {
    for (const rule of customRules) {
      if (rule.enabled && rule.operationType === "run_command") {
        try {
          if (new RegExp(rule.pattern, "i").test(command)) {
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
      // Bypass-immune check first — block before approval flow to avoid misleading UX
      const bypassCheck = isBypassImmune(toolName, input);
      if (bypassCheck) {
        return `[blocked] ${bypassCheck}. This operation is permanently blocked for safety.`;
      }
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
  // resolve() normalizes ../ segments
  if (target !== workspace && !target.startsWith(`${workspace}/`)) return false;
  // Resolve symlinks if the file exists to prevent symlink escapes
  try {
    const realTarget = realpathSync(target);
    const realWorkspace = realpathSync(workspace);
    return realTarget === realWorkspace || realTarget.startsWith(`${realWorkspace}/`);
  } catch {
    // File doesn't exist yet — trust the normalized path check above
    return true;
  }
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
