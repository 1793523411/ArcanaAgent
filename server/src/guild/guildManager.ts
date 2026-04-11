import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from "fs";
import { join, resolve } from "path";
import type {
  Guild, Group, GuildAgent, AgentAsset,
  CreateAgentParams, CreateGroupParams, AgentStats,
} from "./types.js";
import { guildEventBus } from "./eventBus.js";

const DATA_DIR = resolve(process.env.DATA_DIR ?? join(process.cwd(), "data"));
const GUILD_DIR = join(DATA_DIR, "guild");
const GUILD_FILE = join(GUILD_DIR, "guild.json");
const GROUPS_DIR = join(GUILD_DIR, "groups");
const AGENTS_DIR = join(GUILD_DIR, "agents");

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function genId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function writeJSON(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function readJSON<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf-8")) as T; } catch { return null; }
}

const defaultStats = (): AgentStats => ({
  tasksCompleted: 0,
  totalWorkTimeMs: 0,
  avgConfidence: 0,
  successRate: 0,
  lastActiveAt: new Date().toISOString(),
});

// ─── Guild ──────────────────────────────────────────────────────

export function getGuild(): Guild {
  ensureDir(GUILD_DIR);
  const existing = readJSON<Guild>(GUILD_FILE);
  if (existing) return existing;
  const guild: Guild = {
    id: "guild_default",
    name: "My Guild",
    description: "Default guild workspace",
    groups: [],
    agentPool: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeJSON(GUILD_FILE, guild);
  return guild;
}

export function updateGuild(updates: Partial<Pick<Guild, "name" | "description">>): Guild {
  const guild = getGuild();
  if (updates.name !== undefined) guild.name = updates.name;
  if (updates.description !== undefined) guild.description = updates.description;
  guild.updatedAt = new Date().toISOString();
  writeJSON(GUILD_FILE, guild);
  return guild;
}

function saveGuild(guild: Guild): void {
  ensureDir(GUILD_DIR);
  writeJSON(GUILD_FILE, guild);
}

// ─── Group ──────────────────────────────────────────────────────

function groupDir(id: string): string { return join(GROUPS_DIR, id); }
function groupMetaPath(id: string): string { return join(groupDir(id), "meta.json"); }

export function createGroup(params: CreateGroupParams): Group {
  ensureDir(GROUPS_DIR);
  const guild = getGuild();
  const id = genId("grp");
  const now = new Date().toISOString();
  const group: Group = {
    id,
    name: params.name,
    description: params.description,
    guildId: guild.id,
    agents: [],
    sharedContext: params.sharedContext,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  ensureDir(groupDir(id));
  writeJSON(groupMetaPath(id), group);
  // Update guild
  guild.groups.push(id);
  guild.updatedAt = now;
  saveGuild(guild);
  guildEventBus.emit({ type: "group_updated", groupId: id });
  return group;
}

export function getGroup(id: string): Group | null {
  return readJSON<Group>(groupMetaPath(id));
}

export function listGroups(): Group[] {
  ensureDir(GROUPS_DIR);
  const ids = readdirSync(GROUPS_DIR).filter((name) => existsSync(groupMetaPath(name)));
  const groups: Group[] = [];
  for (const id of ids) {
    const g = readJSON<Group>(groupMetaPath(id));
    if (g) groups.push(g);
  }
  return groups.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function updateGroup(id: string, updates: Partial<Pick<Group, "name" | "description" | "sharedContext" | "status">>): Group | null {
  const group = getGroup(id);
  if (!group) return null;
  if (updates.name !== undefined) group.name = updates.name;
  if (updates.description !== undefined) group.description = updates.description;
  if (updates.sharedContext !== undefined) group.sharedContext = updates.sharedContext;
  if (updates.status !== undefined) group.status = updates.status;
  group.updatedAt = new Date().toISOString();
  writeJSON(groupMetaPath(id), group);
  guildEventBus.emit({ type: "group_updated", groupId: id });
  return group;
}

export function archiveGroup(id: string): boolean {
  const result = updateGroup(id, { status: "archived" });
  return result !== null;
}

// ─── Agent ──────────────────────────────────────────────────────

function agentDir(id: string): string { return join(AGENTS_DIR, id); }
function agentProfilePath(id: string): string { return join(agentDir(id), "profile.json"); }

export function createAgent(params: CreateAgentParams): GuildAgent {
  ensureDir(AGENTS_DIR);
  const guild = getGuild();
  const id = genId("agt");
  const now = new Date().toISOString();
  const memoryDir = join(agentDir(id), "memory");

  const assets: AgentAsset[] = (params.assets ?? []).map((a) => ({
    ...a,
    id: genId("ast"),
    addedAt: now,
  }));

  const agent: GuildAgent = {
    id,
    name: params.name,
    description: params.description,
    icon: params.icon ?? "🤖",
    color: params.color ?? "#3B82F6",
    systemPrompt: params.systemPrompt,
    allowedTools: params.allowedTools ?? ["*"],
    modelId: params.modelId,
    memoryDir,
    assets,
    skills: [],
    status: "idle",
    createdAt: now,
    updatedAt: now,
    stats: defaultStats(),
  };

  ensureDir(agentDir(id));
  ensureDir(memoryDir);
  ensureDir(join(memoryDir, "experiences"));
  ensureDir(join(memoryDir, "knowledge"));
  ensureDir(join(memoryDir, "preferences"));
  ensureDir(join(agentDir(id), "results"));
  writeJSON(agentProfilePath(id), agent);

  // Add to guild agent pool
  guild.agentPool.push(id);
  guild.updatedAt = now;
  saveGuild(guild);

  guildEventBus.emit({ type: "agent_updated", agentId: id });
  return agent;
}

export function getAgent(id: string): GuildAgent | null {
  return readJSON<GuildAgent>(agentProfilePath(id));
}

export function listAgents(): GuildAgent[] {
  ensureDir(AGENTS_DIR);
  const ids = readdirSync(AGENTS_DIR).filter((name) => existsSync(agentProfilePath(name)));
  const agents: GuildAgent[] = [];
  for (const id of ids) {
    const a = readJSON<GuildAgent>(agentProfilePath(id));
    if (a) agents.push(a);
  }
  return agents.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function updateAgent(id: string, updates: Partial<Pick<GuildAgent, "name" | "description" | "icon" | "color" | "systemPrompt" | "allowedTools" | "modelId" | "status" | "currentTaskId">>): GuildAgent | null {
  const agent = getAgent(id);
  if (!agent) return null;
  Object.assign(agent, updates);
  agent.updatedAt = new Date().toISOString();
  writeJSON(agentProfilePath(id), agent);
  guildEventBus.emit({ type: "agent_updated", agentId: id });
  return agent;
}

export function updateAgentStats(id: string, statUpdates: Partial<AgentStats>): GuildAgent | null {
  const agent = getAgent(id);
  if (!agent) return null;
  Object.assign(agent.stats, statUpdates);
  agent.updatedAt = new Date().toISOString();
  writeJSON(agentProfilePath(id), agent);
  return agent;
}

export function deleteAgent(id: string): boolean {
  const agent = getAgent(id);
  if (!agent) return false;

  // Remove from group if assigned
  if (agent.groupId) {
    removeAgentFromGroup(id);
  }

  // Remove from guild agent pool
  const guild = getGuild();
  guild.agentPool = guild.agentPool.filter((a) => a !== id);
  guild.updatedAt = new Date().toISOString();
  saveGuild(guild);

  // Delete agent directory
  const dir = agentDir(id);
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  return true;
}

// ─── Agent ↔ Group Binding ──────────────────────────────────────

export function assignAgentToGroup(agentId: string, groupId: string): boolean {
  const agent = getAgent(agentId);
  const group = getGroup(groupId);
  if (!agent || !group) return false;

  // Already in this group?
  if (group.agents.includes(agentId)) return true;

  // Add to group (agent can be in multiple groups)
  group.agents.push(agentId);
  group.updatedAt = new Date().toISOString();
  writeJSON(groupMetaPath(groupId), group);

  // Update agent — track primary group (last assigned)
  agent.groupId = groupId;
  agent.updatedAt = new Date().toISOString();
  writeJSON(agentProfilePath(agentId), agent);

  // Remove from guild agent pool
  const guild = getGuild();
  guild.agentPool = guild.agentPool.filter((a) => a !== agentId);
  guild.updatedAt = new Date().toISOString();
  saveGuild(guild);

  guildEventBus.emit({ type: "agent_updated", agentId });
  guildEventBus.emit({ type: "group_updated", groupId });
  return true;
}

export function removeAgentFromGroup(agentId: string, fromGroupId?: string): boolean {
  const agent = getAgent(agentId);
  if (!agent) return false;

  const groupId = fromGroupId ?? agent.groupId;
  if (!groupId) return false;

  const group = getGroup(groupId);
  if (group) {
    group.agents = group.agents.filter((a) => a !== agentId);
    group.updatedAt = new Date().toISOString();
    writeJSON(groupMetaPath(groupId), group);
  }

  // Check if agent is still in any other group
  const allGroups = listGroups();
  const remainingGroup = allGroups.find((g) => g.agents.includes(agentId));

  if (remainingGroup) {
    // Still in another group — update primary
    agent.groupId = remainingGroup.id;
  } else {
    // Not in any group — return to pool
    agent.groupId = undefined;
    const guild = getGuild();
    if (!guild.agentPool.includes(agentId)) {
      guild.agentPool.push(agentId);
      guild.updatedAt = new Date().toISOString();
      saveGuild(guild);
    }
  }

  agent.updatedAt = new Date().toISOString();
  writeJSON(agentProfilePath(agentId), agent);
  // Emit agent_updated BEFORE group_updated. The SSE stream handler rebuilds
  // its groupAgentIds cache on group_updated, so if group_updated fired first
  // the agent_updated event would be filtered out and the client would never
  // see the leaver's fresh groupId / pool state.
  guildEventBus.emit({ type: "agent_updated", agentId });
  if (group) guildEventBus.emit({ type: "group_updated", groupId });
  return true;
}

export function getGroupAgents(groupId: string): GuildAgent[] {
  const group = getGroup(groupId);
  if (!group) return [];
  return group.agents.map((id) => getAgent(id)).filter((a): a is GuildAgent => a !== null);
}

export function getUnassignedAgents(): GuildAgent[] {
  const guild = getGuild();
  return guild.agentPool.map((id) => getAgent(id)).filter((a): a is GuildAgent => a !== null);
}

// ─── Agent Assets ───────────────────────────────────────────────

export function addAsset(agentId: string, asset: Omit<AgentAsset, "id" | "addedAt">): AgentAsset | null {
  const agent = getAgent(agentId);
  if (!agent) return null;
  const now = new Date().toISOString();
  const newAsset: AgentAsset = {
    ...asset,
    id: genId("ast"),
    addedAt: now,
  };
  agent.assets.push(newAsset);
  agent.updatedAt = now;
  writeJSON(agentProfilePath(agentId), agent);
  guildEventBus.emit({ type: "agent_updated", agentId });
  return newAsset;
}

export function removeAsset(agentId: string, assetId: string): boolean {
  const agent = getAgent(agentId);
  if (!agent) return false;
  const idx = agent.assets.findIndex((a) => a.id === assetId);
  if (idx < 0) return false;
  agent.assets.splice(idx, 1);
  agent.updatedAt = new Date().toISOString();
  writeJSON(agentProfilePath(agentId), agent);
  guildEventBus.emit({ type: "agent_updated", agentId });
  return true;
}
