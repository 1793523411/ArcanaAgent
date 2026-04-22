import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join, resolve, basename } from "path";
import type {
  GuildTask,
  CreateTaskParams,
  TaskPriority,
  TaskRetryPolicy,
  TaskDeclaredOutput,
  TaskHandoffArtifact,
} from "./types.js";
import { evaluate, validateExpression, type Expression } from "./expression.js";
import { createTask, updateTask, getSubtasks } from "./taskBoard.js";
import {
  createWorkspace,
  updatePlanSection,
  updateScopeSection,
  updateDeliverablesSection,
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

export type PipelineArtifactKind = "file" | "url" | "data" | "commit";

/**
 * Named deliverable produced by a step (or declared at template level as
 * the pipeline's overall output). Supports `${var}` substitution in every
 * string field so authors can parameterize filenames (e.g. `${slug}.md`).
 */
export interface PipelineArtifactSpec {
  ref: string;
  label?: string;
  kind?: PipelineArtifactKind;
  description?: string;
  /** Elevates this artifact to the pipeline's "final deliverable" list —
   *  surfaced prominently in the workspace Deliverables table and on the
   *  pipeline parent's `declaredOutputs`. */
  isFinal?: boolean;
}

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
  /** Structured deliverables this step is expected to produce. */
  outputs?: PipelineArtifactSpec[];
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
  /** Pipeline-level final deliverables. Automatically treated as `isFinal: true`. */
  outputs?: PipelineArtifactSpec[];
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
  const ARTIFACT_KINDS: PipelineArtifactKind[] = ["file", "url", "data", "commit"];
  const validateArtifacts = (
    arts: PipelineArtifactSpec[] | undefined,
    pathPrefix: string,
  ): void => {
    if (!arts) return;
    for (const [j, a] of arts.entries()) {
      const base = `${pathPrefix}[${j}]`;
      if (!a.ref || typeof a.ref !== "string" || a.ref.trim() === "") {
        errs.push({ path: `${base}.ref`, message: "ref 不能为空" });
      }
      if (a.kind && !ARTIFACT_KINDS.includes(a.kind)) {
        errs.push({
          path: `${base}.kind`,
          message: `kind 必须是 ${ARTIFACT_KINDS.join("/")}`,
        });
      }
    }
  };
  validateArtifacts(tpl.outputs, "outputs");

  const validateSteps = (steps: PipelineStepSpec[], pathPrefix: string): void => {
    for (const [i, step] of steps.entries()) {
      const kind: PipelineStepKind = step.kind ?? "task";
      const base = `${pathPrefix}[${i}]`;
      validateArtifacts(step.outputs, `${base}.outputs`);
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
  const walkArtifactStrings = (arts: PipelineArtifactSpec[] | undefined, scope: Set<string>) => {
    if (!arts) return;
    for (const a of arts) {
      interpolate(a.ref, scope);
      interpolate(a.label, scope);
      interpolate(a.description, scope);
    }
  };
  walkArtifactStrings(tpl.outputs, inputNames);
  const walkStrings = (steps: PipelineStepSpec[], scope: Set<string>): void => {
    for (const step of steps) {
      interpolate(step.title, scope);
      interpolate(step.description, scope);
      interpolate(step.acceptanceCriteria, scope);
      walkArtifactStrings(step.outputs, scope);
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
  if (step.outputs) {
    out.outputs = step.outputs.map((a) => ({
      ...a,
      ref: substituteVars(a.ref, { [varName]: value }),
      label: sub(a.label),
      description: sub(a.description),
    }));
  }
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

// ─── Output materialization & reconciliation ──────────────────

/** Substitute ${var} across every string field of an artifact spec. */
function materializeArtifact(
  a: PipelineArtifactSpec,
  inputs: Record<string, string>,
  forceFinal = false,
): TaskDeclaredOutput {
  return {
    ref: substituteVars(a.ref, inputs),
    label: a.label ? substituteVars(a.label, inputs) : undefined,
    kind: a.kind ?? "file",
    description: a.description ? substituteVars(a.description, inputs) : undefined,
    isFinal: forceFinal || a.isFinal === true,
    status: "pending",
  };
}

/**
 * Normalize refs for matching. Files are compared by basename so handoffs that
 * use `./outline.md` or `shared/outline.md` still reconcile against a bare
 * `outline.md` declaration. Other kinds match by exact-string equality.
 */
function normalizeRef(ref: string, kind: TaskDeclaredOutput["kind"]): string {
  if (kind !== "file") return ref.trim();
  return basename(ref.trim());
}

function artifactsMatch(
  declared: TaskDeclaredOutput,
  art: TaskHandoffArtifact,
): boolean {
  // commit / url / file align with handoff kinds; "data" has no handoff
  // counterpart so we match by ref only (keeps the door open for agents to
  // declare data artifacts via "note"/"file").
  if (declared.kind === "data") {
    return normalizeRef(declared.ref, "data") === normalizeRef(art.ref, "file");
  }
  if (declared.kind !== art.kind) return false;
  return normalizeRef(declared.ref, declared.kind) === normalizeRef(art.ref, declared.kind);
}

/**
 * Update a task's declaredOutputs based on its handoff.
 * - If the task produced a matching artifact, mark "produced" (+ producedBy).
 * - If the task is in a terminal-failure state (failed/cancelled) and the
 *   output was still "pending", mark "missing".
 * - Otherwise leave as-is.
 *
 * Pure: returns a new array; caller persists via updateTask.
 */
export function reconcileDeclaredOutputs(
  task: Pick<GuildTask, "id" | "status" | "assignedAgentId" | "result" | "declaredOutputs" | "completedAt">,
): TaskDeclaredOutput[] | undefined {
  if (!task.declaredOutputs || task.declaredOutputs.length === 0) return task.declaredOutputs;
  const handoff = task.result?.handoff;
  const arts = handoff?.artifacts ?? [];
  const at = task.completedAt ?? new Date().toISOString();
  const agentId = task.assignedAgentId ?? handoff?.fromAgentId ?? "unknown";
  const terminalFail = task.status === "failed" || task.status === "cancelled";
  const terminalOk = task.status === "completed";
  return task.declaredOutputs.map((d) => {
    if (d.status === "produced") return d; // already settled
    const match = arts.find((a) => artifactsMatch(d, a));
    if (match) {
      return {
        ...d,
        status: "produced",
        producedBy: { taskId: task.id, agentId, at },
      };
    }
    if (terminalOk || terminalFail) {
      // Task finished but didn't declare this artifact → missing.
      return { ...d, status: "missing" };
    }
    return d;
  });
}

/**
 * Roll up child `declaredOutputs` into a parent pipeline's `declaredOutputs`.
 * Matches by ref+kind; a final output on the parent is marked "produced" as
 * soon as any child produces it. Outputs that only exist on the parent (no
 * matching child) keep their existing status.
 */
export function aggregateParentOutputs(
  parentOutputs: TaskDeclaredOutput[] | undefined,
  children: GuildTask[],
): TaskDeclaredOutput[] | undefined {
  if (!parentOutputs || parentOutputs.length === 0) return parentOutputs;
  const produced = new Map<string, TaskDeclaredOutput>();
  for (const c of children) {
    for (const d of c.declaredOutputs ?? []) {
      if (d.status !== "produced") continue;
      produced.set(`${d.kind}::${normalizeRef(d.ref, d.kind)}`, d);
    }
  }
  const allChildrenTerminal =
    children.length > 0 &&
    children.every(
      (c) => c.status === "completed" || c.status === "failed" || c.status === "cancelled",
    );
  return parentOutputs.map((p) => {
    if (p.status === "produced") return p;
    const key = `${p.kind}::${normalizeRef(p.ref, p.kind)}`;
    const hit = produced.get(key);
    if (hit) {
      return { ...p, status: "produced", producedBy: hit.producedBy };
    }
    if (allChildrenTerminal) return { ...p, status: "missing" };
    return p;
  });
}

/** Render a deliverables markdown table for the Workspace section. */
export function renderDeliverablesTable(outputs: TaskDeclaredOutput[] | undefined): string {
  if (!outputs || outputs.length === 0) return "_No declared deliverables._";
  const icon = (s?: DeclaredOutputStatus): string =>
    s === "produced" ? "✅" : s === "missing" ? "❌" : "⏳";
  const rows = outputs.map((o) => {
    const star = o.isFinal ? "⭐" : "";
    const label = o.label ? ` — ${o.label}` : "";
    const producedBy = o.producedBy
      ? `\`${o.producedBy.taskId}\` @ ${o.producedBy.agentId}`
      : "—";
    const desc = (o.description ?? "").replace(/\|/g, "\\|").slice(0, 80);
    return `| ${star} \`${o.ref}\` | ${o.kind} | ${icon(o.status)} ${o.status ?? "pending"} | ${producedBy} | ${desc}${label} |`;
  });
  return [
    "| | Artifact | Kind | Status | Produced by | Notes |",
    "|-|----------|------|--------|-------------|-------|",
    ...rows,
  ].join("\n");
}

// DeclaredOutputStatus type is exposed via types.ts — re-export for consumers.
import type { DeclaredOutputStatus } from "./types.js";
import { getTask } from "./taskBoard.js";
export type { DeclaredOutputStatus };

/**
 * Called after a task reaches a terminal state. Updates that task's own
 * `declaredOutputs` based on its handoff artifacts, then — if the task is a
 * child of a pipeline — recomputes the parent's aggregated deliverables and
 * re-renders the workspace Deliverables section.
 *
 * Safe no-op for tasks without declaredOutputs or outside a pipeline.
 */
export function syncPipelineOutputsAfterCompletion(
  groupId: string,
  taskId: string,
): void {
  const task = getTask(groupId, taskId);
  if (!task) return;
  // Reconcile this task's own declaredOutputs against its handoff.
  const reconciled = reconcileDeclaredOutputs(task);
  if (reconciled && reconciled !== task.declaredOutputs) {
    updateTask(groupId, taskId, { declaredOutputs: reconciled });
  }
  // Propagate to pipeline parent, if any.
  const parentId = task.parentTaskId;
  if (!parentId) return;
  const parent = getTask(groupId, parentId);
  if (!parent || parent.kind !== "pipeline") return;
  const siblings = getSubtasks(groupId, parentId);
  const parentOutputs = aggregateParentOutputs(parent.declaredOutputs, siblings);
  if (parentOutputs && parentOutputs !== parent.declaredOutputs) {
    updateTask(groupId, parentId, { declaredOutputs: parentOutputs });
  }
  // Always re-render the workspace table so "produced" icons refresh even
  // when aggregate identity didn't change (e.g. same set of outputs, same
  // statuses) — cheap, keeps UI in sync.
  try {
    updateDeliverablesSection(
      groupId,
      parentId,
      renderDeliverablesTable(parentOutputs),
    );
  } catch (e) {
    serverLogger.warn("[pipelines] failed to refresh deliverables section", {
      groupId,
      parentId,
      error: String(e),
    });
  }
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

function renderScopeMd(
  template: PipelineTemplate,
  inputs: Record<string, string>,
  parentOutputs?: TaskDeclaredOutput[],
): string {
  const lines: string[] = [];
  lines.push(`- **Template**: \`${template.id}\` — ${template.name}`);
  if (template.description) lines.push(`- **Description**: ${template.description}`);
  const inputKeys = Object.keys(inputs);
  if (inputKeys.length > 0) {
    lines.push(`- **Inputs**:`);
    for (const k of inputKeys) lines.push(`  - \`${k}\`: ${inputs[k]}`);
  }
  const finals = (parentOutputs ?? []).filter((o) => o.isFinal);
  if (finals.length > 0) {
    lines.push(`- **🎯 Final deliverables**:`);
    for (const o of finals) {
      const label = o.label ? ` — ${o.label}` : "";
      lines.push(`  - \`${o.ref}\` (${o.kind})${label}`);
    }
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
  const parentFinalOutputs: TaskDeclaredOutput[] = [];
  const finalSeen = new Set<string>(); // de-dupe on kind::normRef
  flat.forEach((fs, i) => {
    const step = fs.step;
    const depIds = fs.deps
      .map((idx) => idByFlatIndex.get(idx))
      .filter((x): x is string => !!x);
    const stepOutputs = (step.outputs ?? []).map((a) => materializeArtifact(a, inputs));
    for (const o of stepOutputs) {
      if (!o.isFinal) continue;
      const key = `${o.kind}::${normalizeRef(o.ref, o.kind)}`;
      if (finalSeen.has(key)) continue;
      finalSeen.add(key);
      parentFinalOutputs.push({ ...o });
    }
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
      declaredOutputs: stepOutputs.length > 0 ? stepOutputs : undefined,
    };
    const sub = createTask(groupId, params);
    created.push(sub);
    idByFlatIndex.set(i, sub.id);
  });

  // Template-level outputs are always final. Merge them in front so they
  // anchor the deliverables table, and de-dupe against step-level finals.
  const templateFinalOutputs = (template.outputs ?? []).map((a) =>
    materializeArtifact(a, inputs, true),
  );
  const parentDeclared: TaskDeclaredOutput[] = [];
  const declaredSeen = new Set<string>();
  for (const o of [...templateFinalOutputs, ...parentFinalOutputs]) {
    const key = `${o.kind}::${normalizeRef(o.ref, o.kind)}`;
    if (declaredSeen.has(key)) continue;
    declaredSeen.add(key);
    parentDeclared.push(o);
  }

  const subtaskIds = created.map((t) => t.id);
  // Move the pipeline parent into in_progress so the UI renders it in the
  // same column as its running children. Leaving it in "open" caused the
  // parent group header to orphan in 待处理 while subtasks showed as a
  // ghost-req group in 进行中 — users read that as "一个独立于需求之外的任务".
  updateTask(groupId, parent.id, {
    status: "in_progress",
    startedAt: new Date().toISOString(),
    subtaskIds,
    declaredOutputs: parentDeclared.length > 0 ? parentDeclared : undefined,
  });

  updatePlanSection(groupId, parent.id, renderPlanTable(created));
  updateScopeSection(groupId, parent.id, renderScopeMd(template, inputs, parentDeclared));
  updateDeliverablesSection(groupId, parent.id, renderDeliverablesTable(parentDeclared));
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
