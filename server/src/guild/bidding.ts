import type { GuildAgent, GuildTask, TaskBid, BiddingConfig } from "./types.js";
import { getGroupAgents } from "./guildManager.js";
import { searchRelevant } from "./memoryManager.js";
import { assignTask } from "./taskBoard.js";
import { guildEventBus } from "./eventBus.js";

const DEFAULT_CONFIG: BiddingConfig = {
  maxConcurrentTasks: 1,
  loadDecayFactor: 0.9,
  assetBonusWeight: 0.15,
  taskTimeoutMs: 10 * 60 * 1000, // 10 minutes
  minConfidenceThreshold: 0.3,
};

let biddingConfig: BiddingConfig = { ...DEFAULT_CONFIG };

export function setBiddingConfig(config: Partial<BiddingConfig>): void {
  biddingConfig = { ...biddingConfig, ...config };
}

export function getBiddingConfig(): BiddingConfig {
  return { ...biddingConfig };
}

/** Calculate confidence score for an agent on a task */
export function calculateConfidence(agent: GuildAgent, task: GuildTask): number {
  let score = 0;
  const taskText = `${task.title} ${task.description}`.toLowerCase();

  // 1. Asset match (40%)
  let assetScore = 0;
  if (agent.assets.length > 0) {
    for (const asset of agent.assets) {
      const assetText = `${asset.name} ${asset.description ?? ""} ${asset.uri}`.toLowerCase();
      const assetWords = assetText.split(/[\s/\\._-]+/).filter((w) => w.length > 2);
      let matchCount = 0;
      for (const word of assetWords) {
        if (taskText.includes(word)) matchCount++;
      }
      if (assetWords.length > 0) {
        assetScore = Math.max(assetScore, matchCount / assetWords.length);
      }
    }
  }
  score += assetScore * 0.4;

  // 2. Memory relevance (30%)
  const relevantMemories = searchRelevant(agent.id, `${task.title} ${task.description}`, 5);
  const memoryScore = relevantMemories.length > 0
    ? Math.min(relevantMemories.length / 5, 1)
    : 0;
  score += memoryScore * 0.3;

  // 3. Skill / prompt match (20%)
  const promptText = `${agent.systemPrompt} ${agent.description} ${agent.skills.join(" ")}`.toLowerCase();
  const taskWords = taskText.split(/[\s,;.!?]+/).filter((w) => w.length > 2);
  let skillMatchCount = 0;
  for (const word of taskWords) {
    if (promptText.includes(word)) skillMatchCount++;
  }
  const skillScore = taskWords.length > 0 ? Math.min(skillMatchCount / taskWords.length, 1) : 0;
  score += skillScore * 0.2;

  // 4. Historical success rate (10%)
  score += (agent.stats.successRate ?? 0) * 0.1;

  // Asset direct match bonus
  const hasDirectAsset = agent.assets.some((a) => {
    const assetText = `${a.name} ${a.description ?? ""}`.toLowerCase();
    return taskText.split(/\s+/).some((w) => w.length > 3 && assetText.includes(w));
  });
  if (hasDirectAsset) {
    score += biddingConfig.assetBonusWeight;
  }

  // Load decay penalty: consecutive tasks reduce score
  const recentTasks = agent.stats.tasksCompleted;
  if (recentTasks > 3) {
    const decay = Math.pow(biddingConfig.loadDecayFactor, recentTasks - 3);
    score *= decay;
  }

  return Math.min(score, 1.0);
}

