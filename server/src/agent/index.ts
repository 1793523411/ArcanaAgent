import { StateGraph, MessagesAnnotation, START, END } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, BaseMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { getModelAdapter } from "../llm/adapter.js";
import type { ToolCallResult } from "../llm/adapter.js";
import { getToolsByIds, listToolIds } from "../tools/index.js";
import { getMcpTools } from "../mcp/client.js";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { getSkillCatalogForAgent } from "../skills/manager.js";
import { serverLogger } from "../lib/logger.js";
import { buildPlanningPrelude, type PlanStep } from "./planning.js";
import { backgroundManager } from "./backgroundManager.js";
import { resolve, join } from "path";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "fs";
import { z } from "zod";
import { getAgentConfig, isValidTeamAgent, getTeamAgents, isAllToolsAllowed, type AgentRole } from "./roles.js";
import { getTeamDef } from "../storage/teamDefs.js";
import { approvalManager } from "./approvalManager.js";
import { estimateBaseMessageTokens } from "../lib/tokenizer.js";
import { getModelContextWindow } from "../config/models.js";
import { detectDiagnosticCommand, runDiagnostic } from "./diagnostics.js";

type MessagesState = typeof MessagesAnnotation.State;
export type ConversationMode = "default" | "team";
export type { AgentRole } from "./roles.js";
export interface PlanStreamEvent {
  phase: "created" | "running" | "completed";
  steps: Array<PlanStep & { evidences: string[]; completed: boolean }>;
  currentStep: number;
  toolName?: string;
}

interface AgentExecutionOptions {
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

interface StreamAgentOptions extends AgentExecutionOptions {
  planProgressEnabled?: boolean;
  onPlanEvent?: (event: PlanStreamEvent) => void;
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

const BASE_SYSTEM_PROMPT = `You are a versatile, highly capable AI assistant with access to tools, skills, and MCP (Model Context Protocol) integrations. You help users effectively with any task — from coding and data analysis to research and creative work.

## Communication
- **Match the user's language**: respond in Chinese if they write in Chinese, English for English, etc. Never mix languages unnecessarily.
- **Be concise**: avoid filler, preambles like "Sure!" or "Of course!", and unnecessary verbosity. Get straight to the point.
- **Format clearly**: use Markdown — code blocks with language tags, headers for structure, bullet points for lists, tables for comparisons.
- **Show results**: after tool execution, summarize what happened and present outputs clearly. Don't just say "done" — show the key results.

## Tool Usage Strategy
You have access to built-in tools (run_command, read_file, calculator, get_time, etc.) and MCP tools from external servers (listed below if connected).

**CRITICAL: Never output your internal reasoning or planning as text.** Do NOT write things like "I need to call tool X" or "Let me think about which tool to use" — just call the tool directly. Your visible output should only contain information meant for the user, never your own thought process about tool selection or task decomposition.

**When to use tools vs. direct response:**
- Answer from knowledge when no system interaction is needed
- Use tools when you need to: execute code, read/write files, run commands, fetch data, or perform any system operation
- For complex tasks, plan the steps first, then execute tools sequentially, checking results between each step
- For run_command, if output contains signal \`__RUN_COMMAND_EXECUTED__\`, treat the command as command executed successfully
- For run_command, if output contains signal \`__RUN_COMMAND_DUPLICATE_SKIPPED__\`, do not repeat the same command; move to next step or summarize
- For file/content discovery in terminal commands, prefer \`rg\` (ripgrep) over \`find\` and \`grep\`:
  - Search file contents: \`rg "pattern"\` or \`rg "pattern" path/\` (instead of \`grep -r\` or \`find ... -exec grep\`)
  - Find files by name/extension: \`rg --files -g "*.py"\` or \`rg --files -g "*keyword*"\` (instead of \`find . -name "*.py"\`)
  - Combined: \`rg --files -g "*.ts" | rg "component"\` for precise file name filtering
  - \`rg\` is much faster, respects .gitignore, and produces cleaner output. Only fall back to \`find\` for metadata queries (size, mtime, permissions) that \`rg\` cannot handle.
- When multiple independent subtasks exist, you may call \`task\` multiple times in the same turn

**Background tasks for long-running commands:**
- Use \`background_run\` for commands that likely take multiple seconds to complete. Judge by these criteria:
  - **Network I/O**: Downloads, uploads, API calls, git clone, package installation
  - **Heavy computation**: Compilation, builds, compression, video/image processing, model training
  - **Batch operations**: Full test suites, database migrations, batch file processing
  - **Script execution**: Any shell/Python/Node/etc. script where runtime is unpredictable — prefer background by default
  - **Waiting/polling**: sleep >3s, watching for changes, waiting for service startup
- Common examples (but not limited to):
  - Package: \`npm install\`, \`pip install\`, \`yarn\`, \`composer install\`, \`go get\`
  - Build: \`npm run build\`, \`docker build\`, \`cargo build\`, \`make\`, \`webpack\`
  - Test: \`npm test\`, \`pytest\`, \`cargo test\` (full suites, not single tests)
  - Files: \`wget\`, \`curl\`, \`tar\`, \`zip\`, \`rsync\`, \`dd\`
  - Scripts: \`python script.py\`, \`bash script.sh\`, \`node script.js\`, \`./script\` — default to background unless user explicitly says it's quick
- **Judgment principle**: When uncertain, prefer \`background_run\`. Cost of false positive (quick command in background) is low; cost of false negative (slow command blocking) is high.
- After spawning, continue immediately with other work — completion notifications auto-inject as \`[bg:task_id][status] preview\`
- Use \`background_check\` for full output, \`background_cancel\` to terminate
- Max 4 concurrent tasks for parallel execution

**CRITICAL — Always provide a final text response:**
- After ALL tool calls are complete, you MUST generate a clear text response summarizing the results, findings, or output for the user.
- NEVER end your turn with only tool calls and no text — the user needs to see a human-readable summary.
- If tools produced data or files, present the key results, not just "done".
- If a multi-step task is complete, provide a structured summary of what was accomplished.

**Error handling:**
- If a tool fails, read the error carefully, diagnose the issue, and retry with a fix
- Common fixes: install missing dependencies, correct file paths, adjust permissions, fix syntax
- If repeated failures occur, explain the issue to the user and suggest alternatives
- Never silently ignore errors — always report what happened

## Auto-Verification Protocol
After editing or writing code files, the system automatically runs diagnostics (typecheck/lint).
- If errors appear in the tool result, try to fix them in the next step before proceeding to other tasks
- Continue the edit → verify → fix cycle, up to a maximum of 5 attempts
- For complex errors, read the relevant source files first to understand context before fixing
- **Escape conditions** — stop the fix loop and report to the user if ANY of these apply:
  - You have already attempted 5 fix iterations for the same diagnostic errors
  - The errors appear to be pre-existing (not caused by your edits) — e.g. errors in files you did not touch, or third-party type definition issues
  - The errors are environmental (missing dependencies, wrong tool version, config issues) rather than code errors
  - The same error persists after 2 consecutive identical fix attempts (you are going in circles)
- When stopping, briefly summarize the unresolved errors and suggest what the user can do

## Skills
Skills are specialized capabilities defined in SKILL.md files. When a user's request matches a listed skill:
1. Call load_skill with the exact skill name first
2. Follow the loaded instructions precisely
3. Execute scripts with their full absolute paths via run_command, and ALWAYS set working_directory to the skill directory (shown in <skill_directory> tag after loading)
4. Install dependencies automatically if needed (pip install, npm install, etc.) — also run these with working_directory set to the skill directory
5. Use read_file to check reference docs or saved outputs when mentioned
6. Handle setup steps proactively without asking the user
7. Present skill outputs clearly and completely

## Safety
- **NEVER** execute destructive system commands (rm -rf /, mkfs, dd to disk, shutdown, reboot, etc.)
- **NEVER** read or expose credentials, private keys, API keys, or sensitive environment variables
- **NEVER** modify system-critical files (/etc/passwd, /etc/shadow, boot configs, etc.)
- For potentially risky operations, briefly state what you plan to do before executing
- When uncertain about safety, ask the user for confirmation

## Workspace & Artifacts
Each conversation has a dedicated workspace directory. Save ALL generated files (search results, downloads, processed data, etc.) to this workspace using absolute paths. The user can preview these files directly in the UI.
**IMPORTANT**: Always use ABSOLUTE paths (starting with /) when working with files and directories. Never use relative paths like ../data/... in run_command. The workspace path provided to you is already an absolute path — use it directly.

## Context Awareness
- Earlier parts of this conversation may have been summarized (marked as [此前对话摘要]) to save context space. Treat summaries as reliable context.
- If the user references something not in your available context, acknowledge this honestly and ask for clarification rather than guessing.
- When the conversation is long, briefly recap relevant context before diving into a complex task.`;

function buildTeamModePrompt(teamId: string): string {
  const agents = getTeamAgents(teamId);
  const team = getTeamDef(teamId);
  const agentList = agents.map((a) => `  - **${a.id}** (${a.icon} ${a.name}): ${a.description}`).join("\n");
  const agentIds = agents.map((a) => `\`${a.id}\``).join(", ");

  let prompt = `

## Team Mode — Orchestrator Role
You are operating in **team orchestration mode** as the Coordinator. You delegate implementation work to specialized sub-agents via the \`task\` tool.

### CRITICAL: Coordinator vs. Executor
- For **conversational replies** (greetings, clarifications, simple Q&A that need no tools): respond directly — no delegation needed.
- For **any task that requires tool execution** (running commands, reading/writing files, coding, testing, analysis): you **MUST** delegate via the \`task\` tool. **Do NOT** call run_command, read_file, write_file, etc. yourself.
- Your job as coordinator: analyze the request → decide if delegation is needed → decompose into tasks → delegate via \`task\` → synthesize results → report to user.
- When in doubt, delegate. It's better to delegate a simple coding task than to bypass the team workflow.
- **IMPORTANT: After sub-agents complete, do NOT "fix up" or "continue" their work by calling tools yourself.** If something needs fixing, delegate a NEW sub-agent. The ONLY tools you should call are \`task\` (to delegate) and optionally \`read_file\` (to check results before deciding next steps). Never call run_command or write_file directly.

### Available Team Members
${agentList}

### Delegation Rules
- **Always specify a role** when calling the \`task\` tool. Available roles: ${agentIds}.
- Choose the most appropriate agent based on the task requirements and each agent's specialization.
- For complex tasks, decompose them and assign to multiple agents with proper dependencies.

### Orchestration Patterns
- **Simple task**: delegate directly to the appropriate agent.
- **Pipeline**: delegate sequentially with \`dependsOn\` to chain agent outputs.
- **Parallel work**: spawn multiple agents for independent subtasks, then a follow-up agent (\`dependsOn: [agent1_id, agent2_id]\`) to validate or synthesize.

### Context Passing with \`dependsOn\`
- Each completed sub-agent's result starts with \`[subagentId: xxx] [name: xxx]\`. **Use the exact subagentId or name** in subsequent \`dependsOn\` arrays.
- The system will automatically inject the prior agent's summary into the new agent's context.
- **You MUST call dependent tasks in separate rounds** (not in the same turn), so you have the subagentId from the prior task's result.

### Progress Reporting
- After each sub-agent completes, briefly summarize their output and decide the next delegation.
- When ALL sub-agents are done, provide a consolidated summary to the user.
- Do NOT interleave your own tool calls between sub-agent delegations.

### Safety
- Do not execute high-risk refactors directly. First delegate a plan draft, then review and explicitly approve before implementation.

### Review-Fix Iteration Pattern
For coding tasks, always follow this cycle:
1. Delegate implementation to **coder**
2. Delegate review to **reviewer** (dependsOn: [coder_id])
3. If reviewer says \`VERDICT: NEEDS_FIX\`:
   - Delegate fix to **coder** (dependsOn: [reviewer_id]) with instruction to address each issue
   - Re-delegate review to **reviewer** (dependsOn: [fix_coder_id])
4. Maximum **3 iterations**. After 3 rounds, report unresolved issues to user.
5. If reviewer says \`VERDICT: PASS\`, proceed to next task or report success.`;

  if (team?.coordinatorPrompt) {
    prompt += `\n\n### Additional Instructions\n${team.coordinatorPrompt}`;
  }

  return prompt;
}

function buildMcpToolsSection(): string {
  const mcpTools = getMcpTools();
  if (mcpTools.length === 0) return "";
  const lines = mcpTools.map((t) => `- \`${t.name}\`: ${t.description ?? t.name}`);
  return `\n\n## Available MCP Tools\nThe following MCP tools are currently connected and ready to use. Call them directly without asking the user for tool names:\n${lines.join("\n")}`;
}

function buildSystemPrompt(skillContext?: string, conversationMode: ConversationMode = "default", teamId?: string, workspacePath?: string): string {
  const modePrompt = conversationMode === "team" ? buildTeamModePrompt(teamId ?? "default") : "";
  const workspaceSection = workspacePath
    ? `\n\n## Current Workspace\nYour workspace absolute path is: \`${workspacePath}\`\nAll file operations (read, write, output) MUST use this directory. Use absolute paths like \`${workspacePath}/filename.ext\`. Never write files to any other location.`
    : "";
  const mcpSection = buildMcpToolsSection();
  const skillSection = skillContext || getSkillCatalogForAgent();
  return BASE_SYSTEM_PROMPT + modePrompt + workspaceSection + mcpSection + skillSection;
}

function getTextFromChunk(chunk: { content?: unknown }): string {
  const c = chunk.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === "string" ? x : (x as { text?: string })?.text ?? "")).join("");
  return "";
}

