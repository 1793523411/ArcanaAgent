import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { GuildTask, GuildAgent, AgentAsset, CreateTaskParams, Group } from "./types.js";
import { getGroup, getGroupAgents, getAggregatedGroupAssets, getAgent } from "./guildManager.js";
import { createTask, updateTask, getSubtasks, getTask, initExecutionLog, appendExecutionLog, finalizeExecutionLog } from "./taskBoard.js";
import {
  updateScopeSection,
  appendDecision,
  setWorkspaceStatus,
  setOpenQuestions,
  getWorkspaceRef,
} from "./workspace.js";
import { ensureParentWorkspace, finalizeParentDecomposition } from "./parentLifecycle.js";
import { getModelAdapter } from "../llm/adapter.js";
import { loadUserConfig } from "../config/userConfig.js";
import { serverLogger } from "../lib/logger.js";
import { guildEventBus } from "./eventBus.js";

/**
 * Tech-lead decomposition: turn a user-submitted requirement into a DAG of
 * subtasks. The planner runs one LLM call (using the user-selected model),
 * parses a strict JSON response, and writes subtasks + workspace.
 *
 * Design choices:
 *  - Model selection honors Group.leadAgentId → agent.modelId → userConfig.modelId
 *    → hardcoded default. This matches the user's requirement that the planner
 *    use whichever model the user has configured.
 *  - On JSON parse failure we retry once. If retry still fails we downgrade the
 *    requirement to `adhoc` kind so the normal bidding path can pick it up,
 *    logging the failure so the user can inspect it later.
 */

export interface PlannerSubtaskSpec {
  title: string;
  description: string;
  suggestedSkills?: string[];
  suggestedAgentId?: string | null;
  dependsOn?: number[];
  acceptanceCriteria?: string;
  priority?: "low" | "medium" | "high" | "urgent";
}

export interface PlannerResult {
  goal: string;
  scope: { repos?: string[]; outOfScope?: string[] };
  subtasks: PlannerSubtaskSpec[];
  risks?: string[];
  acceptanceCriteria?: string;
  openQuestions?: string[];
}

export interface PlanRequirementOutcome {
  ok: boolean;
  subtaskIds?: string[];
  reason?: string;
  raw?: string;
  result?: PlannerResult;
}

// ─── Model selection ──────────────────────────────────────────

function resolvePlannerModelId(group: Group): string | undefined {
  if (group.leadAgentId) {
    const lead = getAgent(group.leadAgentId);
    if (lead?.modelId) return lead.modelId;
  }
  const cfg = loadUserConfig();
  return cfg.modelId;
}

// ─── Prompt builders ──────────────────────────────────────────

function renderAssetLine(a: AgentAsset): string {
  const owner = a.ownerAgentId ? ` · owner: \`${a.ownerAgentId}\`` : "";
  const tags = a.tags && a.tags.length > 0 ? ` · tags: ${a.tags.join(", ")}` : "";
  const desc = a.description ? ` — ${a.description}` : "";
  return `- \`${a.name}\` (${a.type}, ${a.uri})${desc}${owner}${tags}`;
}

function renderAgentLine(a: GuildAgent): string {
  const desc = (a.description ?? "").replace(/\s+/g, " ").trim() || "(no description)";
  const assetNames = a.assets.map((x) => x.name).slice(0, 5).join(", ");
  const ownedStr = assetNames ? ` · private assets: ${assetNames}` : "";
  return `- \`${a.id}\` **${a.name}**: ${desc}${ownedStr}`;
}

