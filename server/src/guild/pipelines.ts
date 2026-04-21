import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join, resolve } from "path";
import type { GuildTask, CreateTaskParams, TaskPriority, TaskRetryPolicy } from "./types.js";
import { evaluate, validateExpression, type Expression } from "./expression.js";
import { createTask, updateTask, getSubtasks } from "./taskBoard.js";
import {
  createWorkspace,
  updatePlanSection,
  updateScopeSection,
  appendDecision,
  setWorkspaceStatus,
} from "./workspace.js";
import { getGroup } from "./guildManager.js";
import { guildEventBus } from "./eventBus.js";
import { serverLogger } from "../lib/logger.js";

/**
 * Fixed pipeline templates — an alternative to the LLM-driven Planner for
 * workflows whose decomposition is always the same ("永远这样"). A template
 * declares an ordered list of subtask specs with DAG edges; creating a
 * `kind: "pipeline"` task expands the template into real subtasks without
 * any LLM call, handing them off to the normal bidding/scheduling path.
 */

export interface PipelineInputSpec {
  name: string;
  label?: string;
  required?: boolean;
  default?: string;
}

export interface PipelineRetryPolicy {
  max: number;
  backoffMs?: number;
  onExhausted?: "fail" | "fallback" | "skip";
  preferSameAgent?: boolean;
  /** Fallback step spec — created as a replacement task when retries exhaust. */
  fallback?: PipelineStepSpec;
}

export type PipelineStepKind = "task" | "branch" | "foreach";

export interface PipelineStepSpec {
  /** Defaults to "task". Branch steps declare when/then/else and produce no task themselves. */
  kind?: PipelineStepKind;
  title: string;
  description: string;
  suggestedSkills?: string[];
  suggestedAgentId?: string;
  dependsOn?: number[];
  priority?: TaskPriority;
  acceptanceCriteria?: string;
  retry?: PipelineRetryPolicy;
  /** Branch-only: predicate evaluated against inputs at expansion time. */
  when?: Expression;
  /** Branch-only: steps expanded when `when` is true. */
  then?: PipelineStepSpec[];
  /** Branch-only: steps expanded when `when` is false. */
  else?: PipelineStepSpec[];
  /** foreach-only: ${input} whose value is a JSON array or comma-separated string. */
  items?: string;
  /** foreach-only: iteration variable name referenced inside body via ${name}. */
  as?: string;
  /** foreach-only: body template cloned for each item. */
  body?: PipelineStepSpec[];
  /** foreach-only: optional single step that runs after all iterations complete. */
  join?: PipelineStepSpec;
}

export interface PipelineTemplate {
  id: string;
  name: string;
  description?: string;
  inputs?: PipelineInputSpec[];
  steps: PipelineStepSpec[];
}

export interface ExpandPipelineOutcome {
  ok: boolean;
  subtaskIds?: string[];
  reason?: string;
}

const DATA_DIR = resolve(process.env.DATA_DIR ?? join(process.cwd(), "data"));
const PIPELINES_DIR = join(DATA_DIR, "guild", "pipelines");

// ─── Loader ───────────────────────────────────────────────────

function isTemplate(x: unknown): x is PipelineTemplate {
  if (!x || typeof x !== "object") return false;
  const t = x as Record<string, unknown>;
  return typeof t.id === "string" && typeof t.name === "string" && Array.isArray(t.steps);
}

export function listPipelines(): PipelineTemplate[] {
  if (!existsSync(PIPELINES_DIR)) return [];
  const files = readdirSync(PIPELINES_DIR).filter((f) => f.endsWith(".json"));
  const out: PipelineTemplate[] = [];
  for (const f of files) {
    try {
      const raw = readFileSync(join(PIPELINES_DIR, f), "utf-8");
      const parsed = JSON.parse(raw);
      if (isTemplate(parsed)) out.push(parsed);
      else serverLogger.warn("[pipelines] skipping malformed template", { file: f });
    } catch (e) {
      serverLogger.warn("[pipelines] failed to read template", { file: f, error: String(e) });
    }
  }
  return out;
}

export function getPipeline(id: string): PipelineTemplate | null {
  return listPipelines().find((p) => p.id === id) ?? null;
}

// ─── Mutations ────────────────────────────────────────────────

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface PipelineValidationError {
  path: string;
  message: string;
}

