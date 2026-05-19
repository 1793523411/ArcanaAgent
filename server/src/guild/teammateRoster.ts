import type { GuildAgent, AgentAsset } from "./types.js";
import { getGroup, getGroupAgents, getAggregatedGroupAssets } from "./guildManager.js";

/**
 * Render a markdown roster of teammates for injection into a specialist's prompt.
 * The roster teaches each agent who its colleagues are and what each owns, so
 * an agent can escalate out-of-scope work back to the lead instead of doing it
 * themselves.
 */
export function buildTeammateRoster(groupId: string, excludeAgentId?: string): string {
  const group = getGroup(groupId);
  if (!group) return "";

  const agents = getGroupAgents(groupId);
  const aggregated = getAggregatedGroupAssets(groupId);
  const ownedByAgent = new Map<string, AgentAsset[]>();
  for (const asset of aggregated) {
    if (!asset.ownerAgentId) continue;
    const bucket = ownedByAgent.get(asset.ownerAgentId) ?? [];
    bucket.push(asset);
    ownedByAgent.set(asset.ownerAgentId, bucket);
  }

  const lines: string[] = [];
  lines.push(`## Your Teammates in "${group.name}"`);
  if (group.leadAgentId) {
    const lead = agents.find((a) => a.id === group.leadAgentId);
    if (lead) {
      lines.push(`- 🧭 **${lead.name}** (Tech Lead): ${oneLiner(lead)}`);
    }
  }

  const specialists = agents.filter((a) => a.id !== group.leadAgentId && a.id !== excludeAgentId);
  for (const a of specialists) {
    const owned = ownedByAgent.get(a.id) ?? [];
    const ownedStr = owned.length > 0
      ? ` · owns ${owned.map((o) => `\`${o.name}\``).join(", ")}`
      : "";
    lines.push(`- **${a.name}**: ${oneLiner(a)}${ownedStr}`);
  }

  if (specialists.length === 0) {
    lines.push(`- _(你目前是唯一的 specialist)_`);
  }

  lines.push("");
  lines.push(`## Collaboration Rules`);
  lines.push(`- 优先读取上方 Workspace 的 Handoffs 段，了解上游同事给你的输入。`);
  lines.push(`- 如果当前子任务里含有不属于你负责领域或仓库的工作，**不要硬做**。在 result 里写清楚"哪部分需要谁"，Lead 会补发新子任务给对应同事。`);
  lines.push(`- 执行完成时必须产出结构化 handoff：做了什么、涉及哪些 commit/文件/URL、留给下游什么问题。`);
  lines.push(`- 小组是一个有机整体，不要与队友重复劳动；读 workspace 避免撞车。`);
  return lines.join("\n");
}

function oneLiner(agent: GuildAgent): string {
  const desc = (agent.description ?? "").replace(/\s+/g, " ").trim();
  const skills = agent.skills.length > 0 ? ` [${agent.skills.slice(0, 5).join(", ")}]` : "";
  const assetTags = agent.assets
    .flatMap((a) => a.tags ?? [])
    .filter((t, i, arr) => arr.indexOf(t) === i)
    .slice(0, 5);
  const tagStr = assetTags.length > 0 ? ` · tags: ${assetTags.join(", ")}` : "";
  return `${desc || "(无描述)"}${skills}${tagStr}`;
}