function getTextFromMessage(msg: { content?: unknown }): string {
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === "string" ? x : (x as { text?: string })?.text ?? "")).join("");
  return "";
}

function getReasoningFromMessage(msg: BaseMessage): string | undefined {
  const m = msg as { additional_kwargs?: { reasoning_content?: string }; content?: unknown };
  const fromKwargs = m.additional_kwargs?.reasoning_content;
  if (typeof fromKwargs === "string" && fromKwargs.trim()) return fromKwargs.trim();
  const c = m.content;
  if (!Array.isArray(c)) return undefined;
  const parts = c
    .filter((x) => x && typeof x === "object" && (
      (x as { type?: string }).type === "reasoning" ||
      (x as { type?: string }).type === "thinking"
    ))
    .map((x) => {
      const obj = x as { text?: string; thinking?: string };
      return typeof obj.thinking === "string" ? obj.thinking : (obj.text ?? "");
    })
    .join("");
  return parts.trim() || undefined;
}

function getReasoningFromChunk(chunk: { content?: unknown }): string {
  const c = chunk.content;
  if (!Array.isArray(c)) return "";
  return c
    .filter((x) => x && typeof x === "object" && (
      (x as { type?: string }).type === "reasoning" ||
      (x as { type?: string }).type === "thinking"
    ))
    .map((x) => {
      const obj = x as { text?: string; thinking?: string };
      return typeof obj.thinking === "string" ? obj.thinking : (obj.text ?? "");
    })
    .join("");
}

function getLastAssistantText(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg._getType() !== "ai") continue;
    const text = getTextFromMessage(msg).trim();
    if (text) return text;
  }
  return "";
}

function buildBackgroundResultMessage(): HumanMessage | null {
  const notifications = backgroundManager.drainNotifications();
  if (notifications.length === 0) return null;
  const lines = notifications.map((item) => `[bg:${item.taskId}][${item.status}] ${item.result}`);
  return new HumanMessage(`<background-results>\n${lines.join("\n")}\n</background-results>`);
}