/**
 * Shallow validation: id format, no duplicate names, dependsOn indices in
 * range and non-self-referential, step titles present. Returns a list of
 * errors (empty array means valid).
 */
export function validatePipeline(tpl: PipelineTemplate): PipelineValidationError[] {
  const errs: PipelineValidationError[] = [];
  if (!tpl || typeof tpl !== "object") {
    return [{ path: "", message: "body 不是有效的 JSON 对象" }];
  }
  if (typeof tpl.id !== "string" || !ID_PATTERN.test(tpl.id)) {
    errs.push({ path: "id", message: "id 必须是小写字母数字开头，仅包含 a-z0-9_-（最长 64）" });
  }
  if (!tpl.name || tpl.name.trim() === "") errs.push({ path: "name", message: "name 不能为空" });
  if (!Array.isArray(tpl.steps) || tpl.steps.length === 0) {
    errs.push({ path: "steps", message: "至少需要一个 step" });
    return errs;
  }
  // Reserved context keys injected by expandPipeline — always available
  // alongside user-declared inputs.
  const RESERVED_CTX = ["parent_id", "parent_title", "parent_priority"] as const;
  const inputNames = new Set<string>([
    ...(tpl.inputs ?? []).map((i) => i.name),
    ...RESERVED_CTX,
  ]);
  for (const [i, inp] of (tpl.inputs ?? []).entries()) {
    if (!inp.name || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(inp.name)) {
      errs.push({ path: `inputs[${i}].name`, message: "input name 必须是合法标识符" });
    }
  }
  const validateSteps = (steps: PipelineStepSpec[], pathPrefix: string): void => {
    for (const [i, step] of steps.entries()) {
      const kind: PipelineStepKind = step.kind ?? "task";
      const base = `${pathPrefix}[${i}]`;
      if (kind === "task") {
        if (!step.title || step.title.trim() === "") {
          errs.push({ path: `${base}.title`, message: "title 不能为空" });
        }
      } else if (kind === "branch") {
        if (!step.when) {
          errs.push({ path: `${base}.when`, message: "branch 必须提供 when 表达式" });
        } else {
          for (const msg of validateExpression(step.when, `${base}.when`)) {
            errs.push({ path: `${base}.when`, message: msg });
          }
        }
        const hasThen = Array.isArray(step.then) && step.then.length > 0;
        const hasElse = Array.isArray(step.else) && step.else.length > 0;
        if (!hasThen && !hasElse) {
          errs.push({ path: `${base}`, message: "branch 必须提供 then 或 else 中至少一个" });
        }
        if (hasThen) validateSteps(step.then!, `${base}.then`);
        if (hasElse) validateSteps(step.else!, `${base}.else`);
      } else if (kind === "foreach") {
        if (!step.items || typeof step.items !== "string") {
          errs.push({ path: `${base}.items`, message: "foreach 必须提供 items（${var} 或字面量字符串）" });
        }
        if (!step.as || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(step.as)) {
          errs.push({ path: `${base}.as`, message: "foreach 必须提供合法标识符 as" });
        }
        if (!Array.isArray(step.body) || step.body.length === 0) {
          errs.push({ path: `${base}.body`, message: "foreach 必须提供非空 body" });
        } else {
          validateSteps(step.body, `${base}.body`);
        }
        if (step.join) validateSteps([step.join], `${base}.join`);
      } else {
        errs.push({ path: `${base}.kind`, message: `未知的 step kind: ${kind}` });
      }
      // dependsOn still bounds against the current-level preceding siblings.
      for (const [j, dep] of (step.dependsOn ?? []).entries()) {
        if (typeof dep !== "number" || dep < 0 || dep >= i) {
          errs.push({
            path: `${base}.dependsOn[${j}]`,
            message: `dependsOn 下标必须指向前面的 step（0..${i - 1}）`,
          });
        }
      }
      if (step.retry) {
        const r = step.retry;
        if (typeof r.max !== "number" || r.max < 1 || r.max > 10 || !Number.isInteger(r.max)) {
          errs.push({ path: `${base}.retry.max`, message: "retry.max 必须是 1-10 之间的整数" });
        }
        if (r.backoffMs !== undefined && (typeof r.backoffMs !== "number" || r.backoffMs < 0 || r.backoffMs > 600000)) {
          errs.push({ path: `${base}.retry.backoffMs`, message: "retry.backoffMs 必须是 0-600000（10分钟）之间的数字" });
        }
        if (r.onExhausted && !["fail", "fallback", "skip"].includes(r.onExhausted)) {
          errs.push({ path: `${base}.retry.onExhausted`, message: "onExhausted 必须是 fail/fallback/skip" });
        }
        if (r.onExhausted === "fallback" && !r.fallback) {
          errs.push({ path: `${base}.retry.fallback`, message: "onExhausted=fallback 时必须提供 fallback step" });
        }
        if (r.fallback && (!r.fallback.title || r.fallback.title.trim() === "")) {
          errs.push({ path: `${base}.retry.fallback.title`, message: "fallback.title 不能为空" });
        }
      }
    }
  };
  validateSteps(tpl.steps, "steps");
  // Reference ${var} that isn't declared in inputs — hard error, deduplicated.
  const undeclared = new Set<string>();
  const interpolate = (s: string | undefined, scope: Set<string>) => {
    if (!s) return;
    for (const m of s.matchAll(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g)) {
      if (!scope.has(m[1])) undeclared.add(m[1]);
    }
  };
  const walkStrings = (steps: PipelineStepSpec[], scope: Set<string>): void => {
    for (const step of steps) {
      interpolate(step.title, scope);
      interpolate(step.description, scope);
      interpolate(step.acceptanceCriteria, scope);
      if (step.retry?.fallback) {
        interpolate(step.retry.fallback.title, scope);
        interpolate(step.retry.fallback.description, scope);
        interpolate(step.retry.fallback.acceptanceCriteria, scope);
      }
      if (step.then) walkStrings(step.then, scope);
      if (step.else) walkStrings(step.else, scope);
      if (step.body) {
        // Inside foreach body, the loop variable is in scope.
        const inner = step.as ? new Set([...scope, step.as]) : scope;
        interpolate(step.items, scope); // items resolves against OUTER scope
        walkStrings(step.body, inner);
        if (step.join) walkStrings([step.join], inner);
      }
    }
  };
  walkStrings(tpl.steps, inputNames);
  for (const name of undeclared) {
    errs.push({ path: "steps", message: `引用了未声明的 input: \${${name}}` });
  }
  return errs;
}

