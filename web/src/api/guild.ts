import type { Guild, Group, GuildAgent, GuildTask, AgentMemory, AgentStats, AgentAsset, AssetType, PipelineTemplate, ArtifactManifestEntry } from "../types/guild";

const BASE = "/api";

// ─── File Tree Types ──────────────────────────────────

export interface FileTreeNode {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
  ext?: string;
  children?: FileTreeNode[];
}

export interface FileReadResult {
  content: string | null;
  size: number;
  ext: string;
  binary: boolean;
  /** For image files: data URL the UI can drop straight into <img src>. */
  dataUrl?: string;
}

// ─── AI Generation ────────────────────────────────────

export async function generateGuildAgent(description: string): Promise<{
  name: string; description: string; icon: string; color: string; systemPrompt: string; allowedTools: string[];
}> {
  const r = await fetch(`${BASE}/agents/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ─── AI Designer: plan shapes ─────────────────────────

export interface AgentSpec {
  name: string;
  description: string;
  icon: string;
  color: string;
  systemPrompt: string;
  allowedTools: string[];
  assets?: Array<{ type: AssetType; name: string; uri: string; description?: string }>;
}

export type AgentPlanItem =
  | { action: "reuse"; agentId: string; reason?: string }
  | { action: "create"; spec: AgentSpec; reason?: string }
  | { action: "fork"; sourceAgentId: string; overrides: Partial<AgentSpec>; reason?: string };

export interface GroupPlan {
  group: {
    name: string;
    description: string;
    sharedContext?: string;
    artifactStrategy?: "isolated" | "collaborative";
  };
  agents: AgentPlanItem[];
  leadIndex?: number;
  reasoning?: string;
}

export interface PipelinePlan {
  template: PipelineTemplate;
  agents: (AgentPlanItem & { planKey: string })[];
  reasoning?: string;
}

export async function generateGroupPlan(description: string, signal?: AbortSignal): Promise<GroupPlan> {
  const r = await fetch(`${BASE}/guild/groups/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description }),
    signal,
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function applyGroupPlan(plan: GroupPlan): Promise<{
  group: Group;
  agentIds: string[];
  createdAgentIds: string[];
}> {
  const r = await fetch(`${BASE}/guild/groups/apply-plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(plan),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function generatePipelinePlan(description: string, signal?: AbortSignal): Promise<PipelinePlan> {
  const r = await fetch(`${BASE}/guild/pipelines/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description }),
    signal,
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function applyPipelinePlan(plan: PipelinePlan): Promise<{
  template: PipelineTemplate;
  createdAgentIds: string[];
  agentMap: Record<string, string>;
}> {
  const r = await fetch(`${BASE}/guild/pipelines/apply-plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(plan),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function forkGuildAgent(
  agentId: string,
  overrides?: Partial<AgentSpec>,
): Promise<GuildAgent> {
  const r = await fetch(`${BASE}/guild/agents/${agentId}/fork`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(overrides ?? {}),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ─── Guild ─────────────────────────────────────────────

export async function getGuild(): Promise<Guild> {
  const r = await fetch(`${BASE}/guild`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function updateGuild(payload: Partial<Pick<Guild, "name" | "description">>): Promise<Guild> {
  const r = await fetch(`${BASE}/guild`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ─── Groups ────────────────────────────────────────────

export async function listGroups(): Promise<Group[]> {
  const r = await fetch(`${BASE}/guild/groups`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function createGroup(payload: { name: string; description: string; sharedContext?: string; artifactStrategy?: Group["artifactStrategy"] }): Promise<Group> {
  const r = await fetch(`${BASE}/guild/groups`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getGroup(groupId: string): Promise<Group> {
  const r = await fetch(`${BASE}/guild/groups/${groupId}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function updateGroup(groupId: string, payload: Partial<Pick<Group, "name" | "description" | "sharedContext" | "status" | "artifactStrategy">>): Promise<Group> {
  const r = await fetch(`${BASE}/guild/groups/${groupId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function deleteGroup(groupId: string): Promise<void> {
  const r = await fetch(`${BASE}/guild/groups/${groupId}`, { method: "DELETE" });
  if (!r.ok) throw new Error(await r.text());
}

export async function addAgentToGroup(groupId: string, agentId: string): Promise<Group> {
  const r = await fetch(`${BASE}/guild/groups/${groupId}/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function removeAgentFromGroup(groupId: string, agentId: string): Promise<void> {
  const r = await fetch(`${BASE}/guild/groups/${groupId}/agents/${agentId}`, { method: "DELETE" });
  if (!r.ok) throw new Error(await r.text());
}

// ─── Guild Agents ──────────────────────────────────────

export async function listGuildAgents(): Promise<GuildAgent[]> {
  const r = await fetch(`${BASE}/guild/agents`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function createGuildAgent(payload: Omit<GuildAgent, "id" | "status" | "currentTaskId" | "createdAt" | "updatedAt" | "stats">): Promise<GuildAgent> {
  const r = await fetch(`${BASE}/guild/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getGuildAgent(agentId: string): Promise<GuildAgent> {
  const r = await fetch(`${BASE}/guild/agents/${agentId}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function updateGuildAgent(agentId: string, payload: Partial<Omit<GuildAgent, "id" | "createdAt" | "updatedAt" | "stats">>): Promise<GuildAgent> {
  const r = await fetch(`${BASE}/guild/agents/${agentId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function deleteGuildAgent(agentId: string): Promise<void> {
  const r = await fetch(`${BASE}/guild/agents/${agentId}`, { method: "DELETE" });
  if (!r.ok) throw new Error(await r.text());
}

export async function releaseGuildAgent(agentId: string): Promise<{ success: boolean; releasedTaskId: string | null }> {
  const r = await fetch(`${BASE}/guild/agents/${agentId}/release`, { method: "POST" });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getAgentMemories(agentId: string): Promise<AgentMemory[]> {
  const r = await fetch(`${BASE}/guild/agents/${agentId}/memories`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getAgentStats(agentId: string): Promise<AgentStats> {
  const r = await fetch(`${BASE}/guild/agents/${agentId}/stats`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function addAgentAsset(agentId: string, payload: { type: AssetType; name: string; uri: string; description?: string; metadata?: Record<string, unknown> }): Promise<AgentAsset> {
  const r = await fetch(`${BASE}/guild/agents/${agentId}/assets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function removeAgentAsset(agentId: string, assetId: string): Promise<void> {
  const r = await fetch(`${BASE}/guild/agents/${agentId}/assets/${assetId}`, { method: "DELETE" });
  if (!r.ok) throw new Error(await r.text());
}

export async function updateAgentAsset(
  agentId: string,
  assetId: string,
  updates: { name?: string; uri?: string; description?: string; tags?: string[]; metadata?: Record<string, unknown> },
): Promise<unknown> {
  const r = await fetch(`${BASE}/guild/agents/${agentId}/assets/${assetId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function updateGroupAssetApi(
  groupId: string,
  assetId: string,
  updates: { name?: string; uri?: string; description?: string; tags?: string[]; metadata?: Record<string, unknown> },
): Promise<unknown> {
  const r = await fetch(`${BASE}/guild/groups/${groupId}/assets/${assetId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ─── Tasks ─────────────────────────────────────────────

export async function getGroupTasks(groupId: string): Promise<GuildTask[]> {
  const r = await fetch(`${BASE}/guild/groups/${groupId}/tasks`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function createGroupTask(groupId: string, payload: { title: string; description: string; priority?: GuildTask["priority"]; dependsOn?: string[]; kind?: GuildTask["kind"]; acceptanceCriteria?: string; suggestedSkills?: string[]; suggestedAgentId?: string; parentTaskId?: string }): Promise<GuildTask> {
  const r = await fetch(`${BASE}/guild/groups/${groupId}/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function listPipelines(): Promise<PipelineTemplate[]> {
  const r = await fetch(`${BASE}/guild/pipelines`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function createPipeline(tpl: PipelineTemplate): Promise<PipelineTemplate> {
  const r = await fetch(`${BASE}/guild/pipelines`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(tpl),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function updatePipeline(id: string, tpl: PipelineTemplate): Promise<PipelineTemplate> {
  const r = await fetch(`${BASE}/guild/pipelines/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(tpl),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function deletePipeline(id: string): Promise<void> {
  const r = await fetch(`${BASE}/guild/pipelines/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(await r.text());
}

export async function createTaskFromPipeline(
  groupId: string,
  payload: { pipelineId: string; inputs: Record<string, string>; title?: string; priority?: GuildTask["priority"] },
): Promise<{ task: GuildTask; subtaskIds: string[] }> {
  const r = await fetch(`${BASE}/guild/groups/${groupId}/tasks/from-pipeline`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function updateGuildTask(taskId: string, groupId: string, payload: Partial<Pick<GuildTask, "title" | "description" | "priority" | "status">>): Promise<GuildTask> {
  const r = await fetch(`${BASE}/guild/tasks/${taskId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, groupId }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function deleteGuildTask(taskId: string, groupId?: string): Promise<void> {
  const qs = groupId ? `?groupId=${encodeURIComponent(groupId)}` : "";
  const r = await fetch(`${BASE}/guild/tasks/${taskId}${qs}`, { method: "DELETE" });
  if (!r.ok) throw new Error(await r.text());
}

export async function clearTaskRejections(taskId: string, groupId?: string): Promise<GuildTask> {
  const qs = groupId ? `?groupId=${encodeURIComponent(groupId)}` : "";
  const r = await fetch(`${BASE}/guild/tasks/${taskId}/clear-rejections${qs}`, { method: "POST" });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function autoBidTask(groupId: string, taskId: string): Promise<{ assigned: boolean; bid?: import("../types/guild").TaskBid; message?: string }> {
  const r = await fetch(`${BASE}/guild/groups/${groupId}/autobid`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskId }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getTaskExecutionLog(groupId: string, taskId: string): Promise<{
  taskId: string; agentId: string; events: Array<{ type: string; content: string; tool?: string; args?: string; timestamp: string }>;
  status: string; startedAt: string; completedAt?: string;
}> {
  const r = await fetch(`${BASE}/guild/groups/${groupId}/tasks/${taskId}/logs`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function clearGroupSchedulerLog(groupId: string): Promise<void> {
  const r = await fetch(`${BASE}/guild/groups/${groupId}/scheduler-log`, { method: "DELETE" });
  if (!r.ok) throw new Error(await r.text());
}

export async function assignGroupTask(groupId: string, taskId: string, agentId: string): Promise<GuildTask> {
  const r = await fetch(`${BASE}/guild/groups/${groupId}/assign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskId, agentId }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ─── Group Lead / Assets / Workspace ───────────────────

export async function setGroupLead(groupId: string, agentId: string | null): Promise<Group> {
  const r = await fetch(`${BASE}/guild/groups/${groupId}/lead`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function listGroupAssets(groupId: string): Promise<{ groupAssets: AgentAsset[]; aggregated: AgentAsset[] }> {
  const r = await fetch(`${BASE}/guild/groups/${groupId}/assets`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function addGroupAsset(groupId: string, payload: { type: AssetType; name: string; uri: string; description?: string; metadata?: Record<string, unknown>; ownerAgentId?: string; tags?: string[] }): Promise<AgentAsset> {
  const r = await fetch(`${BASE}/guild/groups/${groupId}/assets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function removeGroupAsset(groupId: string, assetId: string): Promise<void> {
  const r = await fetch(`${BASE}/guild/groups/${groupId}/assets/${assetId}`, { method: "DELETE" });
  if (!r.ok) throw new Error(await r.text());
}

export async function getTaskWorkspaceRaw(groupId: string, taskId: string): Promise<string> {
  const r = await fetch(`${BASE}/guild/groups/${groupId}/tasks/${taskId}/workspace?format=raw`);
  if (!r.ok) throw new Error(await r.text());
  return r.text();
}

export async function readGuildArtifactFile(path: string): Promise<{ content?: string; binary?: boolean; size: number; ext: string }> {
  const r = await fetch(`${BASE}/guild/file?path=${encodeURIComponent(path)}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getTaskWorkspaceParsed(groupId: string, taskId: string): Promise<{
  goal?: string;
  scope?: string;
  plan?: Array<{ id: string; title: string; owner?: string; status?: string }>;
  decisions?: string[];
  openQuestions?: string[];
  handoffs?: Array<{ fromTaskId: string; content: string }>;
}> {
  const r = await fetch(`${BASE}/guild/groups/${groupId}/tasks/${taskId}/workspace?format=parsed`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ─── Agent Workspace ──────────────────────────────────

export async function getAgentWorkspaceTree(agentId: string): Promise<FileTreeNode[]> {
  const r = await fetch(`${BASE}/guild/agents/${agentId}/workspace/tree`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getAgentWorkspaceFile(agentId: string, path: string): Promise<FileReadResult> {
  const r = await fetch(`${BASE}/guild/agents/${agentId}/workspace/file?path=${encodeURIComponent(path)}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ─── Agent Memory ─────────────────────────────────────

export async function getAgentMemoryTree(agentId: string): Promise<FileTreeNode[]> {
  const r = await fetch(`${BASE}/guild/agents/${agentId}/memory/tree`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getAgentMemoryFile(agentId: string, path: string): Promise<FileReadResult> {
  const r = await fetch(`${BASE}/guild/agents/${agentId}/memory/file?path=${encodeURIComponent(path)}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ─── Group Shared ─────────────────────────────────────

export async function getGroupSharedTree(groupId: string): Promise<FileTreeNode[]> {
  const r = await fetch(`${BASE}/guild/groups/${groupId}/shared/tree`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getGroupSharedFile(groupId: string, path: string): Promise<FileReadResult> {
  const r = await fetch(`${BASE}/guild/groups/${groupId}/shared/file?path=${encodeURIComponent(path)}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getGroupSharedManifest(groupId: string): Promise<Record<string, ArtifactManifestEntry>> {
  const r = await fetch(`${BASE}/guild/groups/${groupId}/shared/manifest`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
