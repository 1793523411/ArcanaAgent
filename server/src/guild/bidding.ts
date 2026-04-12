import type { GuildAgent, GuildTask, TaskBid, BiddingConfig, ScoreBreakdown } from "./types.js";
import { getGroupAgents, getAggregatedGroupAssets } from "./guildManager.js";
import { searchRelevant } from "./memoryManager.js";
import { assignTask, getTask, updateTask, areDepsReady } from "./taskBoard.js";
import { guildEventBus } from "./eventBus.js";

const DEFAULT_CONFIG: BiddingConfig = {
  maxConcurrentTasks: 1,
  loadDecayFactor: 0.9,
  assetBonusWeight: 0.15,
  taskTimeoutMs: 10 * 60 * 1000, // 10 minutes
  minConfidenceThreshold: 0.3,
  ownerBonusWeight: 0.5,
  successRatePrior: 0.5,
  skipParentRequirement: true,
};

let biddingConfig: BiddingConfig = { ...DEFAULT_CONFIG };

export function setBiddingConfig(config: Partial<BiddingConfig>): void {
  biddingConfig = { ...biddingConfig, ...config };
}

export function getBiddingConfig(): BiddingConfig {
  return { ...biddingConfig };
}

/** Calculate confidence score for an agent on a task, returning the full breakdown.
 *  Priority influence happens via the *threshold* in `evaluateTask`, not by inflating
 *  the score (which would bunch everything at 1.0).
 *
 *  Dimensions (all 0..1 before weighting):
 *    asset (0.35): per-asset token overlap with the task text
 *    memory (0.25): relevance hits against the agent's memory store
 *    skill (0.20): token overlap between task and agent prompt/skills
 *    success (0.10): historical success rate, with a prior for cold-start agents
 *    ownerBonus: extra weight when the agent is the explicit owner of a group asset
 *                that matches the task (prevents "wrong specialist wins" bug)
 *    assetBonus: flat boost when any agent asset hard-matches a task word (>3 chars)
 *    loadPenalty: only subtracts from the final score, never zeros it out
 */
export function calculateConfidenceBreakdown(
  agent: GuildAgent,
  task: GuildTask,
  groupId?: string,
): ScoreBreakdown {
  const taskText = `${task.title} ${task.description}`.toLowerCase();
  const taskTokens = taskText.split(/[\s,;.!?]+/).filter((w) => w.length > 2);

  // 1. Asset match — strongest signal, but token-normalized so big asset blobs
  //    don't dominate. Take the max over the agent's assets.
  let asset = 0;
  for (const a of agent.assets) {
    const assetText = `${a.name} ${a.description ?? ""} ${a.uri}`.toLowerCase();
    const assetWords = assetText.split(/[\s/\\._-]+/).filter((w) => w.length > 2);
    if (assetWords.length === 0) continue;
    let matches = 0;
    for (const w of assetWords) {
      if (taskText.includes(w)) matches++;
    }
    asset = Math.max(asset, matches / assetWords.length);
  }

  // 2. Memory relevance — capped at 5 hits.
  const memHits = searchRelevant(agent.id, `${task.title} ${task.description}`, 5);
  const memory = memHits.length > 0 ? Math.min(memHits.length / 5, 1) : 0;

  // 3. Skill / prompt match — normalized by *distinct* task tokens so longer
  //    task descriptions don't punish shorter agent prompts.
  const promptText = `${agent.systemPrompt} ${agent.description} ${agent.skills.join(" ")}`.toLowerCase();
  const uniqTaskTokens = Array.from(new Set(taskTokens));
  let skillHits = 0;
  for (const w of uniqTaskTokens) {
    if (promptText.includes(w)) skillHits++;
  }
  const skill = uniqTaskTokens.length > 0 ? Math.min(skillHits / uniqTaskTokens.length, 1) : 0;

  // 4. Historical success with a prior. New agents (0 tasks) start at the prior
  //    (typically 0.5) so they don't get punished for being cold-start; after a
  //    few tasks the agent's own stats dominate (Laplace-style smoothing).
  const tasksDone = agent.stats.tasksCompleted;
  const prior = biddingConfig.successRatePrior ?? 0.5;
  const priorStrength = 3;
  const success = tasksDone > 0
    ? (agent.stats.successRate * tasksDone + prior * priorStrength) / (tasksDone + priorStrength)
    : prior;

  // Flat asset-word bonus (existing behavior, now returned as its own dim).
  const hasDirectAsset = agent.assets.some((a) => {
    const assetText = `${a.name} ${a.description ?? ""}`.toLowerCase();
    return taskText.split(/\s+/).some((w) => w.length > 3 && assetText.includes(w));
  });
  const assetBonus = hasDirectAsset ? biddingConfig.assetBonusWeight : 0;

  // Owner bonus — if the aggregated group asset pool contains an asset owned
  // by *this* agent that matches the task, that agent is the natural fit for
  // the task. This is what prevents "repo:backend task" going to the frontend
  // specialist just because their prompt happens to mention auth.
  let ownerBonus = 0;
  if (groupId) {
    const aggregated = getAggregatedGroupAssets(groupId);
    const ownedMatches = aggregated.filter((a) => {
      if (a.ownerAgentId !== agent.id) return false;
      const blob = `${a.name} ${a.description ?? ""} ${(a.tags ?? []).join(" ")}`.toLowerCase();
      const blobWords = blob.split(/[\s/\\._-]+/).filter((w) => w.length > 2);
      return blobWords.some((w) => taskText.includes(w));
    });
    if (ownedMatches.length > 0) {
      ownerBonus = biddingConfig.ownerBonusWeight ?? 0.5;
    }
  }

  // Load penalty — only as a subtractive hit on the final score, not a
  // multiplier on the whole thing (which killed successRate contribution
  // for veterans in the old formula).
  let loadPenalty = 0;
  if (tasksDone > 3) {
    const extra = tasksDone - 3;
    loadPenalty = Math.min(0.3, extra * (1 - biddingConfig.loadDecayFactor));
  }

  const core = asset * 0.35 + memory * 0.25 + skill * 0.2 + success * 0.1;
  const final = Math.max(0, Math.min(1, core + assetBonus + ownerBonus - loadPenalty));

  return {
    asset,
    memory,
    skill,
    success,
    ownerBonus,
    assetBonus,
    loadPenalty,
    threshold: 0, // filled in by evaluateTask once priority is known
    final,
  };
}

