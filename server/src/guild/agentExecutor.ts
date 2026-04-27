import { mkdirSync, existsSync, readdirSync, statSync } from "fs";
import { join, relative, isAbsolute, resolve as resolvePath } from "path";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { GuildAgent, GuildTask, TaskResult, GuildEvent, ArtifactStrategy } from "./types.js";
import { getAgent, getGroup, updateAgent, updateAgentStats, getAgentWorkspaceDir, getGroupSharedDir } from "./guildManager.js";
import { snapshotDir, reconcileManifest } from "./manifestManager.js";
import { completeTask, failTask, getTask, updateTask, initExecutionLog, appendExecutionLog, finalizeExecutionLog } from "./taskBoard.js";
import { searchRelevant, settleExperience } from "./memoryManager.js";
import { resolveAssetContext } from "./assetResolver.js";
import { guildEventBus } from "./eventBus.js";
import { buildTeammateRoster } from "./teammateRoster.js";
import { snapshotForPrompt, appendHandoff } from "./workspace.js";
import { parseHandoffFromSummary, parseStructuredOutput } from "./handoffParser.js";
import type { TaskHandoff } from "./types.js";
import { streamAgentWithTokens } from "../agent/index.js";
import { serverLogger } from "../lib/logger.js";
import { loadUserConfig, hasAnyEnhancement } from "../config/userConfig.js";
import type { HarnessConfig, HarnessEvent } from "../agent/harness/types.js";
import type { PlanStreamEvent } from "../agent/riskDetection.js";

export interface ExecutionOptions {
  timeoutMs?: number;
  onEvent?: (event: GuildEvent) => void;
}

const activeExecutions = new Set<string>();
const abortRequests = new Set<string>();
const execKey = (groupId: string, taskId: string): string => `${groupId}::${taskId}`;
export const RELEASED_ERROR_TAG = "__GUILD_AGENT_RELEASED__";

export function isExecutionActive(groupId: string, taskId: string): boolean {
  return activeExecutions.has(execKey(groupId, taskId));
}

export function getActiveExecutionCount(): number {
  return activeExecutions.size;
}

/** Mark an active execution for cooperative abort. Returns true if it was active. */
export function requestExecutionAbort(groupId: string, taskId: string): boolean {
  const k = execKey(groupId, taskId);
  if (!activeExecutions.has(k)) return false;
  abortRequests.add(k);
  return true;
}

const REJECTION_PATTERNS = [
  /无法执行/,
  /不属于.*(?:领域|范畴|职责)/,
  /无法完成.*任务/,
  /重新分配/,
  /不在.*能力范围/,
  /超出.*专业/,
];

function detectRejection(content: string, handoff?: TaskHandoff): boolean {
  if (handoff?.openQuestions?.some((q) => REJECTION_PATTERNS.some((p) => p.test(q)))) return true;
  if (handoff?.summary && REJECTION_PATTERNS.some((p) => p.test(handoff.summary))) return true;
  const tail = content.slice(-500);
  return REJECTION_PATTERNS.some((p) => p.test(tail));
}

/** Mirror of api/routes.ts buildHarnessConfigFromEnhancements — we can't import
 *  it directly without a circular graph. Keep logic in sync. */
function buildGuildHarnessConfig(): HarnessConfig | undefined {
  const cfg = loadUserConfig();
  const e = cfg.enhancements;
  if (!e || !hasAnyEnhancement(e)) return undefined;
  return {
    evalEnabled: e.evalGuard,
    evalSkipReadOnly: e.evalSkipReadOnly ?? true,
    loopDetectionEnabled: e.loopDetection,
    replanEnabled: e.replan,
    autoApproveReplan: e.autoApproveReplan,
    maxReplanAttempts: e.maxReplanAttempts,
    loopWindowSize: e.loopWindowSize,
    loopSimilarityThreshold: e.loopSimilarityThreshold,
  };
}

/** Walk a directory up to maxDepth and emit files as `{relPath, size, ownerDir}`.
 *  Skips the usual noise (hidden files, node_modules) and caps total entries. */
function listArtifacts(rootDir: string, maxDepth = 3, cap = 40): Array<{ path: string; size: number }> {
  if (!existsSync(rootDir)) return [];
  const out: Array<{ path: string; size: number }> = [];
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth || out.length >= cap) return;
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (out.length >= cap) return;
      if (name.startsWith(".") || name === "node_modules") continue;
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full, depth + 1);
      else if (st.isFile()) {
        out.push({ path: relative(rootDir, full), size: st.size });
      }
    }
  };
  walk(rootDir, 0);
  return out;
}

