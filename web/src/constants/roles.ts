import type { AgentRole } from "../types";

export interface RoleDisplayConfig {
  displayName: string;
  color: string;
  icon: string;
}

export const ROLE_CONFIG: Record<AgentRole, RoleDisplayConfig> = {
  planner: { displayName: "Planner", color: "#3B82F6", icon: "📐" },
  coder:   { displayName: "Coder",   color: "#10B981", icon: "💻" },
  reviewer:{ displayName: "Reviewer", color: "#8B5CF6", icon: "🔍" },
  tester:  { displayName: "Tester",  color: "#F59E0B", icon: "🧪" },
};

export function getRoleConfig(role?: AgentRole): RoleDisplayConfig | undefined {
  return role ? ROLE_CONFIG[role] : undefined;
}
