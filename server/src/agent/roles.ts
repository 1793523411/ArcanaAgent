export type AgentRole = "planner" | "coder" | "reviewer" | "tester";

export interface RoleConfig {
  displayName: string;
  systemPromptAddendum: string;
  deniedTools: string[];
  color: string;
  icon: string;
}

export const ROLE_CONFIGS: Record<AgentRole, RoleConfig> = {
  planner: {
    displayName: "Planner",
    color: "#3B82F6",
    icon: "📐",
    deniedTools: ["write_file", "run_command"],
    systemPromptAddendum: `You are the **Planner** agent.
Your job is to analyze the task, break it down into actionable subtasks, identify dependencies, and produce a structured plan.
- Focus on reading files and understanding the codebase structure.
- You MUST NOT write or modify any files, and you MUST NOT run shell commands.
- Output a clear, numbered plan with acceptance criteria for each step.
- Identify risks, edge cases, and suggest which role should handle each subtask.`,
  },
  coder: {
    displayName: "Coder",
    color: "#10B981",
    icon: "💻",
    deniedTools: [],
    systemPromptAddendum: `You are the **Coder** agent.
Your job is to implement code changes according to the plan or instructions given.
- Write clean, well-structured code following existing project conventions.
- Read relevant files before making changes to understand context.
- Create or modify files as needed to complete the implementation.
- If tests are needed, write them alongside the implementation.`,
  },
  reviewer: {
    displayName: "Reviewer",
    color: "#8B5CF6",
    icon: "🔍",
    deniedTools: ["write_file", "run_command"],
    systemPromptAddendum: `You are the **Reviewer** agent.
Your job is to review code changes, find bugs, security issues, and suggest improvements.
- You MUST NOT write or modify any files directly, and you MUST NOT run shell commands.
- Read the changed files carefully and compare with the original.
- Check for: correctness, edge cases, security vulnerabilities, performance issues, code style.
- Provide specific, actionable feedback with file paths and line numbers.
- Rate severity: critical / major / minor / suggestion.`,
  },
  tester: {
    displayName: "Tester",
    color: "#F59E0B",
    icon: "🧪",
    deniedTools: [],
    systemPromptAddendum: `You are the **Tester** agent.
Your job is to validate that the implementation works correctly.
- Run existing test suites and check for failures.
- Write new test cases if needed to cover the changes.
- Execute commands to verify behavior end-to-end.
- Report: tests passed/failed, coverage gaps, and any issues found.`,
  },
};

export const AGENT_ROLES = Object.keys(ROLE_CONFIGS) as AgentRole[];

export function isValidRole(role: string): role is AgentRole {
  return role in ROLE_CONFIGS;
}