function createSubagentId(): string {
  return `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 从任务 prompt 生成简短可读的子 Agent 展示名（约 24 字内），用于 AI 名称返回前的占位 */
function deriveSubagentName(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  const maxLen = 24;
  if (oneLine.length <= maxLen) return oneLine || "子任务";
  return oneLine.slice(0, maxLen) + "…";
}

const SUBAGENT_NAME_SYSTEM = "你只输出一个极短的标题，不要任何解释、标点或换行。中文 4～10 字或英文 2～6 个词。";
const SUBAGENT_NAME_MAX_LEN = 12;

/** 用 LLM 根据任务 prompt 生成简短语义化名称（异步，不阻塞子任务启动） */
async function generateShortSubagentName(prompt: string, modelId?: string): Promise<string> {
  const llm = getModelAdapter(modelId).getLLM();
  const oneLine = prompt.replace(/\s+/g, " ").trim().slice(0, 200);
  const msg = await llm.invoke([
    new SystemMessage(SUBAGENT_NAME_SYSTEM),
    new HumanMessage(`任务：${oneLine}\n短标题：`),
  ]);
  const text = typeof msg.content === "string" ? msg.content : "";
  const name = text.replace(/\s+/g, " ").trim().replace(/^["'「『]|["'」』]$/g, "").slice(0, SUBAGENT_NAME_MAX_LEN) || "子任务";
  return name;
}

function stringifyToolArgs(args: unknown): string {
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return "{}";
  }
}

function safeParseArgs(argsStr: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argsStr);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

const WRITE_FILE_SCHEMA_HINT = `write_file 需要 path（字符串）以及 content（字符串）或 content_base64（Base64 字符串）二选一。大段 HTML/CSS 强烈建议用 content_base64 传参，避免 JSON 转义问题。`;

function getWriteFileArgsError(args: Record<string, unknown>): string | null {
  if (typeof args.path !== "string" || args.path.trim() === "") return "缺少或无效的 path（必须为非空字符串）";
  const hasContent = typeof args.content === "string" && args.content.length > 0;
  const hasBase64 = typeof args.content_base64 === "string" && args.content_base64.length > 0;
  if (!hasContent && !hasBase64) return "必须提供 content 或 content_base64 之一。大段 HTML 请用 content_base64。";
  return null;
}

const MAX_TOOL_CALL_ROUNDS_MESSAGE = "(已达到最大工具调用轮次)";
const NO_VISIBLE_OUTPUT_MESSAGE = "(工具调用已结束，但未生成可展示文本)";
const FINAL_ONLY_PROMPT = "请不要继续思考，也不要调用任何工具。请直接输出给用户的最终答复正文。";

const MAX_SINGLE_TOOL_RESULT_CHARS = 5000;
/** Per-task result cap: expanded for richer context passing */
const MAX_TASK_TOOL_RESULT_CHARS = 16000;
/** DependsOn context cap per dependency */
const MAX_DEPENDS_ON_SUMMARY_CHARS = 16000;
const MIN_CONVERSATION_TOKENS_CAP = 16000;
const CONVERSATION_TOKEN_CAP_RATIO = 0.55;
/** Maximum review-fix iterations before reporting unresolved issues */
const MAX_REVIEW_ITERATIONS = 3;
const MAX_CONVERSATION_TOKENS = 60_000;

function truncateToolResult(result: string, maxChars = MAX_SINGLE_TOOL_RESULT_CHARS): string {
  if (result.length <= maxChars) return result;
  const omitted = result.length - maxChars;
  const looksLikeJson = result.trimStart().startsWith("{") || result.trimStart().startsWith("[");
  if (looksLikeJson) {
    return result.slice(0, maxChars) + `\n... [truncated ${omitted} chars, output too long]`;
  }
  const half = Math.floor(maxChars / 2);
  return `${result.slice(0, half)}\n\n... [truncated ${omitted} chars] ...\n\n${result.slice(-half)}`;
}

function resolveConversationTokenCap(modelId?: string): number {
  let contextWindow: number;
  try {
    contextWindow = getModelContextWindow(modelId);
  } catch {
    // Config file read/parse failure — fall back to a safe default
    contextWindow = 128000;
  }
  const dynamicCap = Math.floor(contextWindow * CONVERSATION_TOKEN_CAP_RATIO);
  return Math.max(MIN_CONVERSATION_TOKENS_CAP, Math.min(MAX_CONVERSATION_TOKENS, dynamicCap));
}

/**
 * Prune conversation messages when total token count exceeds the cap.
 * Strategy:
 *   1. Compress old ToolMessage contents (keep the most recent ones intact).
 *   2. If still over limit, truncate tool_call args inside old AIMessages.
 *   3. If still over limit, drop oldest non-system message pairs as last resort.
 */
function pruneConversationIfNeeded(messages: BaseMessage[], tokenCap = MAX_CONVERSATION_TOKENS): BaseMessage[] {
  const total = estimateBaseMessageTokens(messages);
  if (total <= tokenCap) return messages;

  const cloned = [...messages];
  let currentTotal = total;

  // --- Pass 0: compress old task ToolMessage results ---
  // Task tool results are large (~3500 chars each). Compress all but the last 2
  // to a short summary so the coordinator retains key info at much lower cost.
  const taskToolIndices: number[] = [];
  for (let i = 0; i < cloned.length; i++) {
    const msg = cloned[i];
    if (msg._getType() === "tool" && (msg as unknown as { name?: string }).name === "task") {
      taskToolIndices.push(i);
    }
  }
  const protectedTaskCount = 2;
  const compressibleTasks = taskToolIndices.slice(0, Math.max(0, taskToolIndices.length - protectedTaskCount));
  for (const idx of compressibleTasks) {
    if (currentTotal <= tokenCap) break;
    const msg = cloned[idx];
    const content = typeof msg.content === "string" ? msg.content : "";
    if (content.length <= 250) continue; // already short enough
    // Extract metadata header if present: [subagentId: xxx] [name: yyy] [role: zzz]
    const headerMatch = content.match(/^(\[subagentId:.*?\]\s*\[name:.*?\]\s*\[role:.*?\])/);
    const header = headerMatch ? headerMatch[1] : "";
    const body = header ? content.slice(header.length).trim() : content;
    const compressed = header
      ? `${header}\n${body.slice(0, 200)}... [compressed — use dependsOn to access full result]`
      : `${body.slice(0, 200)}... [compressed — use dependsOn to access full result]`;
    const toolMsg = msg as ToolMessage;
    cloned[idx] = new ToolMessage({
      content: compressed,
      tool_call_id: toolMsg.tool_call_id,
      name: (toolMsg as unknown as { name?: string }).name,
    });
    currentTotal = estimateBaseMessageTokens(cloned);
  }

  if (currentTotal <= tokenCap) return cloned;

  // --- Pass 1: compress old ToolMessage contents ---
  const toolIndices: number[] = [];
  for (let i = 0; i < cloned.length; i++) {
    if (cloned[i]._getType() === "tool") toolIndices.push(i);
  }

  // Keep the last 4 tool results intact; compress the rest
  const protectedCount = 4;
  const compressible = toolIndices.slice(0, Math.max(0, toolIndices.length - protectedCount));

  for (const idx of compressible) {
    if (currentTotal <= tokenCap) break;
    const msg = cloned[idx];
    const content = typeof msg.content === "string" ? msg.content : "";
    const headLen = Math.min(100, content.length);
    const tailLen = Math.min(100, Math.max(0, content.length - headLen));
    const marker = ` ... [pruned ${content.length - headLen - tailLen} chars] ... `;
    if (content.length <= headLen + marker.length + tailLen) continue;
    const summary = content.slice(0, headLen) + marker + (tailLen > 0 ? content.slice(-tailLen) : "");
    const toolMsg = msg as ToolMessage;
    cloned[idx] = new ToolMessage({
      content: summary,
      tool_call_id: toolMsg.tool_call_id,
      name: (toolMsg as unknown as { name?: string }).name,
    });
    currentTotal = estimateBaseMessageTokens(cloned);
  }

  if (currentTotal <= tokenCap) return cloned;

  // --- Pass 2: truncate tool_call args inside old AIMessages ---
  // Keep the last 4 AI messages intact; truncate args in earlier ones.
  const aiIndices: number[] = [];
  for (let i = 0; i < cloned.length; i++) {
    if (cloned[i]._getType() === "ai") aiIndices.push(i);
  }
  const compressibleAi = aiIndices.slice(0, Math.max(0, aiIndices.length - 4));
  for (const idx of compressibleAi) {
    if (currentTotal <= tokenCap) break;
    const msg = cloned[idx] as AIMessage;
    const toolCalls = (msg as unknown as { tool_calls?: Array<{ id: string; name: string; args: unknown }> }).tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) continue;
    type RawToolCall = { id: string; name: string; args: Record<string, unknown>; type?: "tool_call" };
    const truncatedCalls = (toolCalls as RawToolCall[]).map((tc) => {
      const argStr = JSON.stringify(tc.args ?? {});
      if (argStr.length <= 200) return tc;
      return { ...tc, args: { _truncated: argStr.slice(0, 200) + "... [truncated]" } };
    });
    cloned[idx] = new AIMessage({
      content: typeof msg.content === "string" ? msg.content : "",
      tool_calls: truncatedCalls,
    });
    currentTotal = estimateBaseMessageTokens(cloned);
  }

  if (currentTotal <= tokenCap) return cloned;

  // --- Pass 3: drop oldest non-system message groups as last resort ---
  // We must drop messages in coherent groups to preserve the AI↔Tool pairing
  // that LLM APIs require (every tool_call must have a matching ToolMessage).
  // A "group" is: consecutive run of [Human?, AI(with tool_calls), Tool, Tool, ...].
  serverLogger.warn(
    `[prune] Pass 1+2 insufficient (${currentTotal} tokens > ${tokenCap} cap). Dropping oldest messages.`
  );
  while (currentTotal > tokenCap) {
    // Find the first non-system message
    const startIdx = cloned.findIndex((m) => m._getType() !== "system");
    if (startIdx < 0) break; // only system messages left

    // Determine the group to drop starting at startIdx
    let endIdx = startIdx; // inclusive
    const startType = cloned[startIdx]._getType();

    if (startType === "human") {
      // Drop human + any immediately following AI + its tool messages
      endIdx = startIdx;
      if (endIdx + 1 < cloned.length && cloned[endIdx + 1]._getType() === "ai") {
        endIdx++;
        // Also drop trailing tool messages that belong to this AI's tool_calls
        while (endIdx + 1 < cloned.length && cloned[endIdx + 1]._getType() === "tool") {
          endIdx++;
        }
      }
    } else if (startType === "ai") {
      // Drop AI + its trailing tool messages
      endIdx = startIdx;
      while (endIdx + 1 < cloned.length && cloned[endIdx + 1]._getType() === "tool") {
        endIdx++;
      }
    } else if (startType === "tool") {
      // Orphaned tool message(s) — drop consecutive tools
      endIdx = startIdx;
      while (endIdx + 1 < cloned.length && cloned[endIdx + 1]._getType() === "tool") {
        endIdx++;
      }
    } else {
      // Unknown type — drop single message
      endIdx = startIdx;
    }

    const dropCount = endIdx - startIdx + 1;
    const droppedTokens = estimateBaseMessageTokens(cloned.slice(startIdx, endIdx + 1));
    cloned.splice(startIdx, dropCount);
    currentTotal -= droppedTokens;
  }

  return cloned;
}

function filterToolsByRole(tools: StructuredToolInterface[], agentId: string): StructuredToolInterface[] {
  const config = getAgentConfig(agentId);
  if (!config || isAllToolsAllowed(config.allowedTools)) return tools;
  const allowed = new Set(config.allowedTools);
  return tools.filter((t) => allowed.has(t.name));
}

function buildSubagentSystemPrompt(agentId: string, skillContext?: string, workspacePath?: string): string {
  const config = getAgentConfig(agentId);
  const base = BASE_SYSTEM_PROMPT + buildMcpToolsSection() + (skillContext || getSkillCatalogForAgent());
  const wsSection = workspacePath
    ? `\n\n## Current Workspace\nYour workspace absolute path is: \`${workspacePath}\`\nAll file operations (read, write, output) MUST use this directory. Use absolute paths like \`${workspacePath}/filename.ext\`. Never write files to any other location.`
    : "";
  if (!config) return base + wsSection;
  return base + wsSection + `\n\n## Role: ${config.displayName}\n${config.systemPromptAddendum}`;
}

