import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, resolve, relative } from "path";
import type { GuildTask, TaskHandoff } from "./types.js";
import { atomicWriteFileSync } from "./atomicFs.js";

/**
 * Per-requirement shared workspace ("living blackboard").
 *
 * Each `requirement` task owns a workspace.md file that lead + specialists
 * read and append to. Sections are parsed by markdown heading so any party
 * can read a specific piece into its prompt without loading the whole file.
 *
 * Layout: data/guild/groups/{groupId}/workspaces/{parentTaskId}.md
 */

const DATA_DIR = resolve(process.env.DATA_DIR ?? join(process.cwd(), "data"));
const GUILD_DIR = join(DATA_DIR, "guild");
const GROUPS_DIR = join(GUILD_DIR, "groups");

function workspacesDir(groupId: string): string {
  return join(GROUPS_DIR, groupId, "workspaces");
}

function workspacePath(groupId: string, parentTaskId: string): string {
  return join(workspacesDir(groupId), `${parentTaskId}.md`);
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

/** Workspace-relative path used for the `workspaceRef` field on tasks. */
export function getWorkspaceRef(groupId: string, parentTaskId: string): string {
  return relative(DATA_DIR, workspacePath(groupId, parentTaskId));
}

const SECTION_ORDER = [
  "Meta",
  "Goal",
  "Scope",
  "Plan",
  "Deliverables",
  "Decisions Log",
  "Handoffs",
  "Open Questions",
] as const;
type SectionName = typeof SECTION_ORDER[number];

export type WorkspaceStatus = "planning" | "in_progress" | "done" | "blocked";

export interface WorkspaceMeta {
  title: string;
  status: WorkspaceStatus;
  leadAgentId: string;
  createdAt: string;
  updatedAt: string;
}

export interface Workspace {
  meta: WorkspaceMeta;
  goal: string;
  scope: string;
  plan: string;
  deliverables: string;
  decisions: string;
  handoffs: string;
  openQuestions: string;
}

// ─── Serialization ──────────────────────────────────────────────

function renderMeta(meta: WorkspaceMeta): string {
  return [
    `**Status**: ${meta.status}`,
    `**Lead**: ${meta.leadAgentId}`,
    `**Created**: ${meta.createdAt}`,
    `**Last Updated**: ${meta.updatedAt}`,
  ].join("\n");
}

function renderWorkspace(ws: Workspace): string {
  return [
    `# ${ws.meta.title}`,
    "",
    renderMeta(ws.meta),
    "",
    `## Goal`,
    ws.goal.trim(),
    "",
    `## Scope`,
    ws.scope.trim(),
    "",
    `## Plan`,
    ws.plan.trim(),
    "",
    `## Deliverables`,
    ws.deliverables.trim(),
    "",
    `## Decisions Log`,
    ws.decisions.trim(),
    "",
    `## Handoffs`,
    ws.handoffs.trim(),
    "",
    `## Open Questions`,
    ws.openQuestions.trim(),
    "",
  ].join("\n");
}

/**
 * Minimal section-based parser. We only need to round-trip sections that the
 * planner/executor append to; markdown inside each section is kept verbatim.
 */
function parseWorkspace(raw: string): Workspace {
  const lines = raw.split("\n");
  const title = (lines[0] ?? "").replace(/^#\s*/, "").trim();

  // Meta lines (bold key/value) until first `## `.
  const meta: WorkspaceMeta = {
    title,
    status: "planning",
    leadAgentId: "",
    createdAt: "",
    updatedAt: "",
  };
  let i = 1;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("## ")) break;
    const m = l.match(/^\*\*(Status|Lead|Created|Last Updated)\*\*:\s*(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (k === "Status") meta.status = (v.trim() as WorkspaceStatus) || "planning";
    else if (k === "Lead") meta.leadAgentId = v.trim();
    else if (k === "Created") meta.createdAt = v.trim();
    else if (k === "Last Updated") meta.updatedAt = v.trim();
  }

  const sections: Record<SectionName, string> = {
    Meta: "",
    Goal: "",
    Scope: "",
    Plan: "",
    Deliverables: "",
    "Decisions Log": "",
    Handoffs: "",
    "Open Questions": "",
  };
  let current: SectionName | null = null;
  for (; i < lines.length; i++) {
    const l = lines[i];
    const h = l.match(/^##\s+(.+?)\s*$/);
    if (h) {
      const name = h[1].trim() as SectionName;
      if ((SECTION_ORDER as readonly string[]).includes(name)) {
        current = name;
      } else {
        current = null;
      }
      continue;
    }
    if (current) {
      sections[current] += (sections[current] ? "\n" : "") + l;
    }
  }

  return {
    meta,
    goal: sections.Goal.trim(),
    scope: sections.Scope.trim(),
    plan: sections.Plan.trim(),
    deliverables: sections.Deliverables.trim(),
    decisions: sections["Decisions Log"].trim(),
    handoffs: sections.Handoffs.trim(),
    openQuestions: sections["Open Questions"].trim(),
  };
}

// ─── CRUD ───────────────────────────────────────────────────────

export function createWorkspace(
  groupId: string,
  parentTaskId: string,
  title: string,
  goal: string,
  leadAgentId: string,
): string {
  ensureDir(workspacesDir(groupId));
  const now = new Date().toISOString();
  const ws: Workspace = {
    meta: { title, status: "planning", leadAgentId, createdAt: now, updatedAt: now },
    goal,
    scope: "_Scope to be defined by lead._",
    plan: "_Plan pending._",
    deliverables: "_No declared deliverables._",
    decisions: "_No decisions yet._",
    handoffs: "_No handoffs yet._",
    openQuestions: "_No open questions._",
  };
  atomicWriteFileSync(workspacePath(groupId, parentTaskId), renderWorkspace(ws));
  return getWorkspaceRef(groupId, parentTaskId);
}

export function readWorkspace(groupId: string, parentTaskId: string): Workspace | null {
  const p = workspacePath(groupId, parentTaskId);
  if (!existsSync(p)) return null;
  try {
    return parseWorkspace(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

export function readWorkspaceRaw(groupId: string, parentTaskId: string): string | null {
  const p = workspacePath(groupId, parentTaskId);
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

function writeWorkspace(groupId: string, parentTaskId: string, ws: Workspace): void {
  ws.meta.updatedAt = new Date().toISOString();
  atomicWriteFileSync(workspacePath(groupId, parentTaskId), renderWorkspace(ws));
}

export function setWorkspaceStatus(
  groupId: string,
  parentTaskId: string,
  status: WorkspaceStatus,
): void {
  const ws = readWorkspace(groupId, parentTaskId);
  if (!ws) return;
  ws.meta.status = status;
  writeWorkspace(groupId, parentTaskId, ws);
}

export function updatePlanSection(
  groupId: string,
  parentTaskId: string,
  planMarkdown: string,
): void {
  const ws = readWorkspace(groupId, parentTaskId);
  if (!ws) return;
  ws.plan = planMarkdown.trim() || "_Plan pending._";
  writeWorkspace(groupId, parentTaskId, ws);
}

/** Render a markdown table of subtasks for the workspace Plan section.
 *  Shared between the Requirement path (planner.ts) and the Pipeline path
 *  (pipelines.ts) — prior to extraction both had their own copy and would
 *  drift over time. */
export function renderPlanTable(subtasks: GuildTask[]): string {
  if (subtasks.length === 0) return "_No subtasks._";
  const header = "| ID | Title | Owner | Depends | Status | Acceptance |";
  const divider = "|----|-------|-------|---------|--------|------------|";
  const esc = (s: string) => s.replace(/\|/g, "\\|");
  const rows = subtasks.map((t) => {
    const owner = t.suggestedAgentId ?? t.assignedAgentId ?? "—";
    const deps = (t.dependsOn ?? []).join(", ") || "—";
    const acc = esc((t.acceptanceCriteria ?? "—").slice(0, 80));
    return `| \`${t.id}\` | ${esc(t.title)} | ${owner} | ${esc(deps)} | ${t.status} | ${acc} |`;
  });
  return [header, divider, ...rows].join("\n");
}

export function updateScopeSection(
  groupId: string,
  parentTaskId: string,
  scopeMarkdown: string,
): void {
  const ws = readWorkspace(groupId, parentTaskId);
  if (!ws) return;
  ws.scope = scopeMarkdown.trim() || "_Scope to be defined by lead._";
  writeWorkspace(groupId, parentTaskId, ws);
}

export function updateDeliverablesSection(
  groupId: string,
  parentTaskId: string,
  deliverablesMarkdown: string,
): void {
  const ws = readWorkspace(groupId, parentTaskId);
  if (!ws) return;
  ws.deliverables = deliverablesMarkdown.trim() || "_No declared deliverables._";
  writeWorkspace(groupId, parentTaskId, ws);
}

export function appendDecision(
  groupId: string,
  parentTaskId: string,
  author: string,
  decision: string,
): void {
  const ws = readWorkspace(groupId, parentTaskId);
  if (!ws) return;
  const stamp = new Date().toISOString();
  const entry = `- \`${stamp}\` **${author}**: ${decision}`;
  ws.decisions = ws.decisions.startsWith("_") ? entry : `${ws.decisions}\n${entry}`;
  writeWorkspace(groupId, parentTaskId, ws);
}

export function appendHandoff(
  groupId: string,
  parentTaskId: string,
  subtaskId: string,
  handoff: TaskHandoff,
): void {
  const ws = readWorkspace(groupId, parentTaskId);
  if (!ws) return;

  const lines: string[] = [];
  const target = handoff.toSubtaskId ? `→ ${handoff.toSubtaskId}` : "→ done";
  lines.push(`### [${subtaskId}] ${handoff.fromAgentId} ${target}`);
  lines.push(`- **Summary**: ${handoff.summary}`);
  if (handoff.artifacts.length > 0) {
    lines.push(`- **Artifacts**:`);
    for (const a of handoff.artifacts) {
      const desc = a.description ? ` — ${a.description}` : "";
      lines.push(`  - ${a.kind}: \`${a.ref}\`${desc}`);
    }
  }
  if (handoff.inputsConsumed && handoff.inputsConsumed.length > 0) {
    lines.push(`- **Inputs consumed**: ${handoff.inputsConsumed.join(", ")}`);
  }
  if (handoff.openQuestions && handoff.openQuestions.length > 0) {
    lines.push(`- **Open questions**:`);
    for (const q of handoff.openQuestions) lines.push(`  - ${q}`);
  }
  lines.push(`- _at ${handoff.createdAt}_`);

  const block = lines.join("\n");
  ws.handoffs = ws.handoffs.startsWith("_") ? block : `${ws.handoffs}\n\n${block}`;
  writeWorkspace(groupId, parentTaskId, ws);
}

export function setOpenQuestions(
  groupId: string,
  parentTaskId: string,
  questions: string[],
): void {
  const ws = readWorkspace(groupId, parentTaskId);
  if (!ws) return;
  ws.openQuestions = questions.length > 0
    ? questions.map((q) => `- ${q}`).join("\n")
    : "_No open questions._";
  writeWorkspace(groupId, parentTaskId, ws);
}

/** Compact snapshot for prompt injection — Goal + Plan + last N handoffs + open questions. */
export function snapshotForPrompt(
  groupId: string,
  parentTaskId: string,
  opts: { maxHandoffChars?: number } = {},
): string | null {
  const ws = readWorkspace(groupId, parentTaskId);
  if (!ws) return null;
  const maxH = opts.maxHandoffChars ?? 3000;
  let handoffs = ws.handoffs;
  if (handoffs.length > maxH) {
    handoffs = `…(truncated)…\n${handoffs.slice(-maxH)}`;
  }
  return [
    `### Workspace: ${ws.meta.title}`,
    `Status: ${ws.meta.status} · Lead: ${ws.meta.leadAgentId}`,
    ``,
    `#### Goal`,
    ws.goal,
    ``,
    `#### Plan`,
    ws.plan,
    ``,
    `#### Recent Handoffs`,
    handoffs,
    ``,
    `#### Open Questions`,
    ws.openQuestions,
  ].join("\n");
}