/** Resolve a handoff file artifact against the agent's private/shared dirs.
 *  Returns the first path that resolves to a regular file, or null otherwise.
 *  Safeguards:
 *   - Directories don't count (agent declared kind="file")
 *   - Relative refs are contained inside sharedDir or wsDir (blocks `../`
 *     traversal — we only probe existence but keep the check tidy anyway). */
function resolveArtifactPath(ref: string, sharedDir: string, wsDir: string): string | null {
  const cleaned = ref.replace(/^`+|`+$/g, "").trim();
  if (!cleaned) return null;

  const isFileAt = (p: string): boolean => {
    try { return statSync(p).isFile(); } catch { return false; }
  };

  if (isAbsolute(cleaned)) return isFileAt(cleaned) ? cleaned : null;

  for (const base of [sharedDir, wsDir]) {
    const resolved = resolvePath(base, cleaned);
    const baseResolved = resolvePath(base);
    // Require that the resolved path stays within the base directory.
    if (resolved !== baseResolved && !resolved.startsWith(baseResolved + "/")) continue;
    if (isFileAt(resolved)) return resolved;
  }
  return null;
}

/** Extract `foo.md` / `foo.json` / etc. file references out of a free-form
 *  acceptance criteria string, so we can check whether the agent produced them
 *  even if it didn't populate handoff.artifacts properly. Only recognises
 *  common extensions to avoid flagging prose that happens to contain dots.
 *
 *  Filename character class is **ASCII-only** (`\w`, `-`, `.`, `/`). The old
 *  pattern included `\u4e00-\u9fff` which made the match greedily swallow
 *  preceding Chinese context \u2014 e.g. "shared\u76ee\u5f55\u5b58\u5728robot_v1.md" was returned as
 *  the literal filename instead of "robot_v1.md", and the file lookup
 *  trivially failed. Filenames in this codebase are conventionally ASCII;
 *  Chinese-named outputs are vanishingly rare and worth deferring. */
const CRITERIA_FILE_RE = /(?:^|[^\w/.\-])([\w/\-]+\.(?:md|json|ts|tsx|js|jsx|py|sh|yaml|yml|txt|csv|html|css|sql))\b/g;

