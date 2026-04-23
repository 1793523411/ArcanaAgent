import type { GuildAgent, GuildTask, TaskBid, BiddingConfig, ScoreBreakdown } from "./types.js";
import { getGroup, getGroupAgents, getAggregatedGroupAssets } from "./guildManager.js";
import { searchRelevant } from "./memoryManager.js";
import { assignTask, getTask, updateTask, areDepsReady, findOutputConflicts } from "./taskBoard.js";
import { guildEventBus } from "./eventBus.js";
import { splitTokens } from "../lib/tokenizer.js";
import { getCachedSemanticScore } from "./embeddingScorer.js";
import { getCachedLlmScore } from "./llmScorer.js";

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
  const taskTokens = splitTokens(taskText);

  // 1. Asset match — strongest signal, token-normalized per asset. Take the
  //    top-3 asset scores and average them so agents with multiple relevant
  //    assets score higher than those with just one.
  const assetScores: number[] = [];
  for (const a of agent.assets) {
    const assetText = `${a.name} ${a.description ?? ""} ${a.uri}`.toLowerCase();
    const assetWords = splitTokens(assetText);
    if (assetWords.length === 0) continue;
    let matches = 0;
    for (const w of assetWords) {
      if (taskText.includes(w)) matches++;
    }
    const score = matches / assetWords.length;
    if (score > 0) assetScores.push(score);
  }
  assetScores.sort((a, b) => b - a);
  const topK = assetScores.slice(0, 3);
  const asset = topK.length > 0 ? topK.reduce((s, v) => s + v, 0) / topK.length : 0;

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
  // NOTE: partially overlaps with the asset dimension — will be obsoleted
  // when P1 embedding replaces both tokenized matchers.
  const hasDirectAsset = agent.assets.some((a) => {
    const assetText = `${a.name} ${a.description ?? ""}`.toLowerCase();
    const assetToks = splitTokens(assetText);
    return taskTokens.some((w) => assetToks.some((aw) => aw === w || assetText.includes(w)));
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
      const blobTokens = splitTokens(blob);
      return blobTokens.some((w) => taskText.includes(w));
    });
    if (ownedMatches.length > 0) {
      ownerBonus = biddingConfig.ownerBonusWeight ?? 0.5;
    }
  }

  // Load penalty — based on *current* load (working status + recent completions),
  // not lifetime tasksCompleted. This prevents veterans from being permanently
  // penalized. An agent currently executing a task gets a penalty; idle agents
  // with long histories don't.
  let loadPenalty = 0;
  const isCurrentlyBusy = agent.status === "working" || !!agent.currentTaskId;
  if (isCurrentlyBusy) {
    loadPenalty = 0.2;
  } else {
    // Mild penalty based on recent activity (last hour approximation via
    // stats — exact sliding window would require timestamps we don't store).
    // Only kicks in for very active agents to give others a chance.
    const recentProxy = Math.max(0, tasksDone - 10);
    if (recentProxy > 0) {
      loadPenalty = Math.min(0.15, recentProxy * 0.02);
    }
  }

  // When embedding score is available (pre-warmed by scheduler), it replaces
  // the token-based asset + skill dimensions with a single semantic similarity.
  // Weight budget: embedding absorbs asset (0.35) + skill (0.20) = 0.55.
  // Token-based asset/skill remain as fallback when embeddings aren't warmed.
  const embeddingScore = getCachedSemanticScore(agent.id, task.id);

  // LLM score (0-10) is the highest-quality signal when available.
  // It's warmed asynchronously before the bid loop for small groups (<10 agents).
  // When present, it absorbs the full semantic match budget (0.55), displacing
  // both embedding and token-based asset/skill dimensions.
  const llmResult = getCachedLlmScore(agent.id, task.id);
  const llmNormalized = llmResult !== null ? llmResult.score / 10 : null;

  // Narrow once — avoids non-null assertions downstream.
  const core =
    llmNormalized !== null
      ? llmNormalized * 0.55 + memory * 0.30 + success * 0.15
      : embeddingScore !== null
        ? embeddingScore * 0.55 + memory * 0.30 + success * 0.15
        : asset * 0.35 + memory * 0.30 + skill * 0.20 + success * 0.15;

  // assetBonus is redundant when a semantic scorer (LLM or embedding) is used.
  const usedSemanticScorer = llmNormalized !== null || embeddingScore !== null;
  const effectiveAssetBonus = usedSemanticScorer ? 0 : assetBonus;
  const final = Math.max(0, Math.min(1, core + effectiveAssetBonus + ownerBonus - loadPenalty));

  return {
    asset,
    memory,
    skill,
    success,
    ownerBonus,
    assetBonus: effectiveAssetBonus,
    loadPenalty,
    threshold: 0, // filled in by evaluateTask once priority is known
    final,
    embedding: embeddingScore ?? undefined,
    llmScore: llmResult?.score,
    llmReason: llmResult?.reason,
  };
}

