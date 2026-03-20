import { listAgentDefs } from "../api";

export interface RoleDisplayConfig {
  displayName: string;
  color: string;
  icon: string;
}

// Hardcoded fallback for built-in agents (used before cache is populated)
const BUILTIN_FALLBACK: Record<string, RoleDisplayConfig> = {
  planner: { displayName: "Planner", color: "#3B82F6", icon: "📐" },
  coder:   { displayName: "Coder",   color: "#10B981", icon: "💻" },
  reviewer:{ displayName: "Reviewer", color: "#8B5CF6", icon: "🔍" },
  tester:  { displayName: "Tester",  color: "#F59E0B", icon: "🧪" },
};

let cache: Record<string, RoleDisplayConfig> = { ...BUILTIN_FALLBACK };

export async function refreshRoleCache(): Promise<void> {
  try {
    const agents = await listAgentDefs();
    const next: Record<string, RoleDisplayConfig> = {};
    for (const a of agents) {
      next[a.id] = { displayName: a.name, color: a.color, icon: a.icon };
    }
    cache = next;
  } catch {
    // keep existing cache
  }
}

// Kick off initial load
refreshRoleCache();

export function getRoleConfig(role?: string): RoleDisplayConfig | undefined {
  if (!role) return undefined;
  return cache[role] ?? BUILTIN_FALLBACK[role];
}

/** For backward compatibility — returns current cache snapshot */
export function getAllRoleConfigs(): Record<string, RoleDisplayConfig> {
  return cache;
}
