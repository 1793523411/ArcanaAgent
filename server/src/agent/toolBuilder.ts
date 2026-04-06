import type { StructuredToolInterface } from "@langchain/core/tools";
import { tool } from "@langchain/core/tools";
import { BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { resolve, join } from "path";
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "fs";
import { loadUserConfig } from "../config/userConfig.js";
import type { ApprovalRule } from "../config/userConfig.js";
import { detectDiagnosticCommand, runDiagnostic } from "./diagnostics.js";
import { getModelAdapter } from "../llm/adapter.js";
import { getAgentDef } from "../storage/agentDefs.js";
import { serverLogger } from "../lib/logger.js";
import { isValidTeamAgent } from "./roles.js";
import type { AgentRole } from "./roles.js";
import { buildSubagentSystemPrompt } from "./systemPrompt.js";
import {
  isHighRiskCommand,
  isHighRiskWrite,
  wrapToolWithApproval,
  filterToolsByRole,
  getAllTools,
  isPathInWorkspace,
  isBypassImmune,
  findForbiddenOutputPath,
  type RuntimeToolBuildContext,
  type AgentExecutionOptions,
  type StreamAgentOptions,
  type SubagentStreamEvent,
  type PlanStreamEvent,
} from "./riskDetection.js";
import type { HarnessEvent, EvalResult, LoopDetectionResult } from "./harness/types.js";
import {
  truncateToolResult,
  MAX_TASK_TOOL_RESULT_CHARS,
  MAX_DEPENDS_ON_SUMMARY_CHARS,
  NO_VISIBLE_OUTPUT_MESSAGE,
  getTextFromMessage,
  stringifyToolArgs,
  createSubagentId,
  deriveSubagentName,
} from "./messageUtils.js";

type StreamAgentWithTokensFn = (
  messages: BaseMessage[],
  onToken: (token: string) => void,
  modelId?: string,
  onReasoningToken?: (token: string) => void,
  skillContext?: string,
  options?: StreamAgentOptions
) => AsyncGenerator<Record<string, { messages?: BaseMessage[]; reasoning?: string } | { prompt_tokens: number; completion_tokens: number; total_tokens: number } | { reason: string }>, void, unknown>;

let _streamAgentWithTokens: StreamAgentWithTokensFn | null = null;

export function injectStreamAgent(fn: StreamAgentWithTokensFn) {
  _streamAgentWithTokens = fn;
}

const SUBAGENT_NAME_SYSTEM = "\u4f60\u53ea\u8f93\u51fa\u4e00\u4e2a\u6781\u77ed\u7684\u6807\u9898\uff0c\u4e0d\u8981\u4efb\u4f55\u89e3\u91ca\u3001\u6807\u70b9\u6216\u6362\u884c\u3002\u4e2d\u6587 4\uff5e10 \u5b57\u6216\u82f1\u6587 2\uff5e6 \u4e2a\u8bcd\u3002";
const SUBAGENT_NAME_MAX_LEN = 12;

async function generateShortSubagentName(prompt: string, modelId?: string): Promise<string> {
  const llm = getModelAdapter(modelId).getLLM();
  const oneLine = prompt.replace(/\s+/g, " ").trim().slice(0, 200);
  const msg = await llm.invoke([
    new SystemMessage(SUBAGENT_NAME_SYSTEM),
    new HumanMessage(`\u4efb\u52a1\uff1a${oneLine}\n\u77ed\u6807\u9898\uff1a`),
  ]);
  const text = typeof msg.content === "string" ? msg.content : "";
  const name = text.replace(/\s+/g, " ").trim().replace(/^["'\u300c\u300e]|["'\u300d\u300f]$/g, "").slice(0, SUBAGENT_NAME_MAX_LEN) || "\u5b50\u4efb\u52a1";
  return name;
}

/**
 * Wrap high-risk tools (run_command, write_file, edit_file) with approval gates.
 * Applied in ALL modes (normal + team) for ALL agents (main + sub).
 */
function applyHighRiskApproval(
  tools: StructuredToolInterface[],
  convId: string,
  subId: string,
  workspacePath?: string,
  subagentRole?: AgentRole,
  onSubagentEvent?: (event: SubagentStreamEvent) => void,
): StructuredToolInterface[] {
  const customRules = loadUserConfig().approvalRules;
  return tools.map((t) => {
    if (t.name === "run_command") {
      return wrapToolWithApproval(t, "run_command", (input) => {
        const cmd = typeof input.command === "string" ? input.command : "";
        return isHighRiskCommand(cmd, customRules);
      }, { conversationId: convId, subagentId: subId, role: subagentRole, onSubagentEvent });
    }
    if (t.name === "write_file") {
      return wrapToolWithApproval(t, "write_file", (input) => {
        const path = typeof input.path === "string" ? input.path : "";
        return isHighRiskWrite(path, workspacePath, customRules);
      }, { conversationId: convId, subagentId: subId, role: subagentRole, onSubagentEvent });
    }
    if (t.name === "edit_file") {
      return wrapToolWithApproval(t, "edit_file", (input) => {
        const path = typeof input.path === "string" ? input.path : "";
        return isHighRiskWrite(path, workspacePath, customRules);
      }, { conversationId: convId, subagentId: subId, role: subagentRole, onSubagentEvent });
    }
    return t;
  });
}

export function buildRuntimeTools(options?: AgentExecutionOptions, context?: RuntimeToolBuildContext): StructuredToolInterface[] {
  const tools = getAllTools();
  const workspacePath = options?.workspacePath;
  const wrappedTools = tools.map((t) => {
    if (t.name === "write_file" && workspacePath) {
      const wrapped = tool(
        async (input: Record<string, unknown>) => {
          const rawPath = typeof input.path === "string" ? input.path : "";
          const resolvedPath = rawPath.startsWith("/") ? rawPath : resolve(workspacePath, rawPath);
          // Bypass-immune check: always require approval for protected paths
          const bypassCheck = isBypassImmune("write_file", { path: resolvedPath });
          if (bypassCheck) {
            return `[write_file]\nstatus: blocked\npath: ${rawPath}\nnote: ${bypassCheck}. This operation is permanently blocked for safety.`;
          }
          if (!isPathInWorkspace(resolvedPath, workspacePath)) {
            return `[write_file]\nstatus: blocked\npath: ${rawPath}\nnote: \u8f93\u51fa\u8def\u5f84\u4e0d\u5728\u5f53\u524d\u4f1a\u8bdd workspace \u5185\u3002\u8bf7\u4f7f\u7528 ${workspacePath} \u4e0b\u7684\u8def\u5f84\u3002`;
          }
          const originalResult = String(await t.invoke({ ...input, path: resolvedPath }));
          if (originalResult.startsWith("OK:")) {
            const diagInfo = detectDiagnosticCommand(resolvedPath, workspacePath);
            if (diagInfo) {
              try {
                let diagResult = await runDiagnostic(diagInfo.command, workspacePath);
                if (diagResult && diagInfo.filterRelPath) {
                  const filtered = diagResult.split("\n").filter(l => l.includes(diagInfo.filterRelPath!)).join("\n").trim();
                  diagResult = filtered || null;
                }
                if (diagResult) {
                  return originalResult + `\n\n\u26a0\ufe0f Diagnostic errors detected (${diagInfo.projectType}):\n${diagResult}\n\nPlease fix the errors above.`;
                }
              } catch { /* diagnostic failure should not block the tool */ }
            }
          }
          return originalResult;
        },
        {
          name: "write_file",
          description: (t as unknown as { description?: string }).description ?? t.name,
          schema: (t as unknown as { schema: unknown }).schema as never,
        }
      );
      return wrapped as unknown as StructuredToolInterface;
    }
    if (t.name === "edit_file" && workspacePath) {
      const wrapped = tool(
        async (input: Record<string, unknown>) => {
          const rawPath = typeof input.path === "string" ? input.path : "";
          const resolvedPath = rawPath.startsWith("/") ? rawPath : resolve(workspacePath, rawPath);
          // Bypass-immune check: always require approval for protected paths
          const bypassCheck = isBypassImmune("edit_file", { path: resolvedPath });
          if (bypassCheck) {
            return `[edit_file]\nstatus: blocked\npath: ${rawPath}\nnote: ${bypassCheck}. This operation is permanently blocked for safety.`;
          }
          if (!isPathInWorkspace(resolvedPath, workspacePath)) {
            return `[edit_file]\nstatus: blocked\npath: ${rawPath}\nnote: \u7f16\u8f91\u8def\u5f84\u4e0d\u5728\u5f53\u524d\u4f1a\u8bdd workspace \u5185\u3002\u8bf7\u4f7f\u7528 ${workspacePath} \u4e0b\u7684\u8def\u5f84\u3002`;
          }
          const originalResult = String(await t.invoke({ ...input, path: resolvedPath }));
          if (originalResult.startsWith("OK:")) {
            const diagInfo = detectDiagnosticCommand(resolvedPath, workspacePath);
            if (diagInfo) {
              try {
                let diagResult = await runDiagnostic(diagInfo.command, workspacePath);
                if (diagResult && diagInfo.filterRelPath) {
                  const filtered = diagResult.split("\n").filter(l => l.includes(diagInfo.filterRelPath!)).join("\n").trim();
                  diagResult = filtered || null;
                }
                if (diagResult) {
                  return originalResult + `\n\n\u26a0\ufe0f Diagnostic errors detected (${diagInfo.projectType}):\n${diagResult}\n\nPlease fix the errors above.`;
                }
              } catch { /* diagnostic failure should not block the tool */ }
            }
          }
          return originalResult;
        },
        {
          name: "edit_file",
          description: (t as unknown as { description?: string }).description ?? t.name,
          schema: (t as unknown as { schema: unknown }).schema as never,
        }
      );
      return wrapped as unknown as StructuredToolInterface;
    }
    if (t.name === "read_file" && workspacePath) {
      const wrapped = tool(
        async (input: Record<string, unknown>) => {
          const rawPath = typeof input.path === "string" ? input.path : "";
          const resolvedPath = rawPath.startsWith("/") ? rawPath : resolve(workspacePath, rawPath);
          if (!isPathInWorkspace(resolvedPath, workspacePath)) {
            return `[read_file]\nstatus: blocked\npath: ${rawPath}\nnote: 读取路径不在当前会话 workspace 内。请使用 ${workspacePath} 下的路径。`;
          }
          return String(await t.invoke({ ...input, path: resolvedPath }));
        },
        {
          name: "read_file",
          description: (t as unknown as { description?: string }).description ?? t.name,
          schema: (t as unknown as { schema: unknown }).schema as never,
        }
      );
      return wrapped as unknown as StructuredToolInterface;
    }
    if (t.name === "search_code" && workspacePath) {
      const wrapped = tool(
        async (input: Record<string, unknown>) => {
          const rawPath = typeof input.path === "string" ? input.path : "";
          const resolvedPath = rawPath
            ? (rawPath.startsWith("/") ? rawPath : resolve(workspacePath, rawPath))
            : workspacePath;
          if (!isPathInWorkspace(resolvedPath, workspacePath)) {
            return `[search_code]\nstatus: blocked\npath: ${rawPath}\nnote: \u641c\u7d22\u8def\u5f84\u4e0d\u5728\u5f53\u524d\u4f1a\u8bdd workspace \u5185\u3002\u8bf7\u4f7f\u7528 ${workspacePath} \u4e0b\u7684\u8def\u5f84\u3002`;
          }
          return String(await t.invoke({ ...input, path: resolvedPath }));
        },
        {
          name: "search_code",
          description: (t as unknown as { description?: string }).description ?? t.name,
          schema: (t as unknown as { schema: unknown }).schema as never,
        }
      );
      return wrapped as unknown as StructuredToolInterface;
    }
    if (t.name === "list_files" && workspacePath) {
      const wrapped = tool(
        async (input: Record<string, unknown>) => {
          const rawPath = typeof input.path === "string" ? input.path : "";
          const resolvedPath = rawPath.startsWith("/") ? rawPath : resolve(workspacePath, rawPath);
          if (!isPathInWorkspace(resolvedPath, workspacePath)) {
            return `[list_files]\nstatus: blocked\npath: ${rawPath}\nnote: \u5217\u51fa\u8def\u5f84\u4e0d\u5728\u5f53\u524d\u4f1a\u8bdd workspace \u5185\u3002\u8bf7\u4f7f\u7528 ${workspacePath} \u4e0b\u7684\u8def\u5f84\u3002`;
          }
          return String(await t.invoke({ ...input, path: resolvedPath }));
        },
        {
          name: "list_files",
          description: (t as unknown as { description?: string }).description ?? t.name,
          schema: (t as unknown as { schema: unknown }).schema as never,
        }
      );
      return wrapped as unknown as StructuredToolInterface;
    }
    if (t.name === "git_operations" && workspacePath) {
      const wrapped = tool(
        async (input: Record<string, unknown>) => {
          const rawDir = typeof input.working_directory === "string" ? input.working_directory : "";
          const resolvedDir = rawDir
            ? (rawDir.startsWith("/") ? rawDir : resolve(workspacePath, rawDir))
            : workspacePath;
          const safeDir = isPathInWorkspace(resolvedDir, workspacePath) ? resolvedDir : workspacePath;
          return String(await t.invoke({ ...input, working_directory: safeDir }));
        },
        {
          name: "git_operations",
          description: (t as unknown as { description?: string }).description ?? t.name,
          schema: (t as unknown as { schema: unknown }).schema as never,
        }
      );
      return wrapped as unknown as StructuredToolInterface;
    }
    if (t.name === "test_runner" && workspacePath) {
      const wrapped = tool(
        async (input: Record<string, unknown>) => {
          const rawPath = typeof input.path === "string" ? input.path : "";
          const resolvedPath = rawPath
            ? (rawPath.startsWith("/") ? rawPath : resolve(workspacePath, rawPath))
            : workspacePath;
          if (!isPathInWorkspace(resolvedPath, workspacePath)) {
            return `[test_runner]\nstatus: blocked\npath: ${rawPath}\nnote: \u6d4b\u8bd5\u8def\u5f84\u4e0d\u5728\u5f53\u524d\u4f1a\u8bdd workspace \u5185\u3002\u8bf7\u4f7f\u7528 ${workspacePath} \u4e0b\u7684\u8def\u5f84\u3002`;
          }
          return String(await t.invoke({ ...input, path: resolvedPath }));
        },
        {
          name: "test_runner",
          description: (t as unknown as { description?: string }).description ?? t.name,
          schema: (t as unknown as { schema: unknown }).schema as never,
        }
      );
      return wrapped as unknown as StructuredToolInterface;
    }
    if (t.name === "claude_code" && workspacePath) {
      const wrapped = tool(
        async (input: Record<string, unknown>) => {
          // 强制 cwd 为 workspace，并在 prompt 前注入 workspace 约束
          const originalPrompt = typeof input.prompt === "string" ? input.prompt : "";
          const constrainedPrompt = `[IMPORTANT] Your working directory is: ${workspacePath}\nAll files MUST be created/read/written within this directory. Do NOT use /tmp, /repo, or any path outside this workspace. Use relative paths or paths under ${workspacePath}.\n\n${originalPrompt}`;
          return String(await t.invoke({ ...input, prompt: constrainedPrompt, cwd: workspacePath }));
        },
        {
          name: "claude_code",
          description: (t as unknown as { description?: string }).description ?? t.name,
          schema: (t as unknown as { schema: unknown }).schema as never,
        }
      );
      return wrapped as unknown as StructuredToolInterface;
    }
    if (t.name !== "run_command") return t;
    const wrapped = tool(
      async (input: { command: string; timeout_ms?: number; working_directory?: string }) => {
        if (!workspacePath) {
          return String(await t.invoke(input));
        }
        const cmd = typeof input?.command === "string" ? input.command : "";
        // Defense-in-depth: isBypassImmune is checked here against the raw command (with absolute
        // workspace paths) BEFORE normalization. This is intentional — bypass-immune patterns need
        // the original paths for accurate matching. The normalization below only affects run_command's
        // internal isDangerous patterns, which would otherwise false-positive on workspace absolute paths.
        // findForbiddenOutputPath also runs against raw paths to enforce workspace boundaries correctly.
        const bypassCheck = isBypassImmune("run_command", { command: cmd });
        if (bypassCheck) {
          return `[run_command]\nstatus: blocked\nnote: ${bypassCheck}. This operation is permanently blocked for safety.`;
        }
        const forbidden = findForbiddenOutputPath(cmd, workspacePath);
        if (forbidden) {
          return `[run_command]\nstatus: blocked\ncommand: ${cmd}\ncwd: ${workspacePath}\nnote: \u8f93\u51fa\u8def\u5f84 ${forbidden} \u4e0d\u5728\u5f53\u524d\u4f1a\u8bdd workspace \u5185\u3002\u8bf7\u6539\u4e3a ${workspacePath} \u4e0b\u8def\u5f84\u3002`;
        }
        const resolvedInputDir = input.working_directory ? resolve(input.working_directory) : workspacePath;
        const safeWorkingDirectory = isPathInWorkspace(resolvedInputDir, workspacePath)
          ? resolvedInputDir
          : workspacePath;
        return String(await t.invoke({
          ...input,
          working_directory: safeWorkingDirectory,
        }));
      },
      {
        name: "run_command",
        description: t.description,
        schema: (t as unknown as { schema: unknown }).schema as never,
      }
    );
    return wrapped as unknown as StructuredToolInterface;
  });
  const subagentRole = options?.subagentRole;
  const filteredWrappedTools = subagentRole ? filterToolsByRole(wrappedTools, subagentRole) : wrappedTools;

  // ── Claude Code 条件注入 ──────────────────────────
  // 全局关闭时移除 claude_code；全局开启时根据 agent 配置决定
  const userConfig = loadUserConfig();
  const claudeCodeGlobalEnabled = userConfig.claudeCode?.enabled ?? false;
  const shouldIncludeClaudeCode = (() => {
    if (!claudeCodeGlobalEnabled) return false;
    // 子 agent（team 模式）：根据 AgentDef.claudeCodeEnabled 决定
    if (subagentRole) {
      const agentDef = getAgentDef(subagentRole);
      return agentDef?.claudeCodeEnabled ?? false;
    }
    // 默认模式或 coordinator：全局开启即可用
    return true;
  })();
  const finalTools = shouldIncludeClaudeCode
    ? filteredWrappedTools
    : filteredWrappedTools.filter((t) => t.name !== "claude_code");

  const depth = context?.options?.subagentDepth ?? 0;
  const subagentEnabled = context?.options?.subagentEnabled ?? true;
  if (!subagentEnabled || depth >= 1) {
    const convId = options?.conversationId ?? context?.options?.conversationId;
    const subId = options?.subagentId ?? "__main__";
    const onEvt = options?.onSubagentEvent ?? context?.options?.onSubagentEvent;
    if (convId) {
      return applyHighRiskApproval(finalTools, convId, subId, workspacePath, subagentRole, onEvt);
    }
    return finalTools;
  }
  if (!context) {
    return finalTools;
  }
  // Resolve approval context for main agent path
  const mainConvId = context.options?.conversationId;
  const mainOnEvt = context.options?.onSubagentEvent;
  const conversationMode = context.options?.conversationMode ?? "default";
  const subagentResults = context.subagentResults ?? new Map<string, { name: string; summary: string }>();
  const MAX_SUBAGENT_RESULTS = 30;
  const taskTool = tool(
    async (input: { prompt: string; role?: string; dependsOn?: string[] }) => {
      const prompt = typeof input?.prompt === "string" ? input.prompt.trim() : "";
      if (!prompt) return "Error: prompt is required.";
      if (context.options?.abortSignal?.aborted) {
        return "[aborted] Task cancelled \u2014 client disconnected.";
      }
      const teamId = context.options?.teamId ?? "default";
      const role = (conversationMode === "team" && input.role && isValidTeamAgent(input.role, teamId))
        ? (input.role as AgentRole)
        : undefined;
      const dependsOn = Array.isArray(input.dependsOn)
        ? [...new Set(input.dependsOn.filter((id) => typeof id === "string"))]
        : [];

      let contextInjection = "";
      const MAX_CONTEXT_INJECTION_CHARS = 64000;
      if (dependsOn.length > 0) {
        const contextParts: string[] = [];
        const missingDeps: string[] = [];
        let contextChars = 0;
        for (const depRef of dependsOn) {
          if (contextChars >= MAX_CONTEXT_INJECTION_CHARS) {
            serverLogger.warn(`[task] dependsOn context injection capped at ${MAX_CONTEXT_INJECTION_CHARS} chars, skipping remaining deps`);
            break;
          }
          let result = subagentResults.get(depRef);
          if (!result) {
            const depRefLower = depRef.toLowerCase();
            for (const [id, r] of subagentResults.entries()) {
              if (r.name.toLowerCase() === depRefLower || id.startsWith(depRef)) {
                result = r;
                break;
              }
            }
          }
          if (!result && context.options?.workspacePath) {
            const resultsDir = join(context.options.workspacePath, ".agents", "results");
            try {
              const exactPath = join(resultsDir, `${depRef}.md`);
              if (resolve(exactPath).startsWith(resolve(resultsDir) + "/") && existsSync(exactPath)) {
                const content = readFileSync(exactPath, "utf-8");
                const nameMatch = content.match(/^# (.+?) \(/);
                result = { name: nameMatch?.[1] ?? depRef, summary: content };
              }
              if (!result) {
                const files = readdirSync(resultsDir).filter(f => f.endsWith(".md"));
                for (const f of files) {
                  const content = readFileSync(join(resultsDir, f), "utf-8");
                  const nameMatch = content.match(/^# (.+?) \(/);
                  if (nameMatch && nameMatch[1].toLowerCase() === depRef.toLowerCase()) {
                    result = { name: nameMatch[1], summary: content };
                    break;
                  }
                }
              }
            } catch { /* directory may not exist */ }
          }
          if (result) {
            const remaining = MAX_CONTEXT_INJECTION_CHARS - contextChars;
            const perDepCap = Math.min(MAX_DEPENDS_ON_SUMMARY_CHARS, remaining);
            const part = `### Context from: ${result.name}\n${truncateToolResult(result.summary, perDepCap)}`;
            contextParts.push(part);
            contextChars += part.length;
          } else {
            missingDeps.push(depRef);
          }
        }
        if (missingDeps.length > 0) {
          serverLogger.warn(`[task] dependsOn references not found: ${missingDeps.join(", ")} \u2014 these agents may not have completed yet`);
          contextParts.push(`### Warning\nThe following agent results were not available: ${missingDeps.join(", ")}. They may not have completed or the IDs may be incorrect.`);
        }
        if (contextParts.length > 0) {
          contextInjection = `\n\n## Prior Agent Results\nThe following results from previous agents are provided as context for your task:\n\n${contextParts.join("\n\n")}\n\n---\n\n`;
        }
      }
      if (context.options?.workspacePath) {
        const resultsDir = join(context.options.workspacePath, ".agents", "results");
        try {
          const files = readdirSync(resultsDir).filter(f => f.endsWith(".md"));
          if (files.length > 0) {
            contextInjection += `\n\n## Available Context Files\nPrevious agent results are saved in \`${resultsDir}/\`. You can use \`read_file\` to access full content if the injected summary is insufficient:\n${files.map(f => `- ${f}`).join("\n")}\n`;
          }
        } catch { /* dir may not exist */ }
      }
      const enrichedPrompt = contextInjection ? contextInjection + prompt : prompt;
      const subagentId = createSubagentId();
      let subagentName = deriveSubagentName(prompt);
      try {
        subagentName = await generateShortSubagentName(prompt, context.modelId);
      } catch {
        // 保留基于 prompt 的回退名称
      }
      context.options?.onSubagentEvent?.({
        kind: "lifecycle",
        phase: "started",
        subagentId,
        subagentName,
        role,
        dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
        depth: depth + 1,
        prompt,
      });
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        let summaryText = "";
        let summaryTruncated = false;
        let fullText = "";
        const MAX_FULL_TEXT = 64000;
        // Subagent harness: per-agent toggles override global numeric params.
        // Global ExecutionEnhancementsConfig provides baseline (window size, similarity threshold, etc.).
        // Per-agent AgentDef.harness provides boolean overrides (loopDetection, eval, replan).
        // Hoisted so both harnessConfig and outer retry logic can reference them without redundant I/O.
        const globalEnhancements = loadUserConfig().enhancements;
        const agentHarness = role ? getAgentDef(role)?.harness : undefined;
        const SUBAGENT_TIMEOUT_MS = agentHarness?.timeoutMs ?? globalEnhancements?.agentTimeoutMs ?? 600_000;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutTimer = setTimeout(() => reject(new Error(`Subagent timed out after ${SUBAGENT_TIMEOUT_MS / 1000}s`)), SUBAGENT_TIMEOUT_MS);
        });
        // Per-agent toggles > global toggles > hardcoded defaults.
        // When no per-agent harness is set, inherit from global ExecutionEnhancementsConfig.
        const evalOn = agentHarness?.eval ?? globalEnhancements?.evalGuard ?? false;
        const loopOn = agentHarness?.loopDetection ?? globalEnhancements?.loopDetection ?? true;
        const replanOn = agentHarness?.replan ?? globalEnhancements?.replan ?? false;
        // autoApproveReplan semantics (defined in HarnessMiddleware.tryReplan):
        //   true  → replan 直接替换当前计划步骤（自动批准）
        //   false → replan 仅作为建议注入对话，当前计划不变（需人工采纳）
        // 子 agent 默认 true（无法暂停等用户确认），per-agent 可覆盖为 false 启用建议模式。
        const autoApprove = agentHarness?.autoApproveReplan ?? true;
        const subagentOptions: StreamAgentOptions = {
          ...context.options,
          planningEnabled: true,
          planProgressEnabled: true,
          subagentDepth: depth + 1,
          subagentRole: role,
          subagentId,
          harnessConfig: {
            evalEnabled: evalOn,
            evalSkipReadOnly: agentHarness?.evalSkipReadOnly ?? globalEnhancements?.evalSkipReadOnly ?? true,
            loopDetectionEnabled: loopOn,
            replanEnabled: replanOn,
            autoApproveReplan: autoApprove,
            maxReplanAttempts: replanOn ? (globalEnhancements?.maxReplanAttempts ?? 3) : 0,
            loopWindowSize: globalEnhancements?.loopWindowSize ?? 6,
            loopSimilarityThreshold: globalEnhancements?.loopSimilarityThreshold ?? 0.7,
          },
          ...(role ? {
            subagentSystemPromptOverride: buildSubagentSystemPrompt(role, context.skillContext, context.options?.workspacePath),
          } : {}),
          onPlanEvent: (event) => {
            context.options?.onSubagentEvent?.({
              kind: "plan",
              subagentId,
              ...event,
            });
          },
        };
        // Outer retry: collect harness events to detect unresolved failures
        const outerRetryEnabled = agentHarness?.outerRetry ?? globalEnhancements?.outerRetry ?? false;
        const maxOuterRetries = outerRetryEnabled ? (globalEnhancements?.maxOuterRetries ?? 2) : 0;
        const harnessEvents: HarnessEvent[] = [];
        // Always forward harness events to parent (for frontend display).
        // Also collect them locally for outer retry decision logic.
        subagentOptions.onHarnessEvent = (event) => {
          context.options?.onSubagentEvent?.({
            kind: "harness",
            subagentId,
            harnessKind: event.kind,
            data: event.data,
            timestamp: event.timestamp,
          });
          if (outerRetryEnabled) {
            harnessEvents.push(event);
          }
        };
        const runSubagent = async (messages: BaseMessage[]) => {
          for await (const chunk of _streamAgentWithTokens!(
            messages,
            (token) => {
              if (!summaryTruncated) {
                const next = summaryText + token;
                if (next.length > MAX_TASK_TOOL_RESULT_CHARS) {
                  summaryText = next.slice(0, MAX_TASK_TOOL_RESULT_CHARS);
                  summaryTruncated = true;
                } else {
                  summaryText = next;
                }
              }
              if (fullText.length < MAX_FULL_TEXT) {
                fullText += token;
                if (fullText.length > MAX_FULL_TEXT) fullText = fullText.slice(0, MAX_FULL_TEXT);
              }
              context.options?.onSubagentEvent?.({
                kind: "token",
                subagentId,
                content: token,
              });
            },
            context.modelId,
            (reasoning) => {
              context.options?.onSubagentEvent?.({
                kind: "reasoning",
                subagentId,
                content: reasoning,
              });
            },
            context.skillContext,
            subagentOptions
          )) {
            const key = chunk && typeof chunk === "object" ? Object.keys(chunk as object)[0] : "";
            const part = key
              ? (chunk as Record<string, { messages?: BaseMessage[]; reasoning?: string }>)[key]
              : undefined;
            if (key === "llmCall" && part?.messages?.length) {
              const aiMsg = part.messages.find((m) => (m as { _getType?: () => string })._getType?.() === "ai") as
                | { tool_calls?: Array<{ name: string; args?: unknown }> }
                | undefined;
              if (Array.isArray(aiMsg?.tool_calls)) {
                for (const tc of aiMsg.tool_calls) {
                  context.options?.onSubagentEvent?.({
                    kind: "tool_call",
                    subagentId,
                    name: tc.name,
                    input: stringifyToolArgs(tc.args),
                  });
                }
              }
            }
            if (key === "toolNode" && part?.messages?.length) {
              for (const msg of part.messages) {
                const toolMsg = msg as { _getType?: () => string; name?: string; content?: string };
                if (toolMsg._getType?.() === "tool" && toolMsg.name) {
                  context.options?.onSubagentEvent?.({
                    kind: "tool_result",
                    subagentId,
                    name: toolMsg.name,
                    output: typeof toolMsg.content === "string" ? toolMsg.content : "",
                  });
                }
              }
            }
            if (!summaryText && part?.messages?.length) {
              const ai = part.messages
                .filter((m) => (m as { _getType?: () => string })._getType?.() === "ai")
                .pop();
              if (ai) {
                summaryText = getTextFromMessage(ai).trim();
              }
            }
          }
        };
        // Outer retry loop: re-run subagent if harness detected unresolved failures
        let currentMessages: BaseMessage[] = [new HumanMessage(enrichedPrompt)];
        for (let outerIteration = 0; outerIteration <= maxOuterRetries; outerIteration++) {
          // Reset state for each iteration
          if (outerIteration > 0) {
            summaryText = "";
            summaryTruncated = false;
            fullText = "";
            // Notify parent that this subagent is retrying so frontend can reset its state
            context.options?.onSubagentEvent?.({
              kind: "lifecycle",
              phase: "started",
              subagentId,
              subagentName,
              role,
              depth: depth + 1,
              prompt: `[Harness outer retry ${outerIteration}/${maxOuterRetries}] ${prompt}`,
            });
            // Inject failure context from previous iteration
            const failureSummary = harnessEvents
              .filter((e) => (e.kind === "eval" && (e.data as EvalResult).verdict === "fail") ||
                             (e.kind === "loop_detection" && (e.data as LoopDetectionResult).detected === true))
              .map((e) => e.kind === "eval"
                ? `Eval fail step ${(e.data as EvalResult).stepIndex}: ${(e.data as EvalResult).reason}`
                : `Loop detected: ${(e.data as LoopDetectionResult).description ?? "repeated pattern"}`)
              .join("\n");
            currentMessages = [
              new HumanMessage(enrichedPrompt),
              new HumanMessage(`[Harness] Previous attempt failed. Issues:\n${failureSummary}\n\nTry a fundamentally different approach. Do NOT repeat the same strategies.`),
            ];
            harnessEvents.length = 0; // clear for next iteration
          }
          await Promise.race([runSubagent(currentMessages), timeoutPromise]);
          // Check if outer retry needed
          if (outerIteration < maxOuterRetries && outerRetryEnabled && harnessEvents.length > 0) {
            const hasUnresolved = harnessEvents.some((e) =>
              (e.kind === "eval" && (e.data as EvalResult).verdict === "fail") ||
              (e.kind === "loop_detection" && (e.data as LoopDetectionResult).detected === true)
            );
            if (hasUnresolved) continue; // retry
          }
          break; // success or no retry needed
        }
        if (timeoutTimer) clearTimeout(timeoutTimer);
        const rawSummary = summaryText.trim() || NO_VISIBLE_OUTPUT_MESSAGE;
        const summary = truncateToolResult(rawSummary, MAX_TASK_TOOL_RESULT_CHARS);
        subagentResults.set(subagentId, { name: subagentName, summary });
        const wpPath = context.options?.workspacePath;
        if (wpPath) {
          try {
            const resultsDir = join(wpPath, ".agents", "results");
            mkdirSync(resultsDir, { recursive: true });
            const fullResult = fullText.trim() || rawSummary;
            const fileContent = `# ${subagentName} (${role ?? "general"})\nPrompt: ${prompt.slice(0, 500)}${prompt.length > 500 ? "..." : ""}\nDependsOn: ${dependsOn.join(", ") || "none"}\n---\n${fullResult}`;
            writeFileSync(join(resultsDir, `${subagentId}.md`), fileContent, "utf-8");
          } catch {
            // Non-critical — don't fail the task if file write fails
          }
        }
        if (subagentResults.size > MAX_SUBAGENT_RESULTS) {
          const keysToDelete = [...subagentResults.keys()].slice(0, subagentResults.size - MAX_SUBAGENT_RESULTS);
          for (const k of keysToDelete) subagentResults.delete(k);
        }
        context.options?.onSubagentEvent?.({
          kind: "lifecycle",
          phase: "completed",
          subagentId,
          subagentName,
          role,
          dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
          depth: depth + 1,
          prompt,
          summary,
        });
        return `[subagentId: ${subagentId}] [name: ${subagentName}] [role: ${role ?? "general"}]\n\n${summary}`;
      } catch (error) {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        const errText = error instanceof Error ? error.message : String(error);
        const truncatedErr = errText.length > 500 ? errText.slice(0, 500) + "... [truncated]" : errText;
        context.options?.onSubagentEvent?.({
          kind: "lifecycle",
          phase: "failed",
          subagentId,
          subagentName,
          role,
          dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
          depth: depth + 1,
          prompt,
          error: truncatedErr,
        });
        return `[error] Subagent failed: ${truncatedErr}`;
      }
    },
    {
      name: "task",
      description: conversationMode === "team"
        ? `Spawn a subagent to perform a subtask. Returns the result prefixed with [subagentId: xxx] [name: xxx] \u2014 use these identifiers in dependsOn of subsequent tasks to pass context. In team mode, always specify a role from the available team members.`
        : "Spawn a subagent to perform a subtask. Returns the result prefixed with [subagentId: xxx] [name: xxx] \u2014 use these identifiers in dependsOn of subsequent tasks to pass context.",
      schema: z.object({
        prompt: z.string().describe("Subtask instruction for the subagent"),
        role: z.string().optional()
          .describe("Agent role ID for the subagent. In team mode, must be one of the available team members. In default mode this is ignored."),
        dependsOn: z.array(z.string()).optional()
          .describe("subagentId or name of previously completed sub-agents whose results should be injected as context."),
      }),
    }
  );

  if (conversationMode === "team" && depth === 0) {
    const coordinatorAllowed = new Set(["task", "read_file", "load_skill", "get_time", "fetch_url", "search_code", "list_files", "web_search", "project_search", "project_snapshot"]);
    const coordinatorTools = filteredWrappedTools.filter((t) => coordinatorAllowed.has(t.name));
    // Coordinator tools (task, read_file, etc.) don't include run_command/write_file/edit_file,
    // so applyHighRiskApproval is unnecessary here — skip it for performance.
    return [...coordinatorTools, taskTool as unknown as StructuredToolInterface];
  }

  const baseTools = [...filteredWrappedTools, taskTool as unknown as StructuredToolInterface];
  return mainConvId ? applyHighRiskApproval(baseTools, mainConvId, "__main__", workspacePath, subagentRole, mainOnEvt) : baseTools;
}