/** Single agent evaluates a task and produces a bid */
export function evaluateTask(agent: GuildAgent, task: GuildTask): TaskBid | null {
  // Skip if agent is busy
  if (agent.status === "working" || agent.currentTaskId) return null;
  if (agent.status === "offline") return null;

  const confidence = calculateConfidence(agent, task);

  // Below threshold — don't bid
  if (confidence < biddingConfig.minConfidenceThreshold) return null;

  const relevantMemories = searchRelevant(agent.id, `${task.title} ${task.description}`, 3);
  const relevantAssets = agent.assets
    .filter((a) => {
      const assetText = `${a.name} ${a.description ?? ""}`.toLowerCase();
      const taskText = `${task.title} ${task.description}`.toLowerCase();
      return taskText.split(/\s+/).some((w) => w.length > 3 && assetText.includes(w));
    })
    .map((a) => a.id);

  // Estimate complexity based on description length and keywords
  const desc = task.description.toLowerCase();
  let estimatedComplexity: "low" | "medium" | "high" = "medium";
  if (desc.length < 50 || /简单|simple|quick|fix|typo/.test(desc)) {
    estimatedComplexity = "low";
  } else if (desc.length > 200 || /重构|refactor|架构|architecture|migration|迁移/.test(desc)) {
    estimatedComplexity = "high";
  }

  return {
    agentId: agent.id,
    taskId: task.id,
    confidence,
    reasoning: buildReasoning(agent, relevantAssets.length, relevantMemories.length, confidence),
    estimatedComplexity,
    relevantAssets,
    relevantMemories: relevantMemories.map((m) => m.id),
    biddedAt: new Date().toISOString(),
  };
}

function buildReasoning(agent: GuildAgent, assetCount: number, memoryCount: number, confidence: number): string {
  const parts: string[] = [];
  if (assetCount > 0) parts.push(`持有 ${assetCount} 个相关资产`);
  if (memoryCount > 0) parts.push(`有 ${memoryCount} 条相关经验`);
  if (agent.stats.tasksCompleted > 0) {
    parts.push(`已完成 ${agent.stats.tasksCompleted} 个任务，成功率 ${Math.round(agent.stats.successRate * 100)}%`);
  }
  if (parts.length === 0) parts.push("基于角色技能匹配");
  return `confidence: ${confidence.toFixed(2)} — ${parts.join("，")}`;
}

/** Select the winning bid from a list of bids */
export function selectWinner(bids: TaskBid[]): TaskBid | null {
  if (bids.length === 0) return null;
  // Sort by confidence descending
  const sorted = [...bids].sort((a, b) => b.confidence - a.confidence);
  return sorted[0];
}

/** Run the full bidding process for a task within a group */
export function startBidding(groupId: string, task: GuildTask): TaskBid[] {
  const agents = getGroupAgents(groupId);
  const eligibleAgents = agents.filter(
    (a) => a.status === "idle" && !a.currentTaskId
  );

  guildEventBus.emit({
    type: "task_bidding_start",
    taskId: task.id,
    agents: eligibleAgents.map((a) => a.id),
  });

  const bids: TaskBid[] = [];
  for (const agent of eligibleAgents) {
    const bid = evaluateTask(agent, task);
    if (bid) bids.push(bid);
  }

  return bids;
}

/** Run bidding and auto-assign the winner. Returns the winning bid or null.
 *  If no bid meets threshold but idle agents exist, falls back to a random idle agent. */
export function autoBid(groupId: string, task: GuildTask): TaskBid | null {
  const bids = startBidding(groupId, task);
  const winner = selectWinner(bids);

  if (winner) {
    assignTask(groupId, task.id, winner.agentId, winner);
    return winner;
  }

  // Fallback: no bid met threshold — assign to a random idle agent in the group
  const agents = getGroupAgents(groupId);
  const idleAgents = agents.filter((a) => a.status === "idle" && !a.currentTaskId);
  if (idleAgents.length === 0) return null;

  const picked = idleAgents[Math.floor(Math.random() * idleAgents.length)];
  const fallbackBid: TaskBid = {
    agentId: picked.id,
    taskId: task.id,
    confidence: 0.1,
    reasoning: "自动回退分配：无 Agent 达到竞标门槛，随机选择空闲 Agent",
    estimatedComplexity: "medium",
    relevantAssets: [],
    relevantMemories: [],
    biddedAt: new Date().toISOString(),
  };
  assignTask(groupId, task.id, picked.id, fallbackBid);
  return fallbackBid;
}
