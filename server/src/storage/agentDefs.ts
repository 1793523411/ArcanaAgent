import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { listToolIds } from "../tools/index.js";

const DATA_DIR = resolve(process.env.DATA_DIR ?? join(process.cwd(), "data"));
const AGENTS_FILE = join(DATA_DIR, "agents.json");

export interface AgentDef {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  systemPrompt: string;
  /** Allowed tool IDs. ["*"] = all tools allowed. [] = no tools. */
  allowedTools: string[];
  builtIn: boolean;
}

/** Wildcard value meaning "all tools are allowed" */
export const ALL_TOOLS_WILDCARD = "*";

const BUILT_IN_AGENTS: AgentDef[] = [
  {
    id: "planner",
    name: "Planner",
    description: "分析任务、拆解子任务、制定计划",
    icon: "📐",
    color: "#3B82F6",
    systemPrompt: `You are the **Planner** agent.
Your job is to analyze the task, break it down into actionable subtasks, identify dependencies, and produce a structured plan.
- **FIRST**: Run \`project_snapshot\` to get the project map — understand architecture and key symbols before planning.
- Use \`project_search\` for finding related code by functionality, \`search_code\` for exact pattern matching.
- Use \`list_files\` and \`read_file\` to explore specific areas in detail.
- You MUST NOT write or modify any files, and you MUST NOT run shell commands.
- Output a clear, numbered plan with acceptance criteria for each step.
- Identify risks, edge cases, and suggest which role should handle each subtask.`,
    allowedTools: ["read_file", "search_code", "list_files", "load_skill", "background_run", "background_check", "background_cancel", "web_search", "project_index", "project_search", "project_snapshot"],
    builtIn: true,
  },
  {
    id: "coder",
    name: "Coder",
    description: "编写代码、创建文件、实现功能",
    icon: "💻",
    color: "#10B981",
    systemPrompt: `You are the **Coder** agent.
Your job is to implement code changes according to the plan or instructions given.
- **FIRST**: Run \`project_snapshot\` to get the project map — understand overall structure before coding.
- Write clean, well-structured code following existing project conventions.
- Read relevant files before making changes to understand context.
- Prefer \`edit_file\` (search-and-replace) over \`write_file\` when modifying existing files.
- Use \`project_search\` to find related code by functionality, \`search_code\` for exact pattern matching.
- Use \`list_files\` to understand project structure.
- Create or modify files as needed to complete the implementation.
- If tests are needed, write them alongside the implementation.`,
    allowedTools: ["*"],
    builtIn: true,
  },
  {
    id: "reviewer",
    name: "Reviewer",
    description: "代码审查、发现问题、提出改进建议",
    icon: "🔍",
    color: "#8B5CF6",
    systemPrompt: `You are the **Reviewer** agent.
Your job is to review code changes, find bugs, security issues, and suggest improvements.
- **FIRST**: Run \`project_snapshot\` to get the project map — understand the architecture context of the changes.
- You MUST NOT write or modify any files directly, and you MUST NOT run shell commands.
- Read the changed files carefully and compare with the original.
- Use \`project_search\` to find related code by functionality, \`search_code\` for exact patterns.
- Check for: correctness, edge cases, security vulnerabilities, performance issues, code style.
- Provide specific, actionable feedback with file paths and line numbers.
- Rate severity: critical / major / minor / suggestion.
- End every review with a verdict line: \`VERDICT: PASS\` or \`VERDICT: NEEDS_FIX\`
- If NEEDS_FIX, list required changes as numbered bullet points with severity (critical/major/minor).`,
    allowedTools: ["read_file", "search_code", "list_files", "git_operations", "load_skill", "background_run", "background_check", "background_cancel", "web_search", "project_search", "project_snapshot"],
    builtIn: true,
  },
  {
    id: "tester",
    name: "Tester",
    description: "运行测试、验证行为、编写测试用例",
    icon: "🧪",
    color: "#F59E0B",
    systemPrompt: `You are the **Tester** agent.
Your job is to validate that the implementation works correctly.
- Run existing test suites and check for failures.
- Write new test cases if needed to cover the changes.
- Execute commands to verify behavior end-to-end.
- Report: tests passed/failed, coverage gaps, and any issues found.`,
    allowedTools: ["*"],
    builtIn: true,
  },
];