/** Back-compat shim — returns only the final score. */
export function calculateConfidence(agent: GuildAgent, task: GuildTask): number {
  return calculateConfidenceBreakdown(agent, task, task.groupId).final;
}

/** Single agent evaluates a task and produces a bid */
export function evaluateTask(agent: GuildAgent, task: GuildTask): TaskBid | null {
  // Requirement-kind tasks are routed to the planner, never bid on.
  if (biddingConfig.skipParentRequirement && task.kind === "requirement") return null;
  // Subtasks with unmet deps are not biddable yet.
  if (!areDepsReady(task.groupId, task)) return null;
  // Skip if agent is busy
  if (agent.status === "working" || agent.currentTaskId) return null;
  if (agent.status === "offline") return null;

  const breakdown = calculateConfidenceBreakdown(agent, task, task.groupId);
  const confidence = breakdown.final;

  // Priority-adjusted threshold — urgent work lowers the bar, low raises it.
  const thresholdDelta = task.priority === "urgent"
    ? -0.1
    : task.priority === "high"
      ? -0.05
      : task.priority === "low"
        ? 0.05
        : 0;
  const threshold = Math.max(0.1, Math.min(0.95, biddingConfig.minConfidenceThreshold + thresholdDelta));
  breakdown.threshold = threshold;
  if (confidence < threshold) return null;

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
    reasoning: buildReasoning(agent, relevantAssets.length, relevantMemories.length, confidence, breakdown),
    estimatedComplexity,
    relevantAssets,
    relevantMemories: relevantMemories.map((m) => m.id),
    biddedAt: new Date().toISOString(),
    scoreBreakdown: breakdown,
    via: "bidding",
  };
}

function buildReasoning(
  agent: GuildAgent,
  assetCount: number,
  memoryCount: number,
  confidence: number,
  breakdown: ScoreBreakdown,
): string {
  const parts: string[] = [];
  if (breakdown.ownerBonus > 0) parts.push(`是相关资产的 owner`);
  if (assetCount > 0) parts.push(`持有 ${assetCount} 个相关资产`);
  if (memoryCount > 0) parts.push(`有 ${memoryCount} 条相关经验`);
  if (agent.stats.tasksCompleted > 0) {
    parts.push(`已完成 ${agent.stats.tasksCompleted} 个任务，成功率 ${Math.round(agent.stats.successRate * 100)}%`);
  } else {
    parts.push(`新 agent（使用先验）`);
  }
  if (breakdown.loadPenalty > 0) parts.push(`load penalty -${breakdown.loadPenalty.toFixed(2)}`);
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

/** Run the full bidding process for a task within a group.
 *  Pure in-memory: collects bids and emits the start event but does NOT persist
 *  the intermediate "bidding" status — `autoBid` writes the final state in one go. */
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
 *  If no bid meets threshold but idle agents exist, falls back to a random idle agent.
 *  At most one disk write per call: either via `assignTask` (assigned path) or
 *  `updateTask` (no-idle-agents path). */
export function autoBid(groupId: string, task: GuildTask): TaskBid | null {
  const fresh = getTask(groupId, task.id) ?? task;
  if (
    fresh.status === "in_progress" ||
    fresh.status === "completed" ||
    fresh.status === "failed" ||
    fresh.status === "cancelled" ||
    fresh.status === "planning"
  ) {
    return null;
  }
  // Never bid on requirement-kind tasks — they belong to the planner.
  if (biddingConfig.skipParentRequirement && fresh.kind === "requirement") return null;
  // Subtasks with unmet deps must wait for upstream completion.
  if (!areDepsReady(groupId, fresh)) return null;

  const bids = startBidding(groupId, fresh);
  const winner = selectWinner(bids);

  if (winner) {
    assignTask(groupId, fresh.id, winner.agentId, winner, bids);
    return winner;
  }

  // No bid met threshold. Try fallback: random idle agent in the group.
  const agents = getGroupAgents(groupId);
  const idleAgents = agents.filter((a) => a.status === "idle" && !a.currentTaskId);
  if (idleAgents.length === 0) {
    // Persist bids so the UI can still show the evidence; status stays "open".
    if (bids.length > 0) updateTask(groupId, fresh.id, { bids });
    return null;
  }

  const picked = idleAgents[Math.floor(Math.random() * idleAgents.length)];
  const fallbackBid: TaskBid = {
    agentId: picked.id,
    taskId: fresh.id,
    confidence: 0.1,
    reasoning: "自动回退分配：无 Agent 达到竞标门槛，随机选择空闲 Agent",
    estimatedComplexity: "medium",
    relevantAssets: [],
    relevantMemories: [],
    biddedAt: new Date().toISOString(),
    via: "fallback",
  };
  assignTask(groupId, fresh.id, picked.id, fallbackBid, [...bids, fallbackBid]);
  return fallbackBid;
}