function ensurePipelinesDir(): void {
  if (!existsSync(PIPELINES_DIR)) mkdirSync(PIPELINES_DIR, { recursive: true });
}

function templatePath(id: string): string {
  return join(PIPELINES_DIR, `${id}.json`);
}

export interface SavePipelineOutcome {
  ok: boolean;
  template?: PipelineTemplate;
  errors?: PipelineValidationError[];
  reason?: string;
}

/**
 * Create or overwrite a template. When `expectedId` is provided the caller
 * wants a PUT-style update and the body id must match; otherwise the body id
 * is used as-is.
 */
export function savePipeline(
  tpl: PipelineTemplate,
  opts: { expectedId?: string; allowOverwrite?: boolean } = {},
): SavePipelineOutcome {
  const errors = validatePipeline(tpl);
  if (errors.length > 0) return { ok: false, errors, reason: "validation failed" };
  if (opts.expectedId && opts.expectedId !== tpl.id) {
    return { ok: false, reason: `id mismatch: route=${opts.expectedId} body=${tpl.id}` };
  }
  ensurePipelinesDir();
  const path = templatePath(tpl.id);
  if (!opts.allowOverwrite && !opts.expectedId && existsSync(path)) {
    return { ok: false, reason: `template "${tpl.id}" already exists` };
  }
  writeFileSync(path, JSON.stringify(tpl, null, 2));
  return { ok: true, template: tpl };
}

export function deletePipeline(id: string): boolean {
  const path = templatePath(id);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

// ─── Variable substitution ────────────────────────────────────

/** Replace ${name} tokens using the provided inputs; unknown vars stay literal. */
export function substituteVars(str: string, inputs: Record<string, string>): string {
  return str.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(inputs, name) ? inputs[name] : match,
  );
}

/** Validate required inputs; returns the list of missing input names. */
export function validateInputs(
  template: PipelineTemplate,
  inputs: Record<string, string>,
): string[] {
  const missing: string[] = [];
  for (const spec of template.inputs ?? []) {
    if (!spec.required) continue;
    const v = inputs[spec.name];
    if (v === undefined || v === null || String(v).trim() === "") missing.push(spec.name);
  }
  return missing;
}