function load(): AgentDef[] {
  if (!existsSync(AGENTS_FILE)) return [];
  try {
    const raw = JSON.parse(readFileSync(AGENTS_FILE, "utf-8")) as Array<Record<string, unknown>>;
    // Migrate old deniedTools format → allowedTools
    const allToolIds = listToolIds();
    return raw.map((a) => {
      if ("allowedTools" in a && Array.isArray(a.allowedTools)) {
        return a as unknown as AgentDef;
      }
      // Legacy: convert deniedTools to allowedTools
      const denied = Array.isArray(a.deniedTools) ? (a.deniedTools as string[]) : [];
      const allowed = denied.length === 0
        ? [ALL_TOOLS_WILDCARD]
        : allToolIds.filter((id) => !denied.includes(id));
      const { deniedTools: _, ...rest } = a;
      return { ...rest, allowedTools: allowed } as unknown as AgentDef;
    });
  } catch {
    return [];
  }
}

function save(agents: AgentDef[]): void {
  writeFileSync(AGENTS_FILE, JSON.stringify(agents, null, 2));
}

/** Ensure built-in agents exist and stay in sync with code definitions. Call once at startup. */
export function ensureBuiltInAgents(): void {
  const existing = load();
  const existingMap = new Map(existing.map((a) => [a.id, a]));
  let changed = false;
  for (const builtin of BUILT_IN_AGENTS) {
    const ex = existingMap.get(builtin.id);
    if (!ex) {
      existing.push(builtin);
      changed = true;
    } else if (ex.builtIn) {
      // Only write if the definition actually differs from code
      if (
        ex.systemPrompt !== builtin.systemPrompt ||
        ex.description !== builtin.description ||
        ex.name !== builtin.name ||
        ex.icon !== builtin.icon ||
        ex.color !== builtin.color ||
        JSON.stringify(ex.allowedTools) !== JSON.stringify(builtin.allowedTools)
      ) {
        const idx = existing.findIndex((a) => a.id === builtin.id);
        if (idx >= 0) {
          existing[idx] = builtin;
          changed = true;
        }
      }
    }
  }
  if (changed || existing.length === 0) {
    save(existing);
  }
}

export function listAgentDefs(): AgentDef[] {
  ensureBuiltInAgents();
  return load();
}

export function getAgentDef(id: string): AgentDef | null {
  const agents = listAgentDefs();
  return agents.find((a) => a.id === id) ?? null;
}

export function createAgentDef(
  data: Omit<AgentDef, "id" | "builtIn">
): AgentDef {
  // Validate allowedTools against known tool IDs (skip wildcard)
  if (data.allowedTools && data.allowedTools.length > 0 && !data.allowedTools.includes(ALL_TOOLS_WILDCARD)) {
    const validIds = new Set(listToolIds());
    const invalid = data.allowedTools.filter((t) => !validIds.has(t));
    if (invalid.length > 0) {
      throw new Error(`Invalid allowedTools: ${invalid.join(", ")}. Valid tools: ${[...validIds].join(", ")}`);
    }
  }
  const agents = load();
  const id = `agent_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const def: AgentDef = { ...data, id, builtIn: false };
  agents.push(def);
  save(agents);
  return def;
}

export function updateAgentDef(
  id: string,
  data: Partial<Omit<AgentDef, "id" | "builtIn">>
): AgentDef | null {
  // Validate allowedTools against known tool IDs (skip wildcard)
  if (data.allowedTools && data.allowedTools.length > 0 && !data.allowedTools.includes(ALL_TOOLS_WILDCARD)) {
    const validIds = new Set(listToolIds());
    const invalid = data.allowedTools.filter((t) => !validIds.has(t));
    if (invalid.length > 0) {
      throw new Error(`Invalid allowedTools: ${invalid.join(", ")}. Valid tools: ${[...validIds].join(", ")}`);
    }
  }
  const agents = load();
  const idx = agents.findIndex((a) => a.id === id);
  if (idx < 0) return null;
  if (agents[idx].builtIn) return null; // built-in agents are read-only
  agents[idx] = { ...agents[idx], ...data };
  save(agents);
  return agents[idx];
}

export function deleteAgentDef(id: string): boolean {
  const agents = load();
  const idx = agents.findIndex((a) => a.id === id);
  if (idx < 0) return false;
  if (agents[idx].builtIn) return false; // cannot delete built-in
  agents.splice(idx, 1);
  save(agents);
  return true;
}