/** Back-compat shim — returns only the final score. */
export function calculateConfidence(agent: GuildAgent, task: GuildTask): number {
  return calculateConfidenceBreakdown(agent, task, task.groupId).final;
}

/** Newbie grace — new agents (< this many completed tasks) get a halved
 *  threshold so they have a chance to prove themselves. Without this, asset /
 *  memory / embedding scores all start near zero and the agent never gets
 *  picked, which turns the "cold start" problem into a permanent exclusion. */
const NEWBIE_TASK_COUNT = 3;
const NEWBIE_THRESHOLD_MULTIPLIER = 0.5;

/** Single agent evaluates a task and produces a bid.
 *
 *  `opts.includeBelowThreshold` — when true, returns a bid for candidates
 *  that would normally be filtered out by threshold. The caller distinguishes
 *  winners from also-rans via the returned bid's `via` field. Used by the UI
 *  path so users can see *why* a given agent wasn't selected. */
export function evaluateTask(
  agent: GuildAgent,
  task: GuildTask,
  opts?: { includeBelowThreshold?: boolean },
): TaskBid | null {
  // Requirement-kind tasks are routed to the planner, never bid on.
  if (biddingConfig.skipParentRequirement && (task.kind === "requirement" || task.kind === "pipeline")) return null;
  // Retry backoff gate — task is technically open but must wait.
  if (task.retryAt && Date.parse(task.retryAt) > Date.now()) return null;
  // Subtasks with unmet deps are not biddable yet.
  if (!areDepsReady(task.groupId, task)) return null;
  // Collaborative-mode artifact lock — if another in-progress task declares
  // the same output ref, serialize by waiting. Isolated mode writes to a
  // per-task directory, so overlapping refs there aren't real conflicts.
  const group = getGroup(task.groupId);
  if (group?.artifactStrategy === "collaborative") {
    const conflicts = findOutputConflicts(task.groupId, task);
    if (conflicts.some((c) => c.status === "in_progress")) return null;
  }
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
  let threshold = Math.max(0.1, Math.min(0.95, biddingConfig.minConfidenceThreshold + thresholdDelta));
  // Newbie grace period — halve the bar until the agent has a track record.
  if (agent.stats.tasksCompleted < NEWBIE_TASK_COUNT) {
    threshold = threshold * NEWBIE_THRESHOLD_MULTIPLIER;
  }
  breakdown.threshold = threshold;
  const belowThreshold = confidence < threshold;
  if (belowThreshold && !opts?.includeBelowThreshold) return null;

  const relevantMemories = searchRelevant(agent.id, `${task.title} ${task.description}`, 3);
  const relevantAssets = agent.assets
    .filter((a) => {
      const assetText = `${a.name} ${a.description ?? ""}`.toLowerCase();
      const tTokens = splitTokens(`${task.title} ${task.description}`.toLowerCase());
      return tTokens.some((w) => assetText.includes(w));
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
    via: belowThreshold ? "below_threshold" : "bidding",
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

/** Select the winning bid from a list of bids. Explicitly ignores candidates
 *  that were kept around for transparency (via = below_threshold) so the
 *  winner is always a genuine passer. */
export function selectWinner(bids: TaskBid[]): TaskBid | null {
  const eligible = bids.filter((b) => b.via !== "below_threshold");
  if (eligible.length === 0) return null;
  const sorted = [...eligible].sort((a, b) => b.confidence - a.confidence);
  return sorted[0];
}

/** Run the full bidding process for a task within a group.
 *  Returns ALL evaluated candidates — both winners and those that didn't
 *  clear the threshold (tagged via="below_threshold"). The UI uses the
 *  rejected ones to explain *why* no one was picked / why a specific agent
 *  wasn't chosen; autoBid passes them along to `task.bids` so they persist. */
export function startBidding(groupId: string, task: GuildTask): TaskBid[] {
  const agents = getGroupAgents(groupId);
  const rejected = new Set(task._rejectedBy ?? []);
  const eligibleAgents = agents.filter(
    (a) => a.status === "idle" && !a.currentTaskId && !rejected.has(a.id)
  );

  guildEventBus.emit({
    type: "task_bidding_start",
    taskId: task.id,
    agents: eligibleAgents.map((a) => a.id),
  });

  const bids: TaskBid[] = [];
  for (const agent of eligibleAgents) {
    // includeBelowThreshold=true so the returned list covers every candidate;
    // selectWinner filters down to those actually qualifying.
    const bid = evaluateTask(agent, task, { includeBelowThreshold: true });
    if (bid) bids.push(bid);
  }
  return bids;
}

/** Keep task.bids bounded. All qualifying bids (bidding/fallback) are kept;
 *  below_threshold candidates are pruned to the top N by confidence. Prevents
 *  unbounded growth when a big group repeatedly stalls or retries. */
const MAX_BELOW_THRESHOLD_BIDS = 10;
function capBids(bids: TaskBid[]): TaskBid[] {
  const qualifying: TaskBid[] = [];
  const below: TaskBid[] = [];
  for (const b of bids) (b.via === "below_threshold" ? below : qualifying).push(b);
  below.sort((a, b) => b.confidence - a.confidence);
  return [...qualifying, ...below.slice(0, MAX_BELOW_THRESHOLD_BIDS)];
}

/** Identify the weakest contribution dimension in a bid's breakdown so the
 *  stalled-dispatch message can hint at *why* the agent didn't clear the
 *  threshold. Picks among whichever scoring path was active. */
function findBottleneck(bid: TaskBid): string | null {
  const sb = bid.scoreBreakdown;
  if (!sb) return null;
  const candidates: Array<{ name: string; contribution: number }> = [];
  if (sb.llmScore != null) {
    candidates.push({ name: "LLM 评分", contribution: (sb.llmScore / 10) * 0.55 });
  } else if (sb.embedding != null) {
    candidates.push({ name: "语义匹配", contribution: sb.embedding * 0.55 });
  } else {
    candidates.push({ name: "资产匹配", contribution: sb.asset * 0.35 });
    candidates.push({ name: "技能匹配", contribution: sb.skill * 0.20 });
  }
  candidates.push({ name: "记忆匹配", contribution: sb.memory * 0.30 });
  candidates.push({ name: "历史胜率", contribution: sb.success * 0.15 });
  candidates.sort((a, b) => a.contribution - b.contribution);
  return candidates[0]?.name ?? null;
}

// ─── Cross-group dedup lock ────────────────────────────────────
// Prevents concurrent autoBid calls for the same task across different
// groups (e.g. an agent shared between groups triggering two schedulers).
const biddingInFlight = new Set<string>();

/** Run bidding and auto-assign the winner. Returns the winning bid or null.
 *  If no bid meets threshold, falls back to suggestedAgentId if available;
 *  otherwise emits a stalled notification for manual assignment instead of
 *  force-assigning a random agent (which pollutes successRate).
 *  At most one disk write per call. */
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
  if (biddingConfig.skipParentRequirement && (fresh.kind === "requirement" || fresh.kind === "pipeline")) return null;
  if (fresh.retryAt && Date.parse(fresh.retryAt) > Date.now()) return null;
  // Subtasks with unmet deps must wait for upstream completion.
  if (!areDepsReady(groupId, fresh)) return null;

  // Cross-group dedup: task IDs are globally unique (UUID), so locking on
  // the bare task id guarantees only one autoBid runs per task even if two
  // schedulers from different groups race.
  const lockKey = fresh.id;
  if (biddingInFlight.has(lockKey)) return null;
  biddingInFlight.add(lockKey);
  try {
    return autoBidInner(groupId, fresh);
  } finally {
    biddingInFlight.delete(lockKey);
  }
}

function autoBidInner(groupId: string, fresh: GuildTask): TaskBid | null {
  const bids = startBidding(groupId, fresh);
  const winner = selectWinner(bids);

  if (winner) {
    assignTask(groupId, fresh.id, winner.agentId, winner, capBids(bids));
    return winner;
  }

  // No bid met threshold. Smart fallback:
  //  1. suggestedAgentId (Lead's recommendation) → auto-assign
  //  2. Exactly one idle agent → assign (no ambiguity)
  //  3. Multiple idle agents, none scored well → emit stalled, let user decide
  const agents = getGroupAgents(groupId);
  const rejectedSet = new Set(fresh._rejectedBy ?? []);
  const idleAgents = agents.filter((a) => a.status === "idle" && !a.currentTaskId && !rejectedSet.has(a.id));

  if (idleAgents.length === 0) {
    if (bids.length > 0) updateTask(groupId, fresh.id, { bids: capBids(bids) });
    return null;
  }

  // Pick the best fallback candidate: suggested > sole idle > stalled
  const suggested = fresh.suggestedAgentId
    ? idleAgents.find((a) => a.id === fresh.suggestedAgentId)
    : undefined;
  const picked = suggested ?? (idleAgents.length === 1 ? idleAgents[0] : undefined);

  if (picked) {
    const reasoning = suggested
      ? `自动回退分配：无 Agent 达到竞标门槛，按 Lead 推荐分配给 ${picked.name}`
      : `自动回退分配：无 Agent 达到竞标门槛，组内唯一空闲 Agent`;
    const fallbackBid: TaskBid = {
      agentId: picked.id,
      taskId: fresh.id,
      confidence: suggested ? 0.3 : 0.1,
      reasoning,
      estimatedComplexity: "medium",
      relevantAssets: [],
      relevantMemories: [],
      biddedAt: new Date().toISOString(),
      via: "fallback",
    };
    assignTask(groupId, fresh.id, picked.id, fallbackBid, capBids([...bids, fallbackBid]));
    return fallbackBid;
  }

  // Multiple idle agents, none scored well — emit stalled for manual assignment.
  if (bids.length > 0) updateTask(groupId, fresh.id, { bids: capBids(bids) });
  // Pick the top candidate to surface as "close but no cigar" in the log, so
  // the user can see which dimension held them back.
  const topCandidate = bids
    .slice()
    .sort((a, b) => b.confidence - a.confidence)[0];
  const bottleneck = topCandidate ? findBottleneck(topCandidate) : null;
  const topScore = topCandidate ? topCandidate.confidence.toFixed(2) : "0";
  const thresholdText = topCandidate?.scoreBreakdown
    ? `，门槛 ${topCandidate.scoreBreakdown.threshold.toFixed(2)}`
    : "";
  const bottleneckText = bottleneck ? `，瓶颈：${bottleneck}` : "";
  guildEventBus.emit({
    type: "scheduler_dispatch_stalled",
    groupId,
    openTaskCount: 1,
    message: `任务「${fresh.title}」无 Agent 达到竞标门槛，请手动指派`,
    schedulerLogEntry: {
      id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
      kind: "stalled",
      groupId,
      taskId: fresh.id,
      taskTitle: fresh.title,
      message: `任务「${fresh.title}」无 Agent 达到竞标门槛（最高分 ${topScore}${thresholdText}${bottleneckText}，空闲 ${idleAgents.length} 人），等待手动指派`,
    },
  });
  return null;
}