/** Merge defaults for unspecified inputs. */
export function withDefaults(
  template: PipelineTemplate,
  inputs: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = { ...inputs };
  for (const spec of template.inputs ?? []) {
    if (merged[spec.name] === undefined && spec.default !== undefined) {
      merged[spec.name] = spec.default;
    }
  }
  return merged;
}

/**
 * Convert a pipeline-level retry spec into the runtime TaskRetryPolicy shape,
 * substituting ${vars} in fallback fields so the task owner doesn't have to.
 */
function materializeRetryPolicy(
  r: PipelineRetryPolicy,
  inputs: Record<string, string>,
): TaskRetryPolicy {
  return {
    max: r.max,
    backoffMs: r.backoffMs,
    onExhausted: r.onExhausted,
    preferSameAgent: r.preferSameAgent,
    fallback: r.fallback
      ? {
          title: substituteVars(r.fallback.title, inputs),
          description: substituteVars(r.fallback.description, inputs),
          suggestedSkills: r.fallback.suggestedSkills,
          suggestedAgentId: r.fallback.suggestedAgentId,
          acceptanceCriteria: r.fallback.acceptanceCriteria
            ? substituteVars(r.fallback.acceptanceCriteria, inputs)
            : undefined,
        }
      : undefined,
  };
}

// ─── Expansion ────────────────────────────────────────────────

interface FlatStep {
  step: PipelineStepSpec;
  /** Flat (post-flatten) indices of preceding steps this one depends on. */
  deps: number[];
}

export interface BranchDecision {
  label: string;
  taken: "then" | "else" | "empty" | string;
}

/** Resolve foreach items — accepts ${var} ref to an input, or a literal string. */
function resolveForeachItems(raw: string, inputs: Record<string, string>): string[] {
  const trimmed = raw.trim();
  const whole = trimmed.match(/^\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}$/);
  const source = whole ? inputs[whole[1]] ?? "" : substituteVars(trimmed, inputs);
  if (!source) return [];
  const s = source.trim();
  if (s.startsWith("[")) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) {
        return parsed.map((x) => (typeof x === "string" ? x : JSON.stringify(x)));
      }
    } catch {
      /* fall through to CSV */
    }
  }
  return s.split(",").map((p) => p.trim()).filter(Boolean);
}

/** Deep-clone a step spec with ${as} → item substitution applied to string fields. */
function substituteStepVar(step: PipelineStepSpec, varName: string, value: string): PipelineStepSpec {
  const sub = (s?: string) => (s === undefined ? s : substituteVars(s, { [varName]: value }));
  const out: PipelineStepSpec = {
    ...step,
    title: substituteVars(step.title, { [varName]: value }),
    description: substituteVars(step.description, { [varName]: value }),
    acceptanceCriteria: sub(step.acceptanceCriteria),
  };
  if (step.then) out.then = step.then.map((s) => substituteStepVar(s, varName, value));
  if (step.else) out.else = step.else.map((s) => substituteStepVar(s, varName, value));
  if (step.body) out.body = step.body.map((s) => substituteStepVar(s, varName, value));
  if (step.join) out.join = substituteStepVar(step.join, varName, value);
  if (step.retry?.fallback) {
    out.retry = {
      ...step.retry,
      fallback: substituteStepVar(step.retry.fallback, varName, value),
    };
  }
  return out;
}

/**
 * Compile-time branch resolver: walks the step tree, evaluates `when`
 * against inputs at expansion time, and emits a flat task list preserving
 * dependency semantics. A branch step's "index" in the outer list maps to
 * the LAST flattened step of the chosen side, so downstream `dependsOn`
 * referencing the branch still resolves correctly.
 *
 * Limitation: only pipeline inputs are available to `when` here. Runtime
 * branching on upstream structuredOutput needs the scheduler-driven
 * advancePipeline path (not yet implemented).
 */
