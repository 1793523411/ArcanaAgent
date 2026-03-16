import { getAgentDef, type AgentDef } from "../storage/agentDefs.js";
import { getTeamDef, type TeamDef } from "../storage/teamDefs.js";

export type { AgentDef } from "../storage/agentDefs.js";
export type { TeamDef } from "../storage/teamDefs.js";

/** AgentRole 不再是固定联合类型，任何 AgentDef ID 都是合法 role */
export type AgentRole = string;

export interface RoleConfig {
  displayName: string;
  systemPromptAddendum: string;
  deniedTools: string[];
  color: string;
  icon: string;
}

/** 从存储中获取 AgentDef 的 RoleConfig 视图 */
export function getAgentConfig(agentId: string): RoleConfig | null {
  const def = getAgentDef(agentId);
  if (!def) return null;
  return {
    displayName: def.name,
    systemPromptAddendum: def.systemPrompt,
    deniedTools: def.deniedTools,
    color: def.color,
    icon: def.icon,
  };
}

/** 检查 agentId 是否在指定 Team 的成员列表中 */
export function isValidTeamAgent(agentId: string, teamId: string): boolean {
  const team = getTeamDef(teamId ?? "default");
  if (!team) return false;
  return team.agents.includes(agentId);
}

/** 获取指定 Team 的 AgentDef 列表 */
export function getTeamAgents(teamId: string): AgentDef[] {
  const team = getTeamDef(teamId ?? "default");
  if (!team) return [];
  const agents: AgentDef[] = [];
  for (const id of team.agents) {
    const def = getAgentDef(id);
    if (def) agents.push(def);
  }
  return agents;
}

/** 向后兼容：保留 ROLE_CONFIGS 引用（动态从存储读取） */
export function getRoleConfig(role: string): RoleConfig | null {
  return getAgentConfig(role);
}