function buildPlannerSystemPrompt(group: Group): string {
  const agents = getGroupAgents(group.id);
  const assets = getAggregatedGroupAssets(group.id);

  const sections: string[] = [];
  sections.push(`你是 Guild 小组 "${group.name}" 的 Tech Lead。职责：把一条需求拆成最小可并行的 subtask DAG，分派给最合适的同事。`);
  sections.push(``);
  sections.push(`## 小组成员`);
  if (agents.length === 0) {
    sections.push(`- (暂无)`);
  } else {
    for (const a of agents) sections.push(renderAgentLine(a));
  }
  sections.push(``);
  sections.push(`## 小组资源（repos、文档、API、MCP 等）`);
  if (assets.length === 0) {
    sections.push(`- (暂无)`);
  } else {
    for (const a of assets) sections.push(renderAssetLine(a));
  }
  sections.push(``);
  if (group.sharedContext) {
    sections.push(`## 小组共识/约定`);
    sections.push(group.sharedContext);
    sections.push(``);
  }
  sections.push(`## 输出格式（必须是严格的 JSON，不要用 markdown 代码块包裹）`);
  sections.push(`{
  "goal": "把用户需求用一句话精炼地重述",
  "scope": {
    "repos": ["可能涉及的仓库/资产名称"],
    "outOfScope": ["本次明确不做的事"]
  },
  "subtasks": [
    {
      "title": "短标题",
      "description": "具体说明该子任务要做什么，要具体到文件/API/验收标准",
      "suggestedSkills": ["backend", "repo:foo"],
      "suggestedAgentId": "<小组内 agent id 或 null>",
      "dependsOn": [],
      "priority": "medium",
      "acceptanceCriteria": "如何判定这个子任务完成"
    }
  ],
  "risks": ["潜在风险"],
  "acceptanceCriteria": "整体验收标准",
  "openQuestions": ["需要用户澄清的问题"]
}`);
  sections.push(``);
  sections.push(`## 强制规则`);
  sections.push(`1. 每个 subtask 必须能被单个 agent 独立完成。跨仓库的工作必须拆成不同 subtask。`);
  sections.push(`2. dependsOn 使用数组下标（从 0 开始）引用前面的 subtask，形成 DAG。不允许环。`);
  sections.push(`3. suggestedAgentId 只能是上方"小组成员"列出的真实 id；若不确定可填 null。`);
  sections.push(`4. 不要输出任何 JSON 之外的文字（不要解释、不要道歉、不要 markdown）。`);
  sections.push(`5. 如果信息不足无法拆解，返回 "subtasks": []，并在 openQuestions / risks 里说明原因。`);
  sections.push(`6. **不要凭空加"整合 / 汇总 / 总结 / 输出最终交付物"这类纯收尾子任务**：父任务有内置 rollup 会自动汇总所有子任务结果。只有当用户明确要求"产出一份合并报告 / 整合文档 / 综合方案"等真实需要 LLM 综合判断的产出时，才允许追加一个综合子任务，并在 description 中写明它的 specific 产出。`);
  return sections.join("\n");
}

function buildPlannerUserPrompt(requirement: GuildTask): string {
  return [
    `## 需求`,
    `标题: ${requirement.title}`,
    `优先级: ${requirement.priority}`,
    ``,
    `## 描述`,
    requirement.description,
    ``,
    `请立即输出 JSON 拆解结果。`,
  ].join("\n");
}

// ─── Response parsing ─────────────────────────────────────────

function extractJson(raw: string): string | null {
  const trimmed = raw.trim();
  // Strip ```json ... ``` if the model ignored instructions
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) return fence[1].trim();
  // Find first { and its matching last }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < 0 || end < start) return null;
  return trimmed.slice(start, end + 1);
}

function parsePlannerResponse(raw: string): PlannerResult | null {
  const jsonStr = extractJson(raw);
  if (!jsonStr) return null;
  try {
    const parsed = JSON.parse(jsonStr);
    if (typeof parsed !== "object" || parsed === null) return null;
    if (!Array.isArray(parsed.subtasks)) return null;
    return parsed as PlannerResult;
  } catch {
    return null;
  }
}

// ─── LLM call ─────────────────────────────────────────────────

async function callPlanner(modelId: string | undefined, system: string, user: string): Promise<string> {
  const adapter = getModelAdapter(modelId);
  const llm = adapter.getLLM();
  const response = await llm.invoke([new SystemMessage(system), new HumanMessage(user)]);
  const content = response.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : (c as { text?: string }).text ?? ""))
      .join("");
  }
  return String(content);
}