function flattenSteps(
  steps: PipelineStepSpec[],
  inputs: Record<string, string>,
  decisions: BranchDecision[],
  locals: Record<string, string> = {},
): FlatStep[] {
  const ctx = { ...inputs, ...locals };
  const out: FlatStep[] = [];
  const outerToLastFlat = new Map<number, number>();
  steps.forEach((step, outerIdx) => {
    const outerDeps = (step.dependsOn ?? [])
      .map((d) => outerToLastFlat.get(d))
      .filter((x): x is number => typeof x === "number");
    const kind = step.kind ?? "task";
    if (kind === "task") {
      out.push({ step, deps: outerDeps });
      outerToLastFlat.set(outerIdx, out.length - 1);
    } else if (kind === "foreach") {
      const items = resolveForeachItems(step.items ?? "", ctx);
      if (items.length === 0) {
        decisions.push({ label: step.title || `foreach#${outerIdx}`, taken: "empty" });
        return;
      }
      decisions.push({ label: step.title || `foreach#${outerIdx}`, taken: `×${items.length}` });
      const iterLastIndices: number[] = [];
      for (const item of items) {
        const bodySteps = (step.body ?? []).map((s) => substituteStepVar(s, step.as!, item));
        const subFlat = flattenSteps(bodySteps, inputs, decisions, { ...locals, [step.as!]: item });
        if (subFlat.length === 0) continue;
        const offset = out.length;
        subFlat.forEach((fs, i) => {
          const globalDeps = fs.deps.map((d) => d + offset);
          if (i === 0 && outerDeps.length > 0) {
            out.push({ step: fs.step, deps: [...globalDeps, ...outerDeps] });
          } else {
            out.push({ step: fs.step, deps: globalDeps });
          }
        });
        iterLastIndices.push(out.length - 1);
      }
      if (step.join && iterLastIndices.length > 0) {
        out.push({ step: step.join, deps: iterLastIndices });
        outerToLastFlat.set(outerIdx, out.length - 1);
      } else if (iterLastIndices.length > 0) {
        // Without a join node, downstream references to this outer idx fan out
        // to the last iteration — adequate for the common "run all then
        // continue" shape. For true joins, authors should declare `join`.
        outerToLastFlat.set(outerIdx, iterLastIndices[iterLastIndices.length - 1]);
      }
    } else {
      // branch — evaluate at expansion time.
      let result = false;
      try {
        result = evaluate(step.when, ctx);
      } catch {
        result = false;
      }
      const chosen = result ? step.then ?? [] : step.else ?? [];
      if (chosen.length === 0) {
        decisions.push({ label: step.title || `branch#${outerIdx}`, taken: "empty" });
        // No node produced; outerToLastFlat intentionally left unset so
        // downstream deps referencing this branch simply drop the missing link.
        return;
      }
      decisions.push({ label: step.title || `branch#${outerIdx}`, taken: result ? "then" : "else" });
      const subFlat = flattenSteps(chosen, inputs, decisions, locals);
      const offset = out.length;
      subFlat.forEach((fs, i) => {
        const globalDeps = fs.deps.map((d) => d + offset);
        if (i === 0 && outerDeps.length > 0) {
          out.push({ step: fs.step, deps: [...globalDeps, ...outerDeps] });
        } else {
          out.push({ step: fs.step, deps: globalDeps });
        }
      });
      outerToLastFlat.set(outerIdx, out.length - 1);
    }
  });
  return out;
}

function renderPlanTable(subtasks: GuildTask[]): string {
  if (subtasks.length === 0) return "_No subtasks._";
  const header = "| ID | Title | Owner | Depends | Status | Acceptance |";
  const divider = "|----|-------|-------|---------|--------|------------|";
  const rows = subtasks.map((t) => {
    const owner = t.suggestedAgentId ?? t.assignedAgentId ?? "—";
    const deps = (t.dependsOn ?? []).join(", ") || "—";
    const acc = (t.acceptanceCriteria ?? "—").replace(/\|/g, "\\|").slice(0, 80);
    const title = t.title.replace(/\|/g, "\\|");
    return `| \`${t.id}\` | ${title} | ${owner} | ${deps.replace(/\|/g, "\\|")} | ${t.status} | ${acc} |`;
  });
  return [header, divider, ...rows].join("\n");
}

function renderScopeMd(template: PipelineTemplate, inputs: Record<string, string>): string {
  const lines: string[] = [];
  lines.push(`- **Template**: \`${template.id}\` — ${template.name}`);
  if (template.description) lines.push(`- **Description**: ${template.description}`);
  const inputKeys = Object.keys(inputs);
  if (inputKeys.length > 0) {
    lines.push(`- **Inputs**:`);
    for (const k of inputKeys) lines.push(`  - \`${k}\`: ${inputs[k]}`);
  }
  return lines.join("\n");
}

