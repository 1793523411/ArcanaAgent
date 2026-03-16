import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, resolve } from "path";

const DATA_DIR = resolve(process.env.DATA_DIR ?? join(process.cwd(), "data"));
const AGENTS_FILE = join(DATA_DIR, "agents.json");

export interface AgentDef {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  systemPrompt: string;
  deniedTools: string[];
  builtIn: boolean;
}

const BUILT_IN_AGENTS: AgentDef[] = [
  {
    id: "planner",
    name: "Planner",
    description: "分析任务、拆解子任务、制定计划",
    icon: "📐",
    color: "#3B82F6",
    systemPrompt: `You are the **Planner** agent.
Your job is to analyze the task, break it down into actionable subtasks, identify dependencies, and produce a structured plan.
- Focus on reading files and understanding the codebase structure.
- You MUST NOT write or modify any files, and you MUST NOT run shell commands.
- Output a clear, numbered plan with acceptance criteria for each step.
- Identify risks, edge cases, and suggest which role should handle each subtask.`,
    deniedTools: ["write_file", "run_command"],
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
- Write clean, well-structured code following existing project conventions.
- Read relevant files before making changes to understand context.
- Create or modify files as needed to complete the implementation.
- If tests are needed, write them alongside the implementation.`,
    deniedTools: [],
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
- You MUST NOT write or modify any files directly, and you MUST NOT run shell commands.
- Read the changed files carefully and compare with the original.
- Check for: correctness, edge cases, security vulnerabilities, performance issues, code style.
- Provide specific, actionable feedback with file paths and line numbers.
- Rate severity: critical / major / minor / suggestion.`,
    deniedTools: ["write_file", "run_command"],
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
    deniedTools: [],
    builtIn: true,
  },
];

function load(): AgentDef[] {
  if (!existsSync(AGENTS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(AGENTS_FILE, "utf-8")) as AgentDef[];
  } catch {
    return [];
  }
}

function save(agents: AgentDef[]): void {
  writeFileSync(AGENTS_FILE, JSON.stringify(agents, null, 2));
}

/** Ensure built-in agents exist. Call once at startup. */
export function ensureBuiltInAgents(): void {
  const existing = load();
  const existingIds = new Set(existing.map((a) => a.id));
  let changed = false;
  for (const builtin of BUILT_IN_AGENTS) {
    if (!existingIds.has(builtin.id)) {
      existing.push(builtin);
      changed = true;
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