const HIGH_RISK_COMMAND_PATTERNS = [
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

function isHighRiskCommand(command: string): string | null {
  for (const pattern of HIGH_RISK_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return command.trim().slice(0, 120);
    }
  }
  return null;
}

function isHighRiskWrite(path: string, workspacePath?: string): string | null {
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
  return null;
}

function wrapToolWithApproval(
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

function getAllTools(): StructuredToolInterface[] {
  const allIds = listToolIds();
  const builtIn = getToolsByIds(allIds);
  const mcp = getMcpTools();
  return [...builtIn, ...mcp];
}

interface RuntimeToolBuildContext {
  modelId?: string;
  skillContext?: string;
  options?: AgentExecutionOptions;
  subagentResults?: Map<string, { name: string; summary: string }>;
}

function isPathInWorkspace(pathText: string, workspacePath: string): boolean {
  const workspace = resolve(workspacePath);
  const target = resolve(pathText);
  return target === workspace || target.startsWith(`${workspace}/`);
}

function isLikelyProjectMirrorPath(pathText: string): boolean {
  const normalized = pathText.replace(/\\/g, "/").replace(/^['"]|['"]$/g, "");
  return (
    normalized.startsWith("data/conversations/") ||
    normalized.startsWith("./data/conversations/") ||
    normalized.includes("/data/conversations/")
  );
}

function findForbiddenOutputPath(command: string, workspacePath: string): string | null {
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

function buildRuntimeTools(options?: AgentExecutionOptions, context?: RuntimeToolBuildContext): StructuredToolInterface[] {
  const tools = getAllTools();
  const workspacePath = options?.workspacePath;
  const wrappedTools = tools.map((t) => {
    if (t.name === "write_file" && workspacePath) {
      const wrapped = tool(
        async (input: Record<string, unknown>) => {
          const rawPath = typeof input.path === "string" ? input.path : "";
          const resolvedPath = rawPath.startsWith("/") ? rawPath : resolve(workspacePath, rawPath);
          if (!isPathInWorkspace(resolvedPath, workspacePath)) {
            return `[write_file]\nstatus: blocked\npath: ${rawPath}\nnote: 输出路径不在当前会话 workspace 内。请使用 ${workspacePath} 下的路径。`;
          }
          const originalResult = String(await t.invoke({ ...input, path: resolvedPath }));
          // Auto-diagnostic only after successful writes
          if (originalResult.startsWith("OK:")) {
            const diagInfo = detectDiagnosticCommand(resolvedPath, workspacePath);
            if (diagInfo) {
              try {
                let diagResult = await runDiagnostic(diagInfo.command, workspacePath);
                // For project-wide checks, filter to only errors in the edited file
                if (diagResult && diagInfo.filterRelPath) {
                  const filtered = diagResult.split("\n").filter(l => l.includes(diagInfo.filterRelPath!)).join("\n").trim();
                  diagResult = filtered || null;
                }
                if (diagResult) {
                  return originalResult + `\n\n⚠️ Diagnostic errors detected (${diagInfo.projectType}):\n${diagResult}\n\nPlease fix the errors above.`;
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
          if (!isPathInWorkspace(resolvedPath, workspacePath)) {
            return `[edit_file]\nstatus: blocked\npath: ${rawPath}\nnote: 编辑路径不在当前会话 workspace 内。请使用 ${workspacePath} 下的路径。`;
          }
          const originalResult = String(await t.invoke({ ...input, path: resolvedPath }));
          // Auto-diagnostic only after successful edits
          if (originalResult.startsWith("OK:")) {
            const diagInfo = detectDiagnosticCommand(resolvedPath, workspacePath);
            if (diagInfo) {
              try {
                let diagResult = await runDiagnostic(diagInfo.command, workspacePath);
                // For project-wide checks, filter to only errors in the edited file
                if (diagResult && diagInfo.filterRelPath) {
                  const filtered = diagResult.split("\n").filter(l => l.includes(diagInfo.filterRelPath!)).join("\n").trim();
                  diagResult = filtered || null;
                }
                if (diagResult) {
                  return originalResult + `\n\n⚠️ Diagnostic errors detected (${diagInfo.projectType}):\n${diagResult}\n\nPlease fix the errors above.`;
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
    // Workspace path resolution for search_code, list_files, git_operations, test_runner
    if (t.name === "search_code" && workspacePath) {
      const wrapped = tool(
        async (input: Record<string, unknown>) => {
          const rawPath = typeof input.path === "string" ? input.path : "";
          const resolvedPath = rawPath
            ? (rawPath.startsWith("/") ? rawPath : resolve(workspacePath, rawPath))
            : workspacePath;
          if (!isPathInWorkspace(resolvedPath, workspacePath)) {
            return `[search_code]\nstatus: blocked\npath: ${rawPath}\nnote: 搜索路径不在当前会话 workspace 内。请使用 ${workspacePath} 下的路径。`;
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
            return `[list_files]\nstatus: blocked\npath: ${rawPath}\nnote: 列出路径不在当前会话 workspace 内。请使用 ${workspacePath} 下的路径。`;
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
            return `[test_runner]\nstatus: blocked\npath: ${rawPath}\nnote: 测试路径不在当前会话 workspace 内。请使用 ${workspacePath} 下的路径。`;
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
    if (t.name !== "run_command") return t;
    const wrapped = tool(
      async (input: { command: string; timeout_ms?: number; working_directory?: string }) => {
        if (!workspacePath) {
          return String(await t.invoke(input));
        }
        const cmd = typeof input?.command === "string" ? input.command : "";
        const forbidden = findForbiddenOutputPath(cmd, workspacePath);
        if (forbidden) {
          return `[run_command]\nstatus: blocked\ncommand: ${cmd}\ncwd: ${workspacePath}\nnote: 输出路径 ${forbidden} 不在当前会话 workspace 内。请改为 ${workspacePath} 下路径。`;
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
  // Apply role-based tool filtering for sub-agents in team mode
  const subagentRole = options?.subagentRole;
  const filteredWrappedTools = subagentRole ? filterToolsByRole(wrappedTools, subagentRole) : wrappedTools;
  const depth = context?.options?.subagentDepth ?? 0;
  const subagentEnabled = context?.options?.subagentEnabled ?? true;
  if (!subagentEnabled || depth >= 1) {
    // Wrap tools with approval gates for sub-agents in team mode
    const convMode = options?.conversationMode ?? context?.options?.conversationMode ?? "default";
    const convId = options?.conversationId ?? context?.options?.conversationId;
    const subId = options?.subagentId;
    if (convMode === "team" && convId && subId) {
      return filteredWrappedTools.map((t) => {
        if (t.name === "run_command") {
          return wrapToolWithApproval(t, "run_command", (input) => {
            const cmd = typeof input.command === "string" ? input.command : "";
            return isHighRiskCommand(cmd);
          }, {
            conversationId: convId,
            subagentId: subId,
            role: subagentRole,
            onSubagentEvent: options?.onSubagentEvent ?? context?.options?.onSubagentEvent,
          });
        }
        if (t.name === "write_file") {
          return wrapToolWithApproval(t, "write_file", (input) => {
            const path = typeof input.path === "string" ? input.path : "";
            return isHighRiskWrite(path, workspacePath);
          }, {
            conversationId: convId,
            subagentId: subId,
            role: subagentRole,
            onSubagentEvent: options?.onSubagentEvent ?? context?.options?.onSubagentEvent,
          });
        }
        if (t.name === "edit_file") {
          return wrapToolWithApproval(t, "edit_file", (input) => {
            const path = typeof input.path === "string" ? input.path : "";
            return isHighRiskWrite(path, workspacePath);
          }, {
            conversationId: convId,
            subagentId: subId,
            role: subagentRole,
            onSubagentEvent: options?.onSubagentEvent ?? context?.options?.onSubagentEvent,
          });
        }
        return t;
      });
    }
    return filteredWrappedTools;
  }
  if (!context) {
    return filteredWrappedTools;
  }
  const conversationMode = context.options?.conversationMode ?? "default";
  const subagentResults = context.subagentResults ?? new Map<string, { name: string; summary: string }>();
  const MAX_SUBAGENT_RESULTS = 30; // Keep last N results to bound memory
  const taskTool = tool(
    async (input: { prompt: string; role?: string; dependsOn?: string[] }) => {
      const prompt = typeof input?.prompt === "string" ? input.prompt.trim() : "";
      if (!prompt) return "Error: prompt is required.";
      // Check abort signal before spawning subagent
      if (context.options?.abortSignal?.aborted) {
        return "[aborted] Task cancelled — client disconnected.";
      }
      const teamId = context.options?.teamId ?? "default";
      const role = (conversationMode === "team" && input.role && isValidTeamAgent(input.role, teamId))
        ? (input.role as AgentRole)
        : undefined;
      const dependsOn = Array.isArray(input.dependsOn)
        ? [...new Set(input.dependsOn.filter((id) => typeof id === "string"))] // deduplicate
        : [];

      // Build context injection from dependsOn references
      let contextInjection = "";
      const MAX_CONTEXT_INJECTION_CHARS = 64000; // total cap for all dependsOn context
      if (dependsOn.length > 0) {
        const contextParts: string[] = [];
        const missingDeps: string[] = [];
        let contextChars = 0;
        for (const depRef of dependsOn) {
          if (contextChars >= MAX_CONTEXT_INJECTION_CHARS) {
            serverLogger.warn(`[task] dependsOn context injection capped at ${MAX_CONTEXT_INJECTION_CHARS} chars, skipping remaining deps`);
            break;
          }
          // Support lookup by subagentId OR by subagentName
          let result = subagentResults.get(depRef);
          if (!result) {
            // Try matching by name (case-insensitive)
            const depRefLower = depRef.toLowerCase();
            for (const [id, r] of subagentResults.entries()) {
              if (r.name.toLowerCase() === depRefLower || id.startsWith(depRef)) {
                result = r;
                break;
              }
            }
          }
          // File read-back: try .agents/results/ when in-memory lookup fails
          if (!result && context.options?.workspacePath) {
            const resultsDir = join(context.options.workspacePath, ".agents", "results");
            try {
              // 1. Exact match by subagentId (with path traversal guard)
              const exactPath = join(resultsDir, `${depRef}.md`);
              if (resolve(exactPath).startsWith(resolve(resultsDir) + "/") && existsSync(exactPath)) {
                const content = readFileSync(exactPath, "utf-8");
                const nameMatch = content.match(/^# (.+?) \(/);
                result = { name: nameMatch?.[1] ?? depRef, summary: content };
              }
              // 2. Fuzzy match by name
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
          serverLogger.warn(`[task] dependsOn references not found: ${missingDeps.join(", ")} — these agents may not have completed yet`);
          contextParts.push(`### Warning\nThe following agent results were not available: ${missingDeps.join(", ")}. They may not have completed or the IDs may be incorrect.`);
        }
        if (contextParts.length > 0) {
          contextInjection = `\n\n## Prior Agent Results\nThe following results from previous agents are provided as context for your task:\n\n${contextParts.join("\n\n")}\n\n---\n\n`;
        }
      }
      // Inject available context file list so sub-agents can read_file for full content
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
        // 为了在会话历史中也能看到 AI 生成的简短名称，这里同步等待一次极短 LLM 调用。
        // 子 Agent 本身的执行仍然是异步流式的，这个命名步骤只增加很小的前置延迟。
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
        let fullText = "";           // Uncapped buffer for file persistence
        const MAX_FULL_TEXT = 64000; // Cap full text to prevent memory issues
        const SUBAGENT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes per subagent
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutTimer = setTimeout(() => reject(new Error(`Subagent timed out after ${SUBAGENT_TIMEOUT_MS / 1000}s`)), SUBAGENT_TIMEOUT_MS);
        });
        const subagentOptions: StreamAgentOptions = {
          ...context.options,
          planningEnabled: true,
          planProgressEnabled: true,
          subagentDepth: depth + 1,
          subagentRole: role,
          subagentId,
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
        const runSubagent = async () => {
          for await (const chunk of streamAgentWithTokens(
            [new HumanMessage(enrichedPrompt)],
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
        await Promise.race([runSubagent(), timeoutPromise]);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        const rawSummary = summaryText.trim() || NO_VISIBLE_OUTPUT_MESSAGE;
        const summary = truncateToolResult(rawSummary, MAX_TASK_TOOL_RESULT_CHARS);
        // Store result for dependsOn references by future tasks
        subagentResults.set(subagentId, { name: subagentName, summary });
        // Persist full result to workspace file for history recovery
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
        // Evict oldest entries if over capacity
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
        // Return structured result so coordinator knows the subagentId for dependsOn references
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
        ? `Spawn a subagent to perform a subtask. Returns the result prefixed with [subagentId: xxx] [name: xxx] — use these identifiers in dependsOn of subsequent tasks to pass context. In team mode, always specify a role from the available team members.`
        : "Spawn a subagent to perform a subtask. Returns the result prefixed with [subagentId: xxx] [name: xxx] — use these identifiers in dependsOn of subsequent tasks to pass context.",
      schema: z.object({
        prompt: z.string().describe("Subtask instruction for the subagent"),
        role: z.string().optional()
          .describe("Agent role ID for the subagent. In team mode, must be one of the available team members. In default mode this is ignored."),
        dependsOn: z.array(z.string()).optional()
          .describe("subagentId or name of previously completed sub-agents whose results should be injected as context."),
      }),
    }
  );

  // In team mode at depth 0 (coordinator level), only expose task + read_file
  // This prevents the coordinator from doing implementation work itself
  if (conversationMode === "team" && depth === 0) {
    const coordinatorAllowed = new Set(["task", "read_file", "load_skill", "get_time"]);
    const coordinatorTools = filteredWrappedTools.filter((t) => coordinatorAllowed.has(t.name));
    return [...coordinatorTools, taskTool as unknown as StructuredToolInterface];
  }

  return [...filteredWrappedTools, taskTool as unknown as StructuredToolInterface];
}

type RuntimePlanStep = PlanStep & {
  evidences: string[];
  completed: boolean;
};

function createRuntimePlanSteps(steps: PlanStep[]): RuntimePlanStep[] {
  return steps.map((s) => ({
    ...s,
    evidences: [],
    completed: false,
  }));
}

function summarizeToolEvidence(toolName: string | undefined, output: string): string {
  const oneLine = output.replace(/\s+/g, " ").trim();
  const short = oneLine.length > 180 ? `${oneLine.slice(0, 180)}…` : oneLine;
  return toolName ? `${toolName}: ${short || "(no output)"}` : (short || "(no output)");
}

function applyEvidenceToPlan(steps: RuntimePlanStep[], evidence: string): RuntimePlanStep[] {
  const firstPending = steps.findIndex((s) => !s.completed);
  if (firstPending < 0) return steps;
  const target = steps[firstPending];
  const nextEvidences = [...target.evidences, evidence].slice(-6);
  const requiredChecks = Math.max(1, target.acceptance_checks.length);
  const completed = nextEvidences.length >= requiredChecks;
  // 保留严格门槛：证据条数需覆盖验收项数量，避免“单条证据”导致步骤过早完成。
  const cloned = [...steps];
  cloned[firstPending] = {
    ...target,
    evidences: nextEvidences,
    completed,
  };
  return cloned;
}

function computeCurrentStep(steps: RuntimePlanStep[]): number {
  let done = 0;
  for (const step of steps) {
    if (!step.completed) break;
    done += 1;
  }
  return done;
}

function forceCompletePlan(steps: RuntimePlanStep[]): RuntimePlanStep[] {
  return steps.map((step) => ({
    ...step,
    completed: true,
  }));
}

export function buildAgent(modelId?: string) {
  const tools = buildRuntimeTools(undefined, { modelId, options: {} });
  const model = getModelAdapter(modelId).getLLM().bindTools(tools);
  const toolNode = new ToolNode(tools);

  const truncateToolNode = async (state: MessagesState) => {
    const result = await toolNode.invoke(state);
    return {
      messages: (result.messages as BaseMessage[]).map((m) => {
        if (m._getType() === "tool" && typeof m.content === "string") {
          const truncated = truncateToolResult(m.content);
          if (truncated !== m.content) {
            const tm = m as ToolMessage;
            return new ToolMessage({ content: truncated, tool_call_id: tm.tool_call_id, name: (tm as unknown as { name?: string }).name });
          }
        }
        return m;
      }),
    };
  };

  const callModel = async (state: MessagesState) => {
    const prunedMessages = pruneConversationIfNeeded(state.messages);
    const response = await model.invoke([
      new SystemMessage(buildSystemPrompt(undefined, "default")),
      ...prunedMessages,
    ]);
    return { messages: [response] };
  };

  const shouldContinue = (state: MessagesState): "toolNode" | typeof END => {
    const lastMessage = state.messages[state.messages.length - 1];
    if (
      lastMessage &&
      "tool_calls" in lastMessage &&
      Array.isArray(lastMessage.tool_calls) &&
      lastMessage.tool_calls.length > 0
    ) {
      return "toolNode";
    }
    return END;
  };

  const graph = new StateGraph(MessagesAnnotation)
    .addNode("llmCall", callModel)
    .addNode("toolNode", truncateToolNode)
    .addEdge(START, "llmCall")
    .addConditionalEdges("llmCall", shouldContinue, ["toolNode", END])
    .addEdge("toolNode", "llmCall");

  return graph.compile();
}

export async function runAgent(
  messages: BaseMessage[],
  modelId?: string,
  skillContext?: string,
  options?: AgentExecutionOptions
): Promise<BaseMessage[]> {
  const tools = buildRuntimeTools(options, { modelId, skillContext, options });
  const systemMessage = new SystemMessage(buildSystemPrompt(skillContext, options?.conversationMode ?? "default", options?.teamId, options?.workspacePath));
  const adapter = getModelAdapter(modelId);
  const model = adapter.getLLM().bindTools(tools);
  const toolNode = new ToolNode(tools);
  const planningPrelude = await buildPlanningPrelude(adapter, systemMessage, messages, options?.planningEnabled ?? true);
  const initialState: BaseMessage[] = [
    ...messages,
    ...(planningPrelude.executionConstraint ? [planningPrelude.executionConstraint] : []),
  ];

  const truncateToolNode = async (state: MessagesState) => {
    const result = await toolNode.invoke(state);
    return {
      messages: (result.messages as BaseMessage[]).map((m) => {
        if (m._getType() === "tool" && typeof m.content === "string") {
          const truncated = truncateToolResult(m.content);
          if (truncated !== m.content) {
            const tm = m as ToolMessage;
            return new ToolMessage({ content: truncated, tool_call_id: tm.tool_call_id, name: (tm as unknown as { name?: string }).name });
          }
        }
        return m;
      }),
    };
  };

  const callModel = async (state: MessagesState) => {
    const bgMessage = buildBackgroundResultMessage();
    const prunedMessages = pruneConversationIfNeeded(state.messages);
    const response = await model.invoke([systemMessage, ...prunedMessages, ...(bgMessage ? [bgMessage] : [])]);
    return { messages: [response] };
  };

  const shouldContinue = (state: MessagesState): "toolNode" | typeof END => {
    const lastMessage = state.messages[state.messages.length - 1];
    if (
      lastMessage &&
      "tool_calls" in lastMessage &&
      Array.isArray(lastMessage.tool_calls) &&
      lastMessage.tool_calls.length > 0
    ) return "toolNode";
    return END;
  };

  const graph = new StateGraph(MessagesAnnotation)
    .addNode("llmCall", callModel)
    .addNode("toolNode", truncateToolNode)
    .addEdge(START, "llmCall")
    .addConditionalEdges("llmCall", shouldContinue, ["toolNode", END])
    .addEdge("toolNode", "llmCall")
    .compile();

  const result = await graph.invoke({ messages: initialState });
  return result.messages;
}

export async function* streamAgentWithTokens(
  messages: BaseMessage[],
  onToken: (token: string) => void,
  modelId?: string,
  onReasoningToken?: (token: string) => void,
  skillContext?: string,
  options?: StreamAgentOptions
): AsyncGenerator<Record<string, { messages?: BaseMessage[]; reasoning?: string } | { prompt_tokens: number; completion_tokens: number; total_tokens: number }>, void, unknown> {
  const systemPromptText = options?.subagentSystemPromptOverride ?? buildSystemPrompt(skillContext, options?.conversationMode ?? "default", options?.teamId, options?.workspacePath);
  const systemMessage = new SystemMessage(systemPromptText);
  const adapter = getModelAdapter(modelId);
  const planningPrelude = await buildPlanningPrelude(adapter, systemMessage, messages, options?.planningEnabled ?? true);
  let runtimePlanSteps = createRuntimePlanSteps(planningPrelude.planSteps ?? []);
  let planCurrentStep = computeCurrentStep(runtimePlanSteps);
  const emitCurrentPlan = (phase: "created" | "running" | "completed", toolName?: string) => {
    emitPlan({
      phase,
      steps: runtimePlanSteps,
      currentStep: planCurrentStep,
      toolName,
    });
  };
  const emitPlan = (event: PlanStreamEvent) => {
    if (options?.planProgressEnabled && options.onPlanEvent) {
      options.onPlanEvent(event);
    }
  };
  const stateMessages: BaseMessage[] = [
    ...messages,
    ...(planningPrelude.executionConstraint ? [planningPrelude.executionConstraint] : []),
  ];
  const depth = options?.subagentDepth ?? 0;
  const baseCap = resolveConversationTokenCap(modelId);
  // Sub-agents get a reduced cap: 75% per depth level (depth 0 = 100%, depth 1 = 75%, depth 2 = 56%)
  const conversationTokenCap = depth > 0
    ? Math.max(MIN_CONVERSATION_TOKENS_CAP, Math.floor(baseCap * Math.pow(0.75, depth)))
    : baseCap;
  if (runtimePlanSteps.length > 0) {
    emitCurrentPlan("created");
  }
  const useReasoningStream = adapter.supportsReasoningStream() && typeof onReasoningToken === "function";

  const streamFinalOnlyWithRetryByAdapter = async (
    baseMessages: BaseMessage[],
    reasoningCb: (token: string) => void
  ): Promise<{ content: string; reasoningContent: string; usage?: import("../llm/streamWithReasoning.js").TokenUsage }> => {
    const pruned = pruneConversationIfNeeded(baseMessages, conversationTokenCap);
    const first = await adapter.streamSingleTurn(pruned, onToken, reasoningCb, [], options?.abortSignal);
    const firstContent = first.content?.trim() ?? "";
    if (firstContent) {
      return {
        content: first.content,
        reasoningContent: first.reasoningContent,
        usage: first.usage,
      };
    }
    let latestReasoning = first.reasoningContent ?? "";
    let lastUsage = first.usage;
    for (let retry = 0; retry < 2; retry++) {
      const attempt = await adapter.streamSingleTurn(
        [...pruned, new HumanMessage(FINAL_ONLY_PROMPT)],
        onToken,
        reasoningCb,
        [],
        options?.abortSignal
      );
      const attemptContent = attempt.content?.trim() ?? "";
      if (attempt.usage) lastUsage = attempt.usage;
      if (attemptContent) {
        return {
          content: attempt.content,
          reasoningContent: attempt.reasoningContent,
          usage: attempt.usage,
        };
      }
      if (!latestReasoning.trim() && typeof attempt.reasoningContent === "string" && attempt.reasoningContent.trim()) {
        latestReasoning = attempt.reasoningContent;
      }
    }
    return { content: "", reasoningContent: latestReasoning, usage: lastUsage };
  };

  const streamFinalOnlyWithRetryByModel = async (
    baseMessages: BaseMessage[]
  ): Promise<string> => {
    const modelNoTools = adapter.getLLM();
    const pruned = pruneConversationIfNeeded(baseMessages, conversationTokenCap);
    const streamOnce = async (msgs: BaseMessage[]) => {
      const stream = await modelNoTools.stream(msgs);
      let content = "";
      for await (const chunk of stream) {
        const text = getTextFromChunk(chunk);
        if (text) {
          onToken(text);
          content += text;
        }
      }
      return content;
    };
    const firstContent = await streamOnce([systemMessage, ...pruned]);
    if (firstContent.trim()) return firstContent;
    for (let retry = 0; retry < 2; retry++) {
      const attemptContent = await streamOnce([systemMessage, ...pruned, new HumanMessage(FINAL_ONLY_PROMPT)]);
      if (attemptContent.trim()) return attemptContent;
    }
    return "";
  };

  const executeToolCall = async (
    tc: ToolCallResult,
    toolMap: Map<string, StructuredToolInterface>
  ): Promise<{ id: string; name: string; result: string }> => {
    // Check abort before executing
    if (options?.abortSignal?.aborted) {
      return { id: tc.id, name: tc.name, result: "[aborted] Execution cancelled" };
    }
    const tool = toolMap.get(tc.name);
    let result: string;
    if (tool) {
      const args = safeParseArgs(tc.arguments);
      if (tc.name === "write_file") {
        const argsErr = getWriteFileArgsError(args as { path?: unknown; content?: unknown });
        if (argsErr) {
          result = `[error] ${argsErr} ${WRITE_FILE_SCHEMA_HINT}`;
        } else {
          try {
            result = String(await tool.invoke(args));
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            result = msg.includes("expected schema") ? `[error] ${msg} ${WRITE_FILE_SCHEMA_HINT}` : `[error] ${msg}`;
          }
        }
      } else {
        try {
          result = String(await tool.invoke(args));
        } catch (e) {
          result = `[error] ${e instanceof Error ? e.message : String(e)}`;
        }
      }
    } else {
      result = `[error] Unknown tool: ${tc.name}. You do NOT have this tool. In team mode, delegate work via the \`task\` tool instead of calling execution tools directly.`;
    }
    // Task tool results are already truncated internally (with metadata prefix).
    // Only apply outer truncation for non-task tools.
    if (tc.name === "task") {
      return { id: tc.id, name: tc.name, result };
    }
    return { id: tc.id, name: tc.name, result: truncateToolResult(result, MAX_SINGLE_TOOL_RESULT_CHARS) };
  };

  const executeToolCalls = async (
    toolCalls: ToolCallResult[],
    toolMap: Map<string, StructuredToolInterface>
  ): Promise<Array<{ id: string; name: string; result: string }>> => {
    // Parse dependsOn from task arguments to determine execution order
    const taskDeps = new Map<string, string[]>(); // tc.id -> dependsOn subagent IDs
    for (const tc of toolCalls) {
      if (tc.name === "task") {
        const args = safeParseArgs(tc.arguments);
        const deps = Array.isArray((args as { dependsOn?: unknown }).dependsOn)
          ? ((args as { dependsOn: unknown[] }).dependsOn).filter((d): d is string => typeof d === "string")
          : [];
        taskDeps.set(tc.id, deps);
      }
    }

    const hasDependencies = Array.from(taskDeps.values()).some((deps) => deps.length > 0);

    // Circular dependency detection: build a graph of subagentId references
    // Since dependsOn uses subagentIds (not tc.ids), we detect cycles among
    // the declared dependency values. If a cycle is detected, fall back to sequential.
    if (hasDependencies) {
      const allDepIds = new Set<string>();
      for (const deps of taskDeps.values()) {
        for (const d of deps) allDepIds.add(d);
      }
      // Simple: if any depId is referenced by multiple tasks as mutual dependency, warn
      // Full cycle detection would require knowing subagentId→tc.id mapping which we don't have yet.
      // Sequential execution inherently prevents deadlocks anyway.
    }

    const outputs: Array<{ id: string; name: string; result: string }> = [];
    if (hasDependencies) {
      // Sequential execution: run all tool calls in order so dependsOn results
      // are available in subagentResults by the time dependent tasks run.
      for (const tc of toolCalls) {
        outputs.push(await executeToolCall(tc, toolMap));
      }
    } else {
      // Parallel execution: start all tasks concurrently, run non-tasks inline
      const taskPromiseMap = new Map<string, Promise<{ id: string; name: string; result: string }>>();
      for (const tc of toolCalls) {
        if (tc.name === "task") {
          taskPromiseMap.set(tc.id, executeToolCall(tc, toolMap));
        }
      }
      for (const tc of toolCalls) {
        if (tc.name === "task") {
          const taskResult = await taskPromiseMap.get(tc.id);
          outputs.push(taskResult ?? { id: tc.id, name: tc.name, result: "[error] Unknown task execution failure" });
        } else {
          outputs.push(await executeToolCall(tc, toolMap));
        }
      }
    }
    return outputs;
  };

  if (useReasoningStream) {
    try {
      const tools = buildRuntimeTools(options, { modelId, skillContext, options });
      const openAITools = tools.map((t) => convertToOpenAITool(t) as unknown as Record<string, unknown>);
      const toolMap = new Map<string, StructuredToolInterface>(tools.map((t) => [t.name, t]));
      let conversationMessages: BaseMessage[] = [systemMessage, ...stateMessages];
      const maxRounds = 500;

      let lastHadContent = false;
      let reachedMaxRounds = false;
      for (let round = 0; round < maxRounds; round++) {
        // Check abort signal at the start of each round
        if (options?.abortSignal?.aborted) {
          serverLogger.info("[stream] Aborted by signal, stopping execution");
          return;
        }
        const bgMessage = buildBackgroundResultMessage();
        if (bgMessage) conversationMessages = [...conversationMessages, bgMessage];
        // Prune old tool results to stay within context window
        conversationMessages = pruneConversationIfNeeded(conversationMessages, conversationTokenCap);
        const { content, reasoningContent, toolCalls, usage: turnUsage } = await adapter.streamSingleTurn(
          conversationMessages, onToken, onReasoningToken!, openAITools, options?.abortSignal
        );
        if (turnUsage) yield { usage: turnUsage };

        lastHadContent = !!(content && content.trim());
        const aiMsg = new AIMessage({
          content: content || " ",
          ...(toolCalls.length > 0 ? {
            tool_calls: toolCalls.map((tc: ToolCallResult) => ({
              id: tc.id, name: tc.name, args: safeParseArgs(tc.arguments),
            })),
          } : {}),
        });
        conversationMessages = [...conversationMessages, aiMsg];
        yield {
          llmCall: {
            messages: [aiMsg],
            ...(reasoningContent.trim() ? { reasoning: reasoningContent.trim() } : {}),
          },
        };

        // 如果没有工具调用，检查是否需要生成总结
        if (toolCalls.length === 0) {
          if (runtimePlanSteps.length > 0) {
            runtimePlanSteps = forceCompletePlan(runtimePlanSteps);
            planCurrentStep = computeCurrentStep(runtimePlanSteps);
          }
          emitCurrentPlan("completed");
          // 如果最后一轮没有内容，强制生成总结
          if (!lastHadContent) {
            const { content: finalContent, reasoningContent: finalReasoning, usage: finalUsage } = await streamFinalOnlyWithRetryByAdapter(conversationMessages, onReasoningToken!);
            const summaryMsg = new AIMessage({ content: finalContent || NO_VISIBLE_OUTPUT_MESSAGE });
            yield {
              llmCall: {
                messages: [summaryMsg],
                ...(finalReasoning?.trim() ? { reasoning: finalReasoning.trim() } : {}),
              },
            };
            if (finalUsage) yield { usage: finalUsage };
          }
          return;
        }

        const toolOutputs = await executeToolCalls(toolCalls, toolMap);
        const toolMessages: BaseMessage[] = [];
        let lastToolNameForPlan: string | undefined;
        for (const out of toolOutputs) {
          lastToolNameForPlan = out.name;
          toolMessages.push(new ToolMessage({ content: out.result, tool_call_id: out.id, name: out.name }));
          if (runtimePlanSteps.length > 0) {
            runtimePlanSteps = applyEvidenceToPlan(runtimePlanSteps, summarizeToolEvidence(out.name, out.result));
            planCurrentStep = computeCurrentStep(runtimePlanSteps);
          }
        }
        conversationMessages = [...conversationMessages, ...toolMessages];
        if (runtimePlanSteps.length > 0) emitCurrentPlan("running", lastToolNameForPlan);
        yield { toolNode: { messages: toolMessages } };
        if (round === maxRounds - 1) reachedMaxRounds = true;
      }

      if (!lastHadContent) {
        const { content: finalContent, reasoningContent: finalReasoning, usage: finalUsage } = await streamFinalOnlyWithRetryByAdapter(conversationMessages, onReasoningToken!);
        const summaryMsg = new AIMessage({ content: finalContent || (reachedMaxRounds ? MAX_TOOL_CALL_ROUNDS_MESSAGE : NO_VISIBLE_OUTPUT_MESSAGE) });
        yield {
          llmCall: {
            messages: [summaryMsg],
            ...(finalReasoning?.trim() ? { reasoning: finalReasoning.trim() } : {}),
          },
        };
        if (finalUsage) yield { usage: finalUsage };
      }
      return;
    } catch (e) {
      serverLogger.warn("Reasoning stream failed, falling back to standard LangChain stream", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const tools = buildRuntimeTools(options, { modelId, skillContext, options });
  const toolMap = new Map<string, StructuredToolInterface>(tools.map((t) => [t.name, t]));
  const model = adapter.getLLM().bindTools(tools);
  let state: BaseMessage[] = [...stateMessages];
  const maxRounds = 500;

  const shouldContinue = (last: BaseMessage): boolean => {
    return !!(
      last &&
      "tool_calls" in last &&
      Array.isArray(last.tool_calls) &&
      last.tool_calls.length > 0
    );
  };

  let lastHadContent = false;
  let reachedMaxRounds = false;
  for (let round = 0; round < maxRounds; round++) {
    // Check abort signal at the start of each round
    if (options?.abortSignal?.aborted) {
      serverLogger.info("[stream] Aborted by signal, stopping execution");
      return;
    }
    const bgMessage = buildBackgroundResultMessage();
    if (bgMessage) state = [...state, bgMessage];
    // Prune old tool results to stay within context window
    state = pruneConversationIfNeeded(state, conversationTokenCap);
    // Wrap LangChain stream with abort signal and per-chunk timeout
    const streamSignal = options?.abortSignal;
    const stream = await model.stream([systemMessage, ...state], streamSignal ? { signal: streamSignal } : undefined);
    let fullChunk: BaseMessage | null = null;
    let accumulatedContent = "";
    let accumulatedReasoning = "";
    let lastUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;
    for await (const chunk of stream) {
      // Check abort between chunks
      if (streamSignal?.aborted) {
        serverLogger.info("[stream] Aborted by signal during LangChain stream");
        return;
      }
      const text = getTextFromChunk(chunk);
      if (text) {
        onToken(text);
        accumulatedContent += text;
      }
      const reasoningChunk = getReasoningFromChunk(chunk);
      if (reasoningChunk) {
        accumulatedReasoning += reasoningChunk;
        if (onReasoningToken) onReasoningToken(reasoningChunk);
      }
      const meta = (chunk as { usage_metadata?: { input_tokens?: number; output_tokens?: number } }).usage_metadata;
      if (meta && typeof meta.input_tokens === "number" && typeof meta.output_tokens === "number") {
        lastUsage = {
          prompt_tokens: meta.input_tokens,
          completion_tokens: meta.output_tokens,
          total_tokens: meta.input_tokens + meta.output_tokens,
        };
      }
      if (fullChunk && "concat" in fullChunk && typeof (fullChunk as { concat: (other: BaseMessage) => BaseMessage }).concat === "function") {
        fullChunk = (fullChunk as { concat: (other: BaseMessage) => BaseMessage }).concat(chunk as BaseMessage) as BaseMessage;
      } else {
        fullChunk = chunk as BaseMessage;
      }
    }
    if (lastUsage) yield { usage: lastUsage };
    if (!fullChunk) break;
    const fromChunk = getTextFromMessage(fullChunk);
    const content = accumulatedContent || fromChunk;
    lastHadContent = !!(content && content.trim());
    const finalMessage =
      content || (fullChunk as AIMessage).tool_calls?.length
        ? new AIMessage({
            content: content || " ",
            tool_calls: (fullChunk as AIMessage).tool_calls ?? [],
          })
        : fullChunk;
    state = [...state, finalMessage];
    const reasoning = accumulatedReasoning.trim() || getReasoningFromMessage(fullChunk);
    yield { llmCall: { messages: [finalMessage], ...(reasoning ? { reasoning } : {}) } };
    if (!shouldContinue(fullChunk)) {
      if (runtimePlanSteps.length > 0) {
        runtimePlanSteps = forceCompletePlan(runtimePlanSteps);
        planCurrentStep = computeCurrentStep(runtimePlanSteps);
      }
      emitCurrentPlan("completed");
      break;
    }
    const fullChunkTools = ((fullChunk as AIMessage).tool_calls ?? []).map((tc) => ({
      id: tc.id ?? "",
      name: tc.name,
      arguments: JSON.stringify(tc.args ?? {}),
    }));
    const toolOutputs = await executeToolCalls(fullChunkTools, toolMap);
    const toolMessages: BaseMessage[] = toolOutputs.map((out) => (
      new ToolMessage({ content: out.result, tool_call_id: out.id, name: out.name })
    ));
    if (runtimePlanSteps.length > 0) {
      const toolOutputs: Array<{ name?: string; content: string }> = [];
      for (const m of toolMessages) {
        if (m._getType() !== "tool") continue;
        toolOutputs.push({
          name: (m as { name?: string }).name,
          content: typeof m.content === "string" ? m.content : "",
        });
      }
      for (const out of toolOutputs) {
        runtimePlanSteps = applyEvidenceToPlan(runtimePlanSteps, summarizeToolEvidence(out.name, out.content));
      }
      planCurrentStep = computeCurrentStep(runtimePlanSteps);
      emitCurrentPlan("running", fullChunkTools[0]?.name);
    }
    state = [...state, ...toolMessages];
    yield { toolNode: { messages: toolMessages } };
    if (round === maxRounds - 1) reachedMaxRounds = true;
  }

  if (!lastHadContent && state.length > messages.length) {
    const summaryContent = await streamFinalOnlyWithRetryByModel(state);
    const summaryMsg = new AIMessage({ content: summaryContent || (reachedMaxRounds ? MAX_TOOL_CALL_ROUNDS_MESSAGE : NO_VISIBLE_OUTPUT_MESSAGE) });
    yield { llmCall: { messages: [summaryMsg] } };
  }
}