function extractFileRefsFromCriteria(text?: string): string[] {
  if (!text) return [];
  // .matchAll exposes the captured group, the bare regex would include the
  // boundary character we use to anchor the start. Use group 1 only.
  const seen = new Set<string>();
  for (const m of text.matchAll(CRITERIA_FILE_RE)) {
    const cleaned = m[1].replace(/^\.\//, "");
    seen.add(cleaned);
  }
  return [...seen];
}

function formatSizeHuman(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Produce a compact inventory of existing artifacts so the agent knows what
 *  already exists before it writes — the todo item was "agent 应该彼此知道对方
 *  工作产出 ... 不能随便做错误的覆盖". Kept concise (per-bucket cap + dir-aware)
 *  to avoid bloating the system prompt. */
function buildArtifactInventory(agent: GuildAgent, groupId: string, strategy: ArtifactStrategy): string | null {
  const ownWorkspace = listArtifacts(getAgentWorkspaceDir(agent.id));
  const sharedRoot = getGroupSharedDir(groupId);

  const sharedByOwner = new Map<string, Array<{ path: string; size: number }>>();
  if (existsSync(sharedRoot)) {
    let ownerDirs: string[] = [];
    try { ownerDirs = readdirSync(sharedRoot); } catch { ownerDirs = []; }
    for (const owner of ownerDirs) {
      if (owner.startsWith(".")) continue;
      const ownerPath = join(sharedRoot, owner);
      let st;
      try { st = statSync(ownerPath); } catch { continue; }
      if (st.isDirectory()) {
        const files = listArtifacts(ownerPath, 3, 15);
        if (files.length > 0) sharedByOwner.set(owner, files);
      } else if (strategy === "collaborative" && st.isFile()) {
        const existing = sharedByOwner.get("__root__") ?? [];
        existing.push({ path: owner, size: st.size });
        sharedByOwner.set("__root__", existing);
      }
    }
  }

  if (ownWorkspace.length === 0 && sharedByOwner.size === 0) return null;

  const lines: string[] = [];
  lines.push(`## Existing Artifacts (read before writing!)`);
  lines.push(`下面是当前已存在的产物清单。**在创建或覆盖文件前**请先对照此清单：`);
  lines.push(`- 若你要修改他人产物，必须在 Handoff 的 \`inputsConsumed\` 中声明，并在 \`summary\` 里写明变更原因；`);
  lines.push(`- 若你要覆盖自己之前的产物，需在 Handoff 中明确指出"覆盖了 X 文件、因为 Y"；`);
  lines.push(`- 未声明直接覆盖会被视为错误操作。`);

  if (ownWorkspace.length > 0) {
    lines.push(``);
    lines.push(`### 你自己的产物 (workspace)`);
    for (const f of ownWorkspace.slice(0, 25)) {
      lines.push(`- \`${f.path}\` (${formatSizeHuman(f.size)})`);
    }
    if (ownWorkspace.length > 25) lines.push(`- …还有 ${ownWorkspace.length - 25} 个文件未列出`);
  }

  if (sharedByOwner.size > 0) {
    lines.push(``);
    if (strategy === "isolated") {
      lines.push(`### 小组共享产物（按任务隔离）`);
      for (const [taskOrAgent, files] of sharedByOwner) {
        lines.push(`- **${taskOrAgent}**`);
        for (const f of files.slice(0, 10)) {
          lines.push(`  - \`${f.path}\` (${formatSizeHuman(f.size)})`);
        }
        if (files.length > 10) lines.push(`  - …还有 ${files.length - 10} 个文件`);
      }
    } else {
      lines.push(`### 小组共享产物（协作模式）`);
      const rootFiles = sharedByOwner.get("__root__");
      if (rootFiles && rootFiles.length > 0) {
        for (const f of rootFiles.slice(0, 15)) {
          lines.push(`- \`${f.path}\` (${formatSizeHuman(f.size)})`);
        }
        if (rootFiles.length > 15) lines.push(`- …还有 ${rootFiles.length - 15} 个文件`);
      }
      for (const [owner, files] of sharedByOwner) {
        if (owner === "__root__") continue;
        lines.push(`- **${owner}/**`);
        for (const f of files.slice(0, 10)) {
          lines.push(`  - \`${f.path}\` (${formatSizeHuman(f.size)})`);
        }
        if (files.length > 10) lines.push(`  - …还有 ${files.length - 10} 个文件`);
      }
    }
  }

  return lines.join("\n");
}

/** Build a system prompt that includes agent identity, assets, memories,
 *  teammate roster, and the shared workspace snapshot (for subtasks). */
function buildGuildAgentPrompt(
  agent: GuildAgent,
  task: GuildTask,
  groupId: string,
  memories: Array<{ title: string; content: string }>,
  strategy: ArtifactStrategy,
  sharedDir: string,
  wsDir: string,
): string {
  const sections: string[] = [];

  sections.push(`## You are "${agent.name}"`);
  if (agent.description) {
    sections.push(`**角色定位**：${agent.description}`);
  }
  sections.push(agent.systemPrompt);

  // Profile — skills and track record so the agent knows its own strengths.
  const profileLines: string[] = [];
  if (agent.skills.length > 0) {
    profileLines.push(`- **技能标签**：${agent.skills.join("、")}`);
  }
  const stats = agent.stats;
  if (stats && stats.tasksCompleted > 0) {
    const ratePct = Math.round(stats.successRate * 100);
    profileLines.push(`- **历史表现**：已完成 ${stats.tasksCompleted} 个任务，成功率 ${ratePct}%`);
  }
  if (profileLines.length > 0) {
    sections.push(`\n## Your Profile`);
    sections.push(profileLines.join("\n"));
  }

  if (agent.assets.length > 0) {
    const resolved = resolveAssetContext(agent.assets);
    sections.push(`\n## Your Assets`);
    for (const ctx of resolved) {
      sections.push(ctx.contextSnippet);
    }
  }

  // Teammate roster — who your colleagues are, what they own, collaboration rules.
  const roster = buildTeammateRoster(groupId, agent.id);
  if (roster) {
    sections.push(`\n${roster}`);
  }

  // Workspace snapshot — shared blackboard for the parent requirement, if any.
  const wsParent = task.parentTaskId ?? (task.kind === "requirement" ? task.id : undefined);
  if (wsParent) {
    const snapshot = snapshotForPrompt(groupId, wsParent);
    if (snapshot) {
      sections.push(`\n## Shared Workspace (living blackboard — read before you start)`);
      sections.push(snapshot);
    }
  }

  // Artifact inventory — let the agent see its own + teammates' existing files
  // before it starts writing, so it doesn't silently overwrite prior output.
  const inventory = buildArtifactInventory(agent, groupId, strategy);
  if (inventory) {
    sections.push(`\n${inventory}`);
  }

  if (memories.length > 0) {
    sections.push(`\n## Relevant Experience & Knowledge`);
    for (const mem of memories) {
      sections.push(`### ${mem.title}\n${mem.content}`);
    }
  }

  sections.push(`\n## Current Task`);
  sections.push(`Title: ${task.title}`);
  sections.push(`Description: ${task.description}`);
  sections.push(`Priority: ${task.priority}`);
  if (task.acceptanceCriteria) {
    sections.push(`Acceptance: ${task.acceptanceCriteria}`);
  }

  // Retry feedback — when the harness rejected the previous attempt, the
  // agent must see *why* before retrying. Without this, retries just repeat
  // the same broken submission. Lives between Description and Workspace so
  // the agent reads task → why-it-failed → where-to-write in order.
  if (task.lastFailure && (task.retryCount ?? 0) > 0) {
    const lf = task.lastFailure;
    sections.push(`\n## ⚠️ Previous Attempt Failed (this is retry ${(task.retryCount ?? 1)} of ${task.retryPolicy?.max ?? "?"})`);
    sections.push(`上一轮交付被 harness 验收驳回。**先读完这里的失败原因，再开始新一轮工作 — 不要重复同样的产物**：`);
    sections.push("```");
    sections.push(lf.reason);
    sections.push("```");
    if (lf.failedAssertions && lf.failedAssertions.length > 0) {
      sections.push(`\n**未通过的机器校验断言**（必须在本轮全部满足）：`);
      for (const a of lf.failedAssertions) {
        if (a.type === "file_exists") {
          sections.push(`- 文件必须存在：\`${a.ref}\`${a.description ? ` — ${a.description}` : ""}`);
        } else {
          const matchKind = a.regex ? "正则" : "子串";
          sections.push(`- 文件 \`${a.ref}\` 必须${matchKind}匹配：\`${a.pattern}\`${a.description ? ` — ${a.description}` : ""}`);
        }
      }
    }
    sections.push(`\n建议先排查上轮失败的具体原因（路径写错？没真正落盘？正则不匹配？），再动手；如果你判断这个任务不属于你的领域，请在 Handoff 中明确说"哪部分需要谁"，让 Lead 改派，不要硬交。`);
  }

  // Workspace paths — tell the agent where to write files
  sections.push(`\n## Your Workspace`);
  sections.push(`- 你的私有工作空间: \`${wsDir}\` — 在这里创建和编辑工作文件`);
  sections.push(`- 小组共享目录: \`${sharedDir}\` — 希望小组成员看到的产物放在这里`);
  sections.push(`- 写入共享目录的文件会自动对小组可见`);
  if (strategy === "isolated") {
    sections.push(`- 当前模式: **隔离模式** — 工作空间和共享产物目录按任务隔离，仅属于当前任务`);
  } else {
    sections.push(`- 当前模式: **协作模式** — 共享目录由所有任务共用，系统会自动追踪文件归属`);
    sections.push(`- 你可以读取和修改其他任务留下的文件，但请在 Handoff 中声明修改原因`);
  }

  // ─── Instructions: lightweight tasks get a much smaller block ─────
  // A "lightweight" task has no parent (not part of a decomposition or
  // pipeline), no formal acceptance criteria, no dependencies, and a short
  // description. For these we skip the mandatory handoff block — the agent
  // can just answer directly. Decomposition / pipeline subtasks still need
  // handoff because downstream consumers read it via appendHandoff.
  const isLightweight =
    !task.parentTaskId &&
    !task.acceptanceCriteria &&
    (!task.acceptanceAssertions || task.acceptanceAssertions.length === 0) &&
    (!task.dependsOn || task.dependsOn.length === 0) &&
    (task.description?.length ?? 0) < 300;

  sections.push(`\n## Instructions`);
  if (isLightweight) {
    sections.push(`完成上面的任务，**直接给出答案**即可，不要列执行计划、不要写验收清单、不要追加 Handoff JSON。`);
    sections.push(`如果任务超出你的领域，简短说明哪部分需要别人协助即可。`);
    sections.push(``);
    sections.push(`只有在你**确实创建了文件**（如代码、报告）或**学到值得记录的领域知识**时，才在末尾追加 \`\`\`handoff JSON 块声明。其他情况一律省略 handoff。`);
  } else {
    sections.push(`完成上面的任务。如果任务包含不属于你领域的工作，**不要硬做** — 在 Handoff 中说明"哪部分需要谁"，Lead 会补发新子任务。`);
    sections.push(``);
    sections.push(`**输出风格要求**（重要 — 偏离会被视为错误格式）：`);
    sections.push(`- 正文**只写最终交付内容**。不要"### 执行计划完成清单"、"### 步骤验证"、"### 最终结果"这种章节标题。`);
    sections.push(`- 不要写"验收证据"、"步骤如下"、"已完成 X"这种自我汇报 — 这些信息只放在 Handoff JSON 的 \`summary\` 字段里。`);
    sections.push(`- 反例（**不要这样写**）：`);
    sections.push("  ```");
    sections.push(`  ### 执行计划完成清单`);
    sections.push(`  1. 选择主题 [x]`);
    sections.push(`     - 验收证据：选择了 ...`);
    sections.push(`  ### 最终答案`);
    sections.push(`  XXX`);
    sections.push("  ```");
    sections.push(`- 正例（**这样写**）：`);
    sections.push("  ```");
    sections.push(`  XXX`);
    sections.push("  ```");
    sections.push(`  然后追加 \`\`\`handoff JSON。`);
    sections.push(``);
    sections.push(`完成后，在回复的最后追加一个结构化 Handoff 块，严格使用以下格式（字面 fence，中间是 JSON）：`);
    sections.push("```handoff");
    sections.push(`{`);
    sections.push(`  "summary": "一句话说明你做了什么",`);
    sections.push(`  "artifacts": [`);
    sections.push(`    { "kind": "commit|file|url|note", "ref": "具体引用", "description": "可选说明" }`);
    sections.push(`  ],`);
    sections.push(`  "memories": [`);
    sections.push(`    { "type": "knowledge|preference", "title": "短标题", "content": "具体内容", "tags": ["标签"] }`);
    sections.push(`  ],`);
    sections.push(`  "inputsConsumed": ["上游 handoff/文件/决策"],`);
    sections.push(`  "openQuestions": ["留给下游的问题"]`);
    sections.push(`}`);
    sections.push("```");
    sections.push(`**重要**：artifacts 里的 \`kind: "file"\` 必须是你**真实写入磁盘**的文件路径。如果你只是把内容写在回复正文里，请用 \`kind: "note"\` — 否则会被检测为缺失文件。`);
    sections.push(`memories 用于记录你在本次任务中学到的重要信息：`);
    sections.push(`- knowledge: 领域知识、技术要点、API 用法、架构细节等可复用的事实`);
    sections.push(`- preference: 你发现的有效工作方式、工具偏好、代码风格等行为偏好`);
    sections.push(`不需要每次都写 memories，只在确实学到新东西时添加。experience 类型会自动从任务结果生成。`);
    sections.push(``);
    sections.push(`Handoff 块之外的内容仍可以自由书写（解释、思考、代码片段），但 JSON 必须是有效的。`);
    sections.push(``);
    sections.push(`如果任务要求产出结构化数据（例如下游步骤需要一个数组或字段），再追加一个 \`pipeline-output\` 块：`);
    sections.push("```pipeline-output");
    sections.push(`{ "key": "value", "items": [ ... ] }`);
    sections.push("```");
    sections.push(`该块仅在任务描述明确要求时添加；对普通任务可省略。`);
  }

  return sections.join("\n");
}

/** Execute a task with a guild agent, streaming output via events */
export async function executeAgentTask(
  agentId: string,
  groupId: string,
  taskId: string,
  options?: ExecutionOptions
): Promise<TaskResult> {
  const agent = getAgent(agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  const task = getTask(groupId, taskId);
  if (!task) throw new Error(`Task ${taskId} not found in group ${groupId}`);

  // Resolve artifact strategy for this group
  const group = getGroup(groupId);
  const artifactStrategy: ArtifactStrategy = group?.artifactStrategy ?? "isolated";

  // Ensure workspace directories exist before execution
  let wsDir: string;
  let sharedDir: string;
  if (artifactStrategy === "isolated") {
    wsDir = join(getAgentWorkspaceDir(agentId), taskId);
    sharedDir = join(getGroupSharedDir(groupId), taskId);
  } else {
    wsDir = getAgentWorkspaceDir(agentId);
    sharedDir = getGroupSharedDir(groupId);
  }
  if (!existsSync(wsDir)) mkdirSync(wsDir, { recursive: true });
  if (!existsSync(sharedDir)) mkdirSync(sharedDir, { recursive: true });

  // Snapshot for collaborative manifest reconciliation. Only the *shared*
  // dir needs tracking — the private workspace is single-writer so nothing
  // there needs createdBy/modifiedBy attribution.
  const sharedSnapshotBefore = artifactStrategy === "collaborative" ? snapshotDir(sharedDir) : new Map<string, number>();

  const key = execKey(groupId, taskId);
  activeExecutions.add(key);

  // Update agent status
  updateAgent(agentId, { status: "working", currentTaskId: taskId });
  guildEventBus.emit({ type: "agent_status_changed", agentId, status: "working" });
  guildEventBus.emit({ type: "agent_updated", agentId });

  // Initialize execution log
  initExecutionLog(groupId, taskId, agentId);

  const startTime = Date.now();
  // Guards against double-counting stats when the success path mutates stats
  // and then an exception before the function returns forces the catch block
  // to also mutate stats. Only the first path that runs should update counts.
  let statsCounted = false;

  try {
    // Search relevant memories
    const relevantMemories = searchRelevant(agentId, `${task.title} ${task.description}`, 5);
    const memoryContext = relevantMemories.map((m) => ({ title: m.title, content: m.content }));

    // Build system prompt (includes teammate roster + workspace snapshot)
    const systemPrompt = buildGuildAgentPrompt(agent, task, groupId, memoryContext, artifactStrategy, sharedDir, wsDir);

    // Build initial messages
    const messages = [new HumanMessage(task.description)];

    let accumulatedContent = "";

    const userConfig = loadUserConfig();
    const harnessConfig = buildGuildHarnessConfig();

    // For lightweight ad-hoc tasks the planning prelude (a separate LLM call
    // that emits the "执行计划完成清单" structure) doubles latency and pushes the
    // model toward verbose self-reporting in the main response. Skip it when
    // the task is small + parameter-free; mirrors the buildGuildAgentPrompt
    // lightweight branch above.
    const lightweight =
      !task.parentTaskId &&
      !task.acceptanceCriteria &&
      (!task.acceptanceAssertions || task.acceptanceAssertions.length === 0) &&
      (!task.dependsOn || task.dependsOn.length === 0) &&
      (task.description?.length ?? 0) < 300;

    // Run agent using existing streamAgentWithTokens
    const stream = streamAgentWithTokens(
      messages,
      (token) => {
        accumulatedContent += token;
        guildEventBus.emit({ type: "agent_output", agentId, taskId, content: token });
        appendExecutionLog(groupId, taskId, { type: "text", content: token, timestamp: new Date().toISOString() });
      },
      agent.modelId,
      (reasoningToken) => {
        guildEventBus.emit({ type: "agent_reasoning", agentId, taskId, content: reasoningToken });
        appendExecutionLog(groupId, taskId, { type: "reasoning", content: reasoningToken, timestamp: new Date().toISOString() });
      },
      undefined, // skillContext
      {
        subagentSystemPromptOverride: systemPrompt,
        conversationMode: "default",
        allowedTools: agent.allowedTools,
        planningEnabled: lightweight ? false : (userConfig.planning?.enabled ?? true),
        planProgressEnabled: userConfig.planning?.streamProgress ?? true,
        enhancements: userConfig.enhancements,
        ...(harnessConfig ? { harnessConfig } : {}),
        onPlanEvent: (event: PlanStreamEvent) => {
          // Skip the terminal "completed" phase — the plan card was already
          // rendered on "created" and it would otherwise re-render with
          // currentStep past the last step (e.g. "3 步 · 当前 4").
          if (event.phase === "completed") return;
          guildEventBus.emit({ type: "agent_plan", agentId, taskId, phase: event.phase, payload: event });
          appendExecutionLog(groupId, taskId, {
            type: "plan",
            content: event.phase,
            payload: event,
            timestamp: new Date().toISOString(),
          });
        },
        onHarnessEvent: (event: HarnessEvent) => {
          guildEventBus.emit({ type: "agent_harness", agentId, taskId, kind: event.kind, payload: event });
          appendExecutionLog(groupId, taskId, {
            type: "harness",
            content: event.kind,
            payload: event,
            timestamp: new Date().toISOString(),
          });
        },
      }
    );

    // Consume the stream
    for await (const chunk of stream) {
      if (abortRequests.has(key)) {
        throw new Error(RELEASED_ERROR_TAG);
      }
      // Extract tool calls from LLM response (AIMessage with tool_calls)
      if (chunk.llmCall && "messages" in chunk.llmCall) {
        for (const msg of chunk.llmCall.messages ?? []) {
          const toolCalls = (msg as { tool_calls?: Array<{ name: string; args: unknown }> }).tool_calls;
          if (toolCalls && toolCalls.length > 0) {
            for (const tc of toolCalls) {
              guildEventBus.emit({ type: "agent_tool_call", agentId, taskId, tool: tc.name, input: tc.args });
              appendExecutionLog(groupId, taskId, {
                type: "tool_call", content: tc.name, tool: tc.name,
                args: JSON.stringify(tc.args, null, 2), timestamp: new Date().toISOString(),
              });
            }
          }
        }
      }
      // Extract tool results
      if (chunk.toolNode && "messages" in chunk.toolNode) {
        for (const msg of chunk.toolNode.messages ?? []) {
          const content = typeof msg.content === "string" ? msg.content : "";
          const name = (msg as { name?: string }).name ?? "unknown";
          guildEventBus.emit({ type: "agent_tool_result", agentId, taskId, tool: name, output: content.slice(0, 4000) });
          appendExecutionLog(groupId, taskId, {
            type: "tool_result", content, tool: name, timestamp: new Date().toISOString(),
          });
        }
      }
    }

    const durationMs = Date.now() - startTime;

    // Parse structured handoff block out of the final output. We keep the
    // full accumulatedContent as the summary so nothing is lost, but the
    // parsed handoff is what gets written back to the workspace + task.
    const parsedHandoff = parseHandoffFromSummary(accumulatedContent);
    let handoff: TaskHandoff | undefined;
    if (parsedHandoff) {
      handoff = {
        fromAgentId: agentId,
        summary: parsedHandoff.summary,
        artifacts: parsedHandoff.artifacts ?? [],
        inputsConsumed: parsedHandoff.inputsConsumed,
        openQuestions: parsedHandoff.openQuestions,
        memories: parsedHandoff.memories,
        createdAt: new Date().toISOString(),
      };
    }

    const structuredOutput = parseStructuredOutput(accumulatedContent) ?? undefined;

    // Build result
    const result: TaskResult = {
      summary: accumulatedContent || "Task completed (no output)",
      handoff,
      structuredOutput,
    };

    // Detect agent rejection: the agent says it can't do this task and asks
    // for reassignment. Reset to open so the scheduler can re-dispatch.
    const isRejection = detectRejection(accumulatedContent, handoff);
    if (isRejection) {
      serverLogger.info("[guild] Agent rejected task, resetting for re-dispatch", { agentId, taskId });
      const rejectedBy = [...(task._rejectedBy ?? []), agentId];
      updateTask(groupId, taskId, {
        status: "open",
        assignedAgentId: undefined,
        result: undefined,
        startedAt: undefined,
        completedAt: undefined,
        bids: [],
        // Blacklist this agent so the scheduler doesn't assign it again
        _rejectedBy: rejectedBy,
      } as Partial<GuildTask>);
      finalizeExecutionLog(groupId, taskId, "failed");
      // Emit the post-update snapshot so subscribers see the fresh _rejectedBy
      // list — previously the pre-update `task` object was emitted.
      guildEventBus.emit({
        type: "task_updated",
        task: {
          ...task,
          status: "open",
          assignedAgentId: undefined,
          result: undefined,
          startedAt: undefined,
          completedAt: undefined,
          bids: [],
          _rejectedBy: rejectedBy,
        },
      });

      updateAgent(agentId, { status: "idle", currentTaskId: undefined });
      guildEventBus.emit({ type: "agent_status_changed", agentId, status: "idle" });
      guildEventBus.emit({ type: "agent_updated", agentId });
      return result;
    }

    // ─── Deliverable validation ─────────────────────────────────────
    // An agent is only "done" if it actually produced something. Checks:
    //   1. The model emitted at least some content (not pure silence).
    //   2. Any `.md`/code-file name mentioned in the acceptance criteria is
    //      on disk. Catches cases where the agent forgot to list artifacts.
    // Handoff `kind:"file"` artifacts pointing at non-existent paths get
    // demoted to `kind:"note"` (with a recovery note describing the lost
    // file ref) — Doubao mini and other smaller models routinely fabricate
    // file paths in handoff JSON without ever invoking write_file, and
    // throwing turned every text-only deliverable into a hard failure.
    // Acceptance-criteria-mentioned files remain a hard requirement: those
    // are explicit user-declared file deliverables, not model hallucinations.
    if (!accumulatedContent.trim()) {
      throw new Error("Agent produced no output");
    }
    if (handoff && handoff.artifacts.length > 0) {
      const demoted: string[] = [];
      handoff.artifacts = handoff.artifacts.map((a) => {
        if (a.kind !== "file") return a;
        if (resolveArtifactPath(a.ref, sharedDir, wsDir)) return a;
        demoted.push(a.ref);
        return {
          ...a,
          kind: "note",
          description: a.description
            ? `${a.description}（注：声明的文件 ${a.ref} 未实际写入磁盘，已降级为 note）`
            : `声明的文件 ${a.ref} 未实际写入磁盘，已降级为 note`,
        };
      });
      if (demoted.length > 0) {
        serverLogger.warn("[guild] handoff file artifact(s) missing — demoted to note", {
          taskId, agentId, refs: demoted,
        });
      }
    }
    const criteriaFiles = extractFileRefsFromCriteria(task.acceptanceCriteria);
    if (criteriaFiles.length > 0) {
      const missingCriteria = criteriaFiles.filter(
        (f) => !resolveArtifactPath(f, sharedDir, wsDir),
      );
      if (missingCriteria.length > 0) {
        throw new Error(
          `Acceptance criteria require file(s) that weren't produced: ${missingCriteria.join(", ")}`,
        );
      }
    }

    // Reconcile manifest in collaborative mode — track which files this task
    // created/modified in the shared dir only. Await so a late manifest write
    // doesn't race the next task's snapshot.
    if (artifactStrategy === "collaborative") {
      try {
        await reconcileManifest(sharedDir, taskId, agentId, sharedSnapshotBefore);
      } catch (e) {
        serverLogger.warn("[guild] manifest reconciliation failed", { taskId, error: String(e) });
      }
    }

    // Complete task — completeTask runs acceptanceAssertions and may flip the
    // task to "failed" on a failed verdict; in that case the returned task
    // carries status "failed" and we must NOT count this as a success.
    const finalized = completeTask(groupId, taskId, agentId, result);
    const assertionFailed = finalized?.status === "failed";

    finalizeExecutionLog(groupId, taskId, assertionFailed ? "failed" : "completed");

    // Apply stats *immediately* after completion so any throw in the
    // non-critical post-complete steps below (handoff append, settleExperience)
    // still leaves correct counters. `statsCounted` then guards the catch
    // block from double-mutating.
    const stats = agent.stats;
    if (assertionFailed) {
      stats.tasksFailed = (stats.tasksFailed ?? 0) + 1;
    } else {
      stats.tasksCompleted++;
      stats.tasksFailed = stats.tasksFailed ?? 0;
    }
    stats.totalWorkTimeMs += durationMs;
    const total = stats.tasksCompleted + stats.tasksFailed;
    stats.successRate = total > 0 ? stats.tasksCompleted / total : 1;
    // Running mean of winning-bid confidence across all settled tasks. The
    // older code initialised this to 0 and never updated it, so the UI's
    // "平均置信度" tile sat at 0% no matter how many tasks an agent shipped.
    // Pull the winner's confidence from the task's bids array — that's the
    // canonical record of what the bidder thought before execution started.
    const winnerBid = task.bids?.find((b) => b.agentId === agentId);
    if (winnerBid && total > 0) {
      const prev = stats.avgConfidence ?? 0;
      stats.avgConfidence = (prev * (total - 1) + winnerBid.confidence) / total;
    }
    stats.lastActiveAt = new Date().toISOString();
    updateAgentStats(agentId, stats);
    statsCounted = true;

    // Acceptance-assertion rejection: skip success-only side effects (handoff
    // append, memory settle) and short-circuit. completeTask already emitted
    // task_failed and rolled up the parent requirement.
    if (assertionFailed) {
      updateAgent(agentId, { status: "idle", currentTaskId: undefined });
      guildEventBus.emit({ type: "agent_status_changed", agentId, status: "idle" });
      guildEventBus.emit({ type: "agent_updated", agentId });
      return { summary: finalized?.result?.summary ?? "Acceptance assertions failed" };
    }

    // Persist handoff to the shared workspace so downstream teammates can see it.
    if (handoff && task.parentTaskId) {
      try {
        appendHandoff(groupId, task.parentTaskId, taskId, handoff);
      } catch (e) {
        serverLogger.warn("[guild] failed to append handoff to workspace", {
          groupId,
          parentTaskId: task.parentTaskId,
          taskId,
          error: String(e),
        });
      }
    }

    // Settle memory — non-critical, wrap so a memory-subsystem fault doesn't
    // mask the fact that the task already completed successfully.
    try {
      const memories = settleExperience(agentId, task, result);
      result.memoryCreated = memories.map((m) => m.id);
    } catch (e) {
      serverLogger.warn("[guild] settleExperience failed", {
        agentId,
        taskId,
        error: String(e),
      });
    }

    // Reset agent status
    updateAgent(agentId, { status: "idle", currentTaskId: undefined });
    guildEventBus.emit({ type: "agent_status_changed", agentId, status: "idle" });
    guildEventBus.emit({ type: "agent_updated", agentId });

    return result;
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : String(error);
    const wasReleased = errorMsg === RELEASED_ERROR_TAG || abortRequests.has(key);
    if (wasReleased) {
      serverLogger.warn(`[guild] Agent ${agentId} released mid-execution on task ${taskId}`);
    } else {
      serverLogger.error(`[guild] Agent ${agentId} failed on task ${taskId}`, { error: errorMsg });
    }

    // Fail task — completeTask/failTask are no-ops if the task was already finalized
    // (e.g. user-initiated release marked it cancelled before this returned).
    failTask(groupId, taskId, agentId, wasReleased ? "Released by user" : errorMsg);
    finalizeExecutionLog(groupId, taskId, "failed");

    // Update stats — skip if the success path already counted this task
    // (rare but possible when code after completeTask throws).
    if (!statsCounted) {
      const stats = agent.stats;
      stats.tasksFailed = (stats.tasksFailed ?? 0) + 1;
      stats.totalWorkTimeMs += durationMs;
      stats.lastActiveAt = new Date().toISOString();
      const total = stats.tasksCompleted + stats.tasksFailed;
      stats.successRate = total > 0 ? stats.tasksCompleted / total : 0;
      updateAgentStats(agentId, stats);
    }

    // Reset agent status
    updateAgent(agentId, { status: "idle", currentTaskId: undefined });
    guildEventBus.emit({ type: "agent_status_changed", agentId, status: "idle" });
    guildEventBus.emit({ type: "agent_updated", agentId });

    return { summary: `Failed: ${errorMsg}` };
  } finally {
    activeExecutions.delete(key);
    abortRequests.delete(key);
  }
}