function renderScopeMd(result: PlannerResult): string {
  const lines: string[] = [];
  if (result.scope?.repos && result.scope.repos.length > 0) {
    lines.push(`- **Repos**: ${result.scope.repos.map((r) => `\`${r}\``).join(", ")}`);
  }
  if (result.scope?.outOfScope && result.scope.outOfScope.length > 0) {
    lines.push(`- **Out of scope**:`);
    for (const o of result.scope.outOfScope) lines.push(`  - ${o}`);
  }
  if (result.acceptanceCriteria) {
    lines.push(`- **Acceptance**: ${result.acceptanceCriteria}`);
  }
  return lines.length > 0 ? lines.join("\n") : "_Scope to be defined._";
}

// ─── Public entry point ───────────────────────────────────────

/**
 * Decompose a requirement task: call the LLM, persist subtasks, set up
 * workspace, flip the requirement to in_progress. Safe to call multiple
 * times — if the requirement already has subtasks it becomes a no-op.
 */
export async function planRequirement(
  groupId: string,
  requirement: GuildTask,
): Promise<PlanRequirementOutcome> {
  const group = getGroup(groupId);
  if (!group) return { ok: false, reason: "Group not found" };
  if (requirement.kind !== "requirement") {
    return { ok: false, reason: "Not a requirement-kind task" };
  }
  const existing = getSubtasks(groupId, requirement.id);
  if (existing.length > 0) {
    return { ok: true, subtaskIds: existing.map((t) => t.id), reason: "Already planned" };
  }

  // Mark as planning so the scheduler stops touching it
  updateTask(groupId, requirement.id, { status: "planning" });
  guildEventBus.emit({ type: "task_updated", task: { ...requirement, status: "planning" } });

  const modelId = resolvePlannerModelId(group);
  const system = buildPlannerSystemPrompt(group);
  const user = buildPlannerUserPrompt(requirement);

  // Ensure a workspace exists up-front so the lead's work is visible even if
  // the LLM call fails mid-flight. Shared with the Pipeline path via
  // parentLifecycle.ensureParentWorkspace.
  const workspaceRef = ensureParentWorkspace(groupId, requirement, "lead");

  // Surface planner work in the live execution panel. We re-use the agent
  // event channel so the existing log UI can render it without changes —
  // agentId is the configured Lead (or the synthetic "lead" id when none).
  const leadAgentId = group.leadAgentId ?? "lead";

  // Persist execution log server-side so it survives page refreshes.
  initExecutionLog(groupId, requirement.id, leadAgentId);
  const logPlan = (phase: string, payload?: unknown) => {
    appendExecutionLog(groupId, requirement.id, { type: "plan", content: phase, payload, timestamp: new Date().toISOString() });
  };
  const logText = (content: string) => {
    appendExecutionLog(groupId, requirement.id, { type: "text", content, timestamp: new Date().toISOString() });
  };

  guildEventBus.emit({
    type: "agent_plan",
    agentId: leadAgentId,
    taskId: requirement.id,
    phase: "planner_start",
    payload: { model: modelId ?? "(default)", title: requirement.title },
  });
  logPlan("planner_start", { model: modelId ?? "(default)", title: requirement.title });
  const startMsg = `▶ Lead 开始拆解需求\n模型: ${modelId ?? "(default)"}\n\n--- system prompt ---\n${system}\n\n--- user prompt ---\n${user}\n`;
  guildEventBus.emit({
    type: "agent_output",
    agentId: leadAgentId,
    taskId: requirement.id,
    content: startMsg,
  });
  logText(startMsg);

  let raw = "";
  let parsed: PlannerResult | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    // Heartbeat while the LLM is in flight — Lead decomposition can take
    // 30-60s on Doubao pro and the user previously stared at a frozen panel.
    // Streams a "...仍在思考" tick every 5s so the live log shows movement
    // without us having to plumb true token-level streaming through the
    // LangChain adapter (deferred — heartbeat covers ~80% of the UX win).
    let elapsed = 0;
    const heartbeat = setInterval(() => {
      elapsed += 5;
      const tick = `\n  ⏳ Lead 仍在拆解... (${elapsed}s)\n`;
      guildEventBus.emit({ type: "agent_output", agentId: leadAgentId, taskId: requirement.id, content: tick });
      logText(tick);
    }, 5000);
    try {
      raw = await callPlanner(modelId, system, user);
      clearInterval(heartbeat);
      const rawMsg = `\n--- LLM raw response (attempt ${attempt + 1}) ---\n${raw}\n`;
      guildEventBus.emit({ type: "agent_output", agentId: leadAgentId, taskId: requirement.id, content: rawMsg });
      logText(rawMsg);
      parsed = parsePlannerResponse(raw);
      if (parsed) break;
      serverLogger.warn("[guild.planner] JSON parse failed", { attempt, rawPreview: raw.slice(0, 300) });
      const parseMsg = `\n⚠ JSON 解析失败 (attempt ${attempt + 1})，正在重试...\n`;
      guildEventBus.emit({ type: "agent_output", agentId: leadAgentId, taskId: requirement.id, content: parseMsg });
      logText(parseMsg);
    } catch (e) {
      clearInterval(heartbeat);
      serverLogger.error("[guild.planner] LLM call failed", { attempt, error: String(e) });
      const errMsg = `\n✖ LLM 调用失败 (attempt ${attempt + 1}): ${String(e)}\n`;
      guildEventBus.emit({ type: "agent_output", agentId: leadAgentId, taskId: requirement.id, content: errMsg });
      logText(errMsg);
    }
  }

  if (!parsed) {
    // Downgrade to adhoc so the bidding path can still pick it up.
    updateTask(groupId, requirement.id, { kind: "adhoc", status: "open" });
    appendDecision(groupId, requirement.id, "lead", "Planner 拆解失败，降级为 adhoc 任务由 bidding 兜底");
    setWorkspaceStatus(groupId, requirement.id, "blocked");
    guildEventBus.emit({
      type: "agent_plan",
      agentId: leadAgentId,
      taskId: requirement.id,
      phase: "planner_failed",
      payload: { rawPreview: raw.slice(0, 300) },
    });
    logPlan("planner_failed", { rawPreview: raw.slice(0, 300) });
    finalizeExecutionLog(groupId, requirement.id, "failed");
    return { ok: false, reason: "Planner failed to produce valid JSON", raw };
  }

  // Empty subtasks means the LLM couldn't decompose (e.g. insufficient info).
  // Surface openQuestions/risks and downgrade to adhoc instead of claiming success with 0 subtasks.
  if (parsed.subtasks.length === 0) {
    const questions = parsed.openQuestions ?? [];
    const risks = parsed.risks ?? [];
    const clarification = [...questions, ...risks].join("；") || "信息不足，无法拆解";

    updateTask(groupId, requirement.id, { kind: "adhoc", status: "open" });
    appendDecision(groupId, requirement.id, group.leadAgentId ?? "lead", `拆解产出 0 个子任务，降级为 adhoc：${clarification}`);
    setWorkspaceStatus(groupId, requirement.id, "blocked");

    const emptyMsg = `\n⚠ 拆解产出 0 个子任务，需要澄清：\n${clarification}\n\n已降级为 adhoc 任务。\n`;
    guildEventBus.emit({ type: "agent_output", agentId: leadAgentId, taskId: requirement.id, content: emptyMsg });
    logText(emptyMsg);
    guildEventBus.emit({
      type: "agent_plan",
      agentId: leadAgentId,
      taskId: requirement.id,
      phase: "planner_failed",
      payload: { reason: "empty_subtasks", openQuestions: questions, risks },
    });
    logPlan("planner_failed", { reason: "empty_subtasks", openQuestions: questions, risks });
    finalizeExecutionLog(groupId, requirement.id, "failed");
    return { ok: false, reason: `Empty subtasks: ${clarification}`, raw, result: parsed };
  }

  // Two-pass creation: first create every subtask with empty deps, then resolve
  // dependsOn indices to real ids. This makes forward references (i depends on
  // j where j > i) work correctly — previously those were silently dropped by
  // `idByIndex.get(...)` returning undefined.
  const N = parsed.subtasks.length;
  const createdSubtasks: GuildTask[] = [];
  const idByIndex = new Map<number, string>();
  const droppedDeps: Array<{ from: number; to: number; reason: string }> = [];

  // Pass 1: create all subtasks in "blocked" state so the scheduler can't
  // grab them between now and pass 2. If we left them in "open" with empty
  // deps, the first subtask would race the second-pass update and might be
  // dispatched before its real deps are wired.
  for (let i = 0; i < N; i++) {
    const spec = parsed.subtasks[i];
    const params: CreateTaskParams = {
      title: spec.title,
      description: spec.description,
      kind: "subtask",
      priority: spec.priority ?? requirement.priority,
      parentTaskId: requirement.id,
      suggestedSkills: spec.suggestedSkills,
      suggestedAgentId: spec.suggestedAgentId ?? undefined,
      acceptanceCriteria: spec.acceptanceCriteria,
      workspaceRef,
      createdBy: group.leadAgentId ?? "lead",
      initialStatus: "blocked",
    };
    const sub = createTask(groupId, params);
    createdSubtasks.push(sub);
    idByIndex.set(i, sub.id);
  }

  // Pass 2: resolve dependsOn (validating each index) and atomically flip
  // status to "open" in the same update so the scheduler sees a consistent
  // "ready-for-dispatch-with-deps" state.
  for (let i = 0; i < N; i++) {
    const spec = parsed.subtasks[i];
    const rawDeps = spec.dependsOn ?? [];
    const depIds: string[] = [];
    const seen = new Set<number>();
    for (const idx of rawDeps) {
      if (typeof idx !== "number" || !Number.isInteger(idx)) {
        droppedDeps.push({ from: i, to: idx as number, reason: "非整数索引" });
        continue;
      }
      if (idx === i) {
        droppedDeps.push({ from: i, to: idx, reason: "自依赖" });
        continue;
      }
      if (idx < 0 || idx >= N) {
        droppedDeps.push({ from: i, to: idx, reason: `超出范围 [0, ${N - 1}]` });
        continue;
      }
      if (seen.has(idx)) continue;
      seen.add(idx);
      const depId = idByIndex.get(idx);
      if (depId) depIds.push(depId);
    }
    updateTask(groupId, createdSubtasks[i].id, {
      status: "open",
      dependsOn: depIds,
    });
    createdSubtasks[i].status = "open";
    createdSubtasks[i].dependsOn = depIds;
  }

  if (droppedDeps.length > 0) {
    const lines = droppedDeps.map((d) => `  - 子任务 ${d.from} → ${d.to}：${d.reason}`).join("\n");
    const warning = `\n⚠ Planner 生成了 ${droppedDeps.length} 条无效依赖，已忽略：\n${lines}\n`;
    serverLogger.warn("[guild.planner] dropped invalid deps", { requirementId: requirement.id, droppedDeps });
    guildEventBus.emit({ type: "agent_output", agentId: leadAgentId, taskId: requirement.id, content: warning });
    logText(warning);
    appendDecision(
      groupId,
      requirement.id,
      group.leadAgentId ?? "lead",
      `Planner 有 ${droppedDeps.length} 条无效依赖被忽略（详见执行日志）`,
    );
  }

  // A requirement with children is an orchestration container, not a
  // biddable task. Mark it in_progress so the UI renders the group header
  // in the same column as its running subtasks. Bidding/scheduling skip
  // kind === "requirement" regardless of status.
  // Stamp parent in_progress + subtaskIds + render Plan table — shared with
  // the Pipeline path via parentLifecycle.finalizeParentDecomposition.
  const subtaskIds = createdSubtasks.map((t) => t.id);
  finalizeParentDecomposition(groupId, requirement, createdSubtasks);

  // Workspace: scope + open questions are requirement-specific (pipelines
  // render their own Deliverables section instead).
  updateScopeSection(groupId, requirement.id, renderScopeMd(parsed));
  if (parsed.openQuestions && parsed.openQuestions.length > 0) {
    setOpenQuestions(groupId, requirement.id, parsed.openQuestions);
  }
  appendDecision(
    groupId,
    requirement.id,
    group.leadAgentId ?? "lead",
    `拆解为 ${subtaskIds.length} 个子任务：${subtaskIds.join(", ")}`,
  );
  setWorkspaceStatus(groupId, requirement.id, "in_progress");

  const doneMsg = `\n✓ 拆解完成：${subtaskIds.length} 个子任务\n${createdSubtasks.map((s, i) => `  ${i + 1}. ${s.title}`).join("\n")}\n`;
  guildEventBus.emit({ type: "agent_output", agentId: leadAgentId, taskId: requirement.id, content: doneMsg });
  logText(doneMsg);
  guildEventBus.emit({
    type: "agent_plan",
    agentId: leadAgentId,
    taskId: requirement.id,
    phase: "planner_done",
    payload: { subtaskIds, goal: parsed.goal },
  });
  logPlan("planner_done", { subtaskIds, goal: parsed.goal });
  finalizeExecutionLog(groupId, requirement.id, "completed");

  // Let the scheduler know there's new work
  for (const sub of createdSubtasks) {
    guildEventBus.emit({ type: "task_created", task: sub });
  }

  return { ok: true, subtaskIds, result: parsed, raw };
}

/** Utility exposed for testing / UI: re-resolve workspaceRef for a requirement. */
export function workspaceRefFor(groupId: string, parentTaskId: string): string {
  return getWorkspaceRef(groupId, parentTaskId);
}
