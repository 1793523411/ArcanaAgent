/**
 * AI-driven designers for Guild primitives.
 *
 * Two public entry points — each returns a "plan" (pure JSON, no side effects)
 * so the UI can preview before committing. Applying the plan is a separate
 * step in routes.ts that materializes agents, groups, and pipelines.
 */

import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { getLLM } from "../llm/index.js";
import { loadUserConfig } from "../config/userConfig.js";
import type { AgentAsset, GuildAgent } from "./types.js";
import type { PipelineTemplate } from "./pipelines.js";
import { listAgents, getAgent } from "./guildManager.js";
import { validateExpression, type Expression } from "./expression.js";
import { sanitizeAssertions } from "./verification.js";

// Hard caps on LLM-produced shape size. A misbehaving LLM or prompt injection
// must not be able to crash the process via deeply-nested branches or make the
// UI unusable with thousands of ghost steps.
const MAX_STEPS_PER_LEVEL = 50;
const MAX_NEST_DEPTH = 8;
const MAX_AGENTS_PER_PLAN = 20;

// ─── Shared types (plan shapes) ────────────────────────────────

export type AgentPlanItem =
  | {
      action: "reuse";
      /** Existing GuildAgent.id. */
      agentId: string;
      /** Short explanation why this agent fits. */
      reason?: string;
    }
  | {
      action: "create";
      spec: AgentSpec;
      reason?: string;
    }
  | {
      action: "fork";
      sourceAgentId: string;
      overrides: Partial<AgentSpec>;
      reason?: string;
    };

export interface AgentSpec {
  name: string;
  description: string;
  icon: string;
  color: string;
  systemPrompt: string;
  allowedTools: string[];
  assets?: Omit<AgentAsset, "id" | "addedAt">[];
}

export interface GroupPlan {
  group: {
    name: string;
    description: string;
    sharedContext?: string;
    artifactStrategy?: "isolated" | "collaborative";
  };
  agents: AgentPlanItem[];
  /** 0-based index into `agents` — which member should be lead. */
  leadIndex?: number;
  reasoning?: string;
}

/** Hard cap on user-supplied descriptions to cap prompt size and curb injection. */
const MAX_DESCRIPTION_LEN = 4000;
function clampDescription(s: string): string {
  return s.length > MAX_DESCRIPTION_LEN ? s.slice(0, MAX_DESCRIPTION_LEN) : s;
}

export interface PipelinePlan {
  template: PipelineTemplate;
  /** Agents the pipeline needs; suggestedAgentId in steps refers to planKey. */
  agents: (AgentPlanItem & { planKey: string })[];
  reasoning?: string;
}

// ─── LLM helpers ────────────────────────────────────────────────

/** Walk the string and collect every balanced {...} span. Quote-aware so
 *  braces inside strings don't throw off the depth counter. Used to salvage
 *  the intended JSON from LLM output that has chatter before/after, multiple
 *  blocks, or code fences interleaved with prose. */
// NOTE: the helpers below are exported so unit tests can exercise them
// directly. They are not part of the stable public API.
export function findBalancedJsonSpans(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "{") continue;
    let depth = 0;
    let inDouble = false;
    let inSingle = false;
    let escape = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (escape) { escape = false; continue; }
      if (c === "\\") { escape = true; continue; }
      // Track both quote flavours: strict JSON uses double, but LLM output
      // sometimes leaks Python-style single quotes. JSON.parse will still
      // reject single-quoted spans — we just need the depth tracker not to
      // treat braces inside a single-quoted string as structural.
      if (!inSingle && c === '"') { inDouble = !inDouble; continue; }
      if (!inDouble && c === "'") { inSingle = !inSingle; continue; }
      if (inDouble || inSingle) continue;
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          out.push(s.slice(i, j + 1));
          i = j; // skip past this span
          break;
        }
      }
    }
  }
  return out;
}