/**
 * Expand a template into concrete subtasks under a pipeline-kind parent.
 * Idempotent: if the parent already has subtasks, returns early.
 */
export function expandPipeline(
  groupId: string,
  parent: GuildTask,
  template: PipelineTemplate,
  rawInputs: Record<string, string>,
): ExpandPipelineOutcome {
  const group = getGroup(groupId);
  if (!group) return { ok: false, reason: "Group not found" };
  if (parent.kind !== "pipeline") return { ok: false, reason: "Parent must be kind=pipeline" };

  const existing = getSubtasks(groupId, parent.id);
  if (existing.length > 0) {
    return { ok: true, subtaskIds: existing.map((t) => t.id), reason: "Already expanded" };
  }

  if (!Array.isArray(template.steps) || template.steps.length === 0) {
    return { ok: false, reason: "Template has no steps" };
  }
  const mergedInputs = withDefaults(template, rawInputs);
  const missing = validateInputs(template, mergedInputs);
  if (missing.length > 0) {
    return { ok: false, reason: `Missing required inputs: ${missing.join(", ")}` };
  }
  const userInputs = mergedInputs;
  // Enrich context with parent task metadata so `when`/`items`/text
  // substitution can reference `${parent_priority}`, `${parent_title}`,
  // `${parent_id}`. Prefixed to avoid collisions with user-declared inputs.
  const inputs: Record<string, string> = {
    ...userInputs,
    parent_id: parent.id,
    parent_title: parent.title,
    parent_priority: parent.priority,
  };

  // Workspace up-front so the plan table has somewhere to live.
  const workspaceRef = createWorkspace(
    groupId,
    parent.id,
    parent.title,
    parent.description,
    group.leadAgentId ?? "pipeline",
  );
  updateTask(groupId, parent.id, { workspaceRef });

  const decisions: BranchDecision[] = [];
  const flat = flattenSteps(template.steps, inputs, decisions);

  if (flat.length === 0) {
    return { ok: false, reason: "Pipeline expanded to zero steps (all branches empty?)" };
  }

  const created: GuildTask[] = [];
  const idByFlatIndex = new Map<number, string>();
  flat.forEach((fs, i) => {
    const step = fs.step;
    const depIds = fs.deps
      .map((idx) => idByFlatIndex.get(idx))
      .filter((x): x is string => !!x);
    const params: CreateTaskParams = {
      title: substituteVars(step.title, inputs),
      description: substituteVars(step.description, inputs),
      kind: "subtask",
      priority: step.priority ?? parent.priority,
      parentTaskId: parent.id,
      suggestedSkills: step.suggestedSkills,
      suggestedAgentId: step.suggestedAgentId,
      acceptanceCriteria: step.acceptanceCriteria
        ? substituteVars(step.acceptanceCriteria, inputs)
        : undefined,
      workspaceRef,
      dependsOn: depIds,
      createdBy: `pipeline:${template.id}`,
      retryPolicy: step.retry ? materializeRetryPolicy(step.retry, inputs) : undefined,
    };
    const sub = createTask(groupId, params);
    created.push(sub);
    idByFlatIndex.set(i, sub.id);
  });

  const subtaskIds = created.map((t) => t.id);
  // Move the pipeline parent into in_progress so the UI renders it in the
  // same column as its running children. Leaving it in "open" caused the
  // parent group header to orphan in 待处理 while subtasks showed as a
  // ghost-req group in 进行中 — users read that as "一个独立于需求之外的任务".
  updateTask(groupId, parent.id, {
    status: "in_progress",
    startedAt: new Date().toISOString(),
    subtaskIds,
  });

  updatePlanSection(groupId, parent.id, renderPlanTable(created));
  updateScopeSection(groupId, parent.id, renderScopeMd(template, inputs));
  appendDecision(
    groupId,
    parent.id,
    `pipeline:${template.id}`,
    `按模板 "${template.name}" 展开 ${subtaskIds.length} 个子任务：${subtaskIds.join(", ")}`,
  );
  for (const d of decisions) {
    appendDecision(
      groupId,
      parent.id,
      `pipeline:${template.id}`,
      `Branch "${d.label}" → ${d.taken}`,
    );
  }
  setWorkspaceStatus(groupId, parent.id, "in_progress");

  for (const sub of created) {
    guildEventBus.emit({ type: "task_created", task: sub });
  }

  return { ok: true, subtaskIds };
}