export function extractJson(content: string): unknown {
  const candidates: string[] = [];
  // 1) Code-fenced blocks (possibly multiple — grab all)
  for (const m of content.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    if (m[1]) candidates.push(m[1]);
  }
  // 2) Balanced {} spans, longest first (most likely to be the full plan)
  const balanced = findBalancedJsonSpans(content).sort((a, b) => b.length - a.length);
  candidates.push(...balanced);
  // 3) Last resort: whole content
  candidates.push(content);

  let lastErr: unknown;
  for (const c of candidates) {
    try {
      return JSON.parse(c.trim());
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error
    ? new Error(`LLM 输出无法解析为 JSON: ${lastErr.message}`)
    : new Error("LLM 输出无法解析为 JSON");
}

async function callLLM(
  systemPrompt: string,
  userInput: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const config = loadUserConfig();
  const llm = getLLM(config.modelId);
  const response = await llm.invoke(
    [new SystemMessage(systemPrompt), new HumanMessage(userInput)],
    { signal },
  );
  const content =
    typeof response.content === "string"
      ? response.content
      : Array.isArray(response.content)
        ? response.content
            .map((c) =>
              "type" in c && c.type === "text" && typeof c.text === "string" ? c.text : "",
            )
            .join("")
        : String(response.content);
  return extractJson(content);
}

// ─── Agent roster rendering (context for the LLM) ─────────────

function renderAgentRoster(agents: GuildAgent[]): string {
  if (agents.length === 0) return "(无现有 Agent — 全部需要新建)";
  return agents
    .map((a) => {
      const assets = a.assets.length > 0
        ? ` · 资产: ${a.assets.map((x) => `${x.type}:${x.name}`).join(", ")}`
        : "";
      return `- id=${a.id} | ${a.icon} ${a.name}: ${a.description}${assets}`;
    })
    .join("\n");
}

// ─── Group Plan ────────────────────────────────────────────────

const GROUP_PLAN_PROMPT = `你是 Guild 小组架构师。用户一句话描述目标，你要设计一个"小组蓝图"：
1. 小组基本信息（name / description / sharedContext / artifactStrategy）
2. 小组需要的成员 Agent 列表 — 每个成员三选一：
   - reuse: 复用现有 Agent（给出 agentId）
   - create: 全新创建（给出完整 spec）
   - fork: 基于现有 Agent 派生（给出 sourceAgentId 和要改的 overrides）
3. 指定 leadIndex（0-based，必须是 create/fork 的索引或 reuse 的索引）

artifactStrategy 选择规则：
- isolated：每个任务独立目录，任务之间不共享文件（默认，适合互不耦合）
- collaborative：共享目录 + manifest 追踪（适合多 Agent 接力产出同一份交付物，如写文章、做设计）

严格按以下 JSON 返回（不要额外文字，不要 markdown）：
{
  "group": {
    "name": "小组名(2-8字)",
    "description": "一句话描述小组目标",
    "sharedContext": "组内共享上下文/背景（可选，适合复杂项目背景）",
    "artifactStrategy": "isolated" 或 "collaborative"
  },
  "agents": [
    { "action": "reuse", "agentId": "agt_xxx", "reason": "为什么选它" },
    { "action": "create", "reason": "为什么要建",
      "spec": {
        "name": "名称",
        "description": "职责一句话",
        "icon": "emoji",
        "color": "#十六进制",
        "systemPrompt": "详细系统提示词(200-500字, 说明角色/能力边界/工作习惯)",
        "allowedTools": ["*"]  // 或具体工具名数组
      }
    },
    { "action": "fork", "sourceAgentId": "agt_xxx", "reason": "为什么派生",
      "overrides": { "name": "...", "systemPrompt": "...", "description": "..." }
    }
  ],
  "leadIndex": 0,
  "reasoning": "整体设计思路（简短）"
}

设计原则：
- 优先 reuse 已有 agent，只在现有不满足时才 create/fork
- fork 适用于"方向接近但需特化"的场景（如已有"前端专家"，fork 出"移动端前端专家"）
- 2-5 个 agent 为宜，避免冗余
- Lead 要选能统筹全局、拆任务能力强的
- 若用户明确提到某个仓库/文档/API 等资源，把它们加到相关 agent 的 assets 里

可用工具清单（allowedTools 从中选，或写 ["*"] 表示全部）：
- run_command, read_file, write_file, edit_file, search_code, list_files
- git_operations, test_runner, web_search, load_skill
- background_run, background_check, background_cancel
- project_index, project_search, project_snapshot`;

export async function generateGroupPlan(
  description: string,
  signal?: AbortSignal,
): Promise<GroupPlan> {
  const agents = listAgents();
  const roster = renderAgentRoster(agents);
  const userInput = `## 目标\n${clampDescription(description)}\n\n## 现有 Agent 池\n${roster}`;
  const raw = await callLLM(GROUP_PLAN_PROMPT, userInput, signal);
  return normalizeGroupPlan(raw);
}

export function normalizeGroupPlan(raw: unknown): GroupPlan {
  if (!raw || typeof raw !== "object") {
    throw new Error("LLM 返回的不是对象");
  }
  const r = raw as Record<string, unknown>;
  const g = (r.group ?? {}) as Record<string, unknown>;
  // Cap agents array so a runaway LLM can't flood the preview / DB.
  const rawAgents = Array.isArray(r.agents) ? r.agents.slice(0, MAX_AGENTS_PER_PLAN) : [];
  const strategy = String(g.artifactStrategy ?? "isolated");
  // Remap leadIndex when filtering drops invalid agent plan items. Without this,
  // the LLM's leadIndex could end up pointing to the wrong agent (or out of bounds).
  const kept: { item: AgentPlanItem; originalIdx: number }[] = [];
  rawAgents.forEach((a, originalIdx) => {
    const item = normalizeAgentPlan(a);
    if (item) kept.push({ item, originalIdx });
  });
  const rawLead = typeof r.leadIndex === "number" ? r.leadIndex : undefined;
  const newLeadIndex = rawLead !== undefined
    ? kept.findIndex((x) => x.originalIdx === rawLead)
    : -1;
  return {
    group: {
      name: String(g.name ?? "新小组"),
      description: String(g.description ?? ""),
      sharedContext: typeof g.sharedContext === "string" ? g.sharedContext : undefined,
      artifactStrategy: strategy === "collaborative" ? "collaborative" : "isolated",
    },
    agents: kept.map((x) => x.item),
    leadIndex: newLeadIndex >= 0 ? newLeadIndex : undefined,
    reasoning: typeof r.reasoning === "string" ? r.reasoning : undefined,
  };
}

function normalizeAgentPlan(raw: unknown): AgentPlanItem | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const action = String(a.action ?? "");
  const reason = typeof a.reason === "string" ? a.reason : undefined;
  if (action === "reuse") {
    if (typeof a.agentId !== "string") return null;
    // Sanity-check the id actually exists; if not, silently drop.
    if (!getAgent(a.agentId)) return null;
    return { action: "reuse", agentId: a.agentId, reason };
  }
  if (action === "fork") {
    if (typeof a.sourceAgentId !== "string") return null;
    if (!getAgent(a.sourceAgentId)) return null;
    const overrides = (a.overrides ?? {}) as Record<string, unknown>;
    return {
      action: "fork",
      sourceAgentId: a.sourceAgentId,
      overrides: normalizeSpec(overrides, true),
      reason,
    };
  }
  if (action === "create") {
    const spec = normalizeSpec((a.spec ?? {}) as Record<string, unknown>, false);
    if (!spec.name || !spec.systemPrompt) return null;
    return { action: "create", spec: spec as AgentSpec, reason };
  }
  return null;
}

// Hard caps on LLM-generated string fields so a misbehaving LLM (or prompt
// injection attack) can't balloon the agent profile on disk / in context.
const MAX_SPEC_NAME = 120;
const MAX_SPEC_DESCRIPTION = 2000;
const MAX_SPEC_SYSTEM_PROMPT = 10000;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

function normalizeSpec(raw: Record<string, unknown>, partial: boolean): AgentSpec | Partial<AgentSpec> {
  const out: Partial<AgentSpec> = {};
  if (typeof raw.name === "string") out.name = clip(raw.name, MAX_SPEC_NAME);
  if (typeof raw.description === "string") out.description = clip(raw.description, MAX_SPEC_DESCRIPTION);
  if (typeof raw.icon === "string") out.icon = raw.icon;
  // Restrict color to hex so a misbehaving LLM can't smuggle CSS expressions
  // (e.g. `red; background-image: url(...)`) through to the frontend style attr.
  if (typeof raw.color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(raw.color.trim())) {
    out.color = raw.color.trim();
  }
  if (typeof raw.systemPrompt === "string") out.systemPrompt = clip(raw.systemPrompt, MAX_SPEC_SYSTEM_PROMPT);
  if (Array.isArray(raw.allowedTools)) out.allowedTools = raw.allowedTools.map(String);
  if (Array.isArray(raw.assets)) {
    out.assets = raw.assets
      .map((x) => normalizeAsset(x))
      .filter((x): x is Omit<AgentAsset, "id" | "addedAt"> => x !== null);
  }
  if (!partial) {
    // Fill defaults for full create spec.
    return {
      name: out.name ?? "新 Agent",
      description: out.description ?? "",
      icon: out.icon ?? "🤖",
      color: out.color ?? "#3B82F6",
      systemPrompt: out.systemPrompt ?? "",
      allowedTools: out.allowedTools ?? ["*"],
      assets: out.assets,
    };
  }
  return out;
}

function normalizeAsset(x: unknown): Omit<AgentAsset, "id" | "addedAt"> | null {
  if (!x || typeof x !== "object") return null;
  const a = x as Record<string, unknown>;
  if (typeof a.name !== "string" || typeof a.uri !== "string") return null;
  const VALID: AgentAsset["type"][] = [
    "repo", "document", "api", "database", "prompt", "config", "mcp_server", "custom",
  ];
  const type = VALID.includes(a.type as AgentAsset["type"])
    ? (a.type as AgentAsset["type"])
    : "custom";
  return {
    type,
    name: a.name,
    uri: a.uri,
    description: typeof a.description === "string" ? a.description : undefined,
    tags: Array.isArray(a.tags)
      ? a.tags.filter((t): t is string => typeof t === "string")
      : undefined,
    metadata: sanitizeMetadata(a.metadata),
  };
}

/** Recursively strip prototype-pollution keys. LLM output reaches disk via
 *  JSON.stringify (safe) but also flows through in-memory spread/Object.assign
 *  paths that copy own `__proto__` keys — we strip at every depth, not just
 *  the top level, so `{nested: {__proto__: …}}` can't sneak through. */
export function deepSanitize(raw: unknown, depth = 0): unknown {
  if (depth > 12) return undefined; // guard against adversarial nesting
  if (raw === null || raw === undefined) return raw;
  if (typeof raw !== "object") return raw;
  if (Array.isArray(raw)) return raw.map((v) => deepSanitize(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    out[k] = deepSanitize(v, depth + 1);
  }
  return out;
}

function sanitizeMetadata(raw: unknown): Record<string, unknown> | undefined {
  const cleaned = deepSanitize(raw);
  if (!cleaned || typeof cleaned !== "object" || Array.isArray(cleaned)) return undefined;
  const obj = cleaned as Record<string, unknown>;
  return Object.keys(obj).length > 0 ? obj : undefined;
}

// ─── Pipeline Plan ─────────────────────────────────────────────

const PIPELINE_PLAN_PROMPT = `你是 Guild 流水线设计师。用户描述一个工作流，你要产出一份可直接落盘的 Pipeline 模板，
并规划每一步 Suggested Agent（复用现有 / 新建 / fork）。

Pipeline 模板的 schema（精简版）：
{
  "id": "小写短横线分隔(如 blog-writer, 不超过 32 字符)",
  "name": "模板显示名",
  "description": "一句话说明",
  "inputs": [
    { "name": "var_name", "label": "UI 显示名", "required": true, "default": "..." }
  ],
  "steps": [
    {
      "kind": "task",          // 或 "branch" / "foreach"
      "title": "步骤名(可用 \${var})",
      "description": "给 agent 的任务描述（详细，可用 \${var}）",
      "suggestedSkills": ["..."],     // 提示需要的技能
      "suggestedAgentId": "plan:K0",  // 引用下方 agents[i].planKey
      "acceptanceCriteria": "完成标准(可选, 供 agent 阅读)",
      "acceptanceAssertions": [        // 可选, 供 harness 机器校验
        { "type": "file_exists", "ref": "result.md" },
        { "type": "file_contains", "ref": "result.md", "pattern": "## 结论" }
      ],
      "dependsOn": [0, 1],            // 依赖前面 step 的下标
      "outputs": [
        { "ref": "result.md", "kind": "file", "label": "产物名", "isFinal": true }
      ]
    }
  ],
  "outputs": [   // 模板级最终产物
    { "ref": "final.md", "kind": "file", "label": "终稿" }
  ]
}

Agents plan — 每个 agent 有个 planKey（K0 / K1 / K2...），steps 的 suggestedAgentId 写 "plan:K0" 即可：
[
  { "planKey": "K0", "action": "reuse", "agentId": "agt_xxx", "reason": "..." },
  { "planKey": "K1", "action": "create", "spec": {...}, "reason": "..." },
  { "planKey": "K2", "action": "fork", "sourceAgentId": "agt_xxx", "overrides": {...}, "reason": "..." }
]

严格按以下 JSON 返回：
{
  "template": { ...上述 schema... },
  "agents": [ ...agent plan 数组... ],
  "reasoning": "整体设计思路（简短）"
}

设计原则：
- 步骤间依赖要形成 DAG（dependsOn 只能指向前面 step 的下标）
- 优先 reuse；只在必须时 create/fork
- 每个 agent 只分配给能发挥其专长的 step；同一个 agent 可用于多个 step
- inputs 是用户在创建任务时要填的变量（url / topic / filename 等）
- outputs 至少在有"最终产物"的 step 或模板级声明 1 条
- 步骤数 3-10 为宜，避免过度拆分或一步做太多
- 对有明确交付物的关键步骤，加 acceptanceAssertions（file_exists / file_contains），
  harness 会在 agent 声称完成后机器校验；这样即使 agent 只"口头说"完成，也不会放行`;

export async function generatePipelinePlan(
  description: string,
  signal?: AbortSignal,
): Promise<PipelinePlan> {
  const agents = listAgents();
  const roster = renderAgentRoster(agents);
  const userInput = `## 目标工作流\n${clampDescription(description)}\n\n## 现有 Agent 池\n${roster}`;
  const raw = await callLLM(PIPELINE_PLAN_PROMPT, userInput, signal);
  return normalizePipelinePlan(raw);
}

export function normalizePipelinePlan(raw: unknown): PipelinePlan {
  if (!raw || typeof raw !== "object") {
    throw new Error("LLM 返回的不是对象");
  }
  const r = raw as Record<string, unknown>;
  const agents = Array.isArray(r.agents) ? r.agents.slice(0, MAX_AGENTS_PER_PLAN) : [];
  const planned: (AgentPlanItem & { planKey: string })[] = [];
  for (const [i, a] of agents.entries()) {
    const norm = normalizeAgentPlan(a);
    if (!norm) continue;
    const planKey =
      (a as Record<string, unknown>).planKey && typeof (a as Record<string, unknown>).planKey === "string"
        ? String((a as Record<string, unknown>).planKey)
        : `K${i}`;
    planned.push({ ...norm, planKey });
  }
  const tplRaw = (r.template ?? {}) as Record<string, unknown>;
  const template: PipelineTemplate = {
    id: sanitizePipelineId(String(tplRaw.id ?? "ai-pipeline")),
    name: String(tplRaw.name ?? "AI 生成的模板"),
    description: typeof tplRaw.description === "string" ? tplRaw.description : undefined,
    inputs: normalizePipelineInputs(tplRaw.inputs),
    steps: normalizePipelineSteps(tplRaw.steps),
    outputs: Array.isArray(tplRaw.outputs) ? normalizeArtifactList(tplRaw.outputs) : undefined,
  };
  return {
    template,
    agents: planned,
    reasoning: typeof r.reasoning === "string" ? r.reasoning : undefined,
  };
}

function normalizePipelineInputs(raw: unknown): PipelineTemplate["inputs"] {
  if (!Array.isArray(raw)) return [];
  const out: NonNullable<PipelineTemplate["inputs"]> = [];
  for (const i of raw) {
    if (!i || typeof i !== "object") continue;
    const inp = i as Record<string, unknown>;
    if (typeof inp.name !== "string" || !inp.name.trim()) continue;
    out.push({
      name: inp.name,
      label: typeof inp.label === "string" ? inp.label : undefined,
      required: inp.required === true,
      default: typeof inp.default === "string" ? inp.default : undefined,
    });
  }
  return out;
}

function normalizePipelineSteps(raw: unknown, depth = 0): PipelineTemplate["steps"] {
  if (!Array.isArray(raw)) return [];
  if (depth > MAX_NEST_DEPTH) return []; // cut off adversarial nesting
  // Cap the array so a runaway LLM can't inflate the preview / template file.
  const limited = raw.slice(0, MAX_STEPS_PER_LEVEL);
  // First pass: normalize each step, tracking raw→output index remap so we can
  // fix up dependsOn references after invalid steps are dropped (otherwise the
  // filter inside normalizeStep leaves dangling indices pointing to the wrong
  // siblings).
  const out: PipelineTemplate["steps"] = [];
  const rawToOut = new Map<number, number>();
  limited.forEach((s, idx) => {
    const norm = normalizeStep(s, idx, depth);
    if (norm) {
      rawToOut.set(idx, out.length);
      out.push(norm);
    }
  });
  for (const step of out) {
    const anyStep = step as { dependsOn?: number[] };
    if (Array.isArray(anyStep.dependsOn)) {
      anyStep.dependsOn = anyStep.dependsOn
        .map((d) => rawToOut.get(d))
        .filter((d): d is number => typeof d === "number");
    }
  }
  return out;
}

function normalizeStep(
  raw: unknown,
  siblingIndex = 0,
  depth = 0,
): PipelineTemplate["steps"][number] | null {
  if (!raw || typeof raw !== "object") return null;
  if (depth > MAX_NEST_DEPTH) return null; // refuse to recurse further
  const s = raw as Record<string, unknown>;
  const kind = s.kind === "branch" || s.kind === "foreach" ? s.kind : "task";
  const rawTitle = typeof s.title === "string" ? s.title : "";
  // Downstream validatePipeline would reject blank-titled task steps anyway;
  // drop them here so the preview doesn't show ghost rows.
  if (kind === "task" && !rawTitle.trim()) return null;
  const step: Record<string, unknown> = {
    kind,
    title: rawTitle,
    description: typeof s.description === "string" ? s.description : "",
  };
  if (Array.isArray(s.dependsOn)) {
    // Only accept indices that point to an earlier sibling (strictly less than
    // this step's index). Self-refs and forward refs are dropped.
    step.dependsOn = s.dependsOn.filter(
      (n): n is number =>
        typeof n === "number" && Number.isInteger(n) && n >= 0 && n < siblingIndex,
    );
  }
  if (Array.isArray(s.suggestedSkills)) {
    step.suggestedSkills = s.suggestedSkills.filter((x): x is string => typeof x === "string");
  }
  if (typeof s.suggestedAgentId === "string") step.suggestedAgentId = s.suggestedAgentId;
  if (typeof s.acceptanceCriteria === "string") step.acceptanceCriteria = s.acceptanceCriteria;
  // Structured assertions: shape-validate via the canonical sanitizer so the
  // ReDoS heuristic is enforced identically here, in routes.ts (POST /tasks),
  // and at completion-time runtime. The sanitizer drops malformed entries and
  // any regex pattern that would trip the ReDoS guard.
  const cleanedAssertions = sanitizeAssertions(s.acceptanceAssertions);
  if (cleanedAssertions) step.acceptanceAssertions = cleanedAssertions;
  if (s.priority === "low" || s.priority === "medium" || s.priority === "high" || s.priority === "urgent") {
    step.priority = s.priority;
  }
  if (Array.isArray(s.outputs)) step.outputs = normalizeArtifactList(s.outputs);
  if (kind === "branch") {
    // Sanitize + structurally validate `when` before we persist it. Without
    // this, the LLM could bake __proto__ keys into the expression tree, or an
    // invalid operator that blows up evaluate() at pipeline-expansion time.
    if (s.when && typeof s.when === "object" && !Array.isArray(s.when)) {
      const cleaned = deepSanitize(s.when);
      if (cleaned && typeof cleaned === "object" && !Array.isArray(cleaned)) {
        if (validateExpression(cleaned as Expression).length === 0) {
          step.when = cleaned;
        }
      }
    }
    if (Array.isArray(s.then)) step.then = normalizePipelineSteps(s.then, depth + 1);
    if (Array.isArray(s.else)) step.else = normalizePipelineSteps(s.else, depth + 1);
  }
  if (kind === "foreach") {
    if (typeof s.items === "string") step.items = s.items;
    if (typeof s.as === "string") step.as = s.as;
    if (Array.isArray(s.body)) step.body = normalizePipelineSteps(s.body, depth + 1);
    const join = normalizeStep(s.join, 0, depth + 1);
    if (join) step.join = join;
  }
  if (s.retry && typeof s.retry === "object") {
    const r = s.retry as Record<string, unknown>;
    if (typeof r.max === "number") {
      const retry: Record<string, unknown> = { max: r.max };
      if (typeof r.backoffMs === "number") retry.backoffMs = r.backoffMs;
      if (r.onExhausted === "fail" || r.onExhausted === "skip" || r.onExhausted === "fallback") {
        retry.onExhausted = r.onExhausted;
      }
      if (r.preferSameAgent === true) retry.preferSameAgent = true;
      const fb = normalizeStep(r.fallback, 0, depth + 1);
      if (fb) retry.fallback = fb;
      step.retry = retry;
    }
  }
  return step as unknown as PipelineTemplate["steps"][number];
}

function normalizeArtifactList(raw: unknown[]): Array<{ ref: string; label?: string; kind?: "file" | "url" | "data" | "commit"; description?: string; isFinal?: boolean }> {
  const out: Array<{ ref: string; label?: string; kind?: "file" | "url" | "data" | "commit"; description?: string; isFinal?: boolean }> = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") continue;
    const o = a as Record<string, unknown>;
    if (typeof o.ref !== "string" || !o.ref.trim()) continue;
    const artifact: { ref: string; label?: string; kind?: "file" | "url" | "data" | "commit"; description?: string; isFinal?: boolean } = {
      ref: o.ref,
    };
    if (typeof o.label === "string") artifact.label = o.label;
    if (o.kind === "file" || o.kind === "url" || o.kind === "data" || o.kind === "commit") artifact.kind = o.kind;
    if (typeof o.description === "string") artifact.description = o.description;
    if (o.isFinal === true) artifact.isFinal = true;
    out.push(artifact);
  }
  return out;
}

function sanitizePipelineId(s: string): string {
  const out = s.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
  return out.length > 0 ? out.slice(0, 32) : "ai-pipeline";
}
