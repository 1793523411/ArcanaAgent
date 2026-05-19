/**
 * LLM-based scorer: uses a lightweight model to evaluate agent-task fit.
 * Returns a 0-10 score with a short rationale.
 *
 * Flow:
 *   1. Caller invokes `warmLlmScores(agents, task)` before the synchronous bid loop.
 *   2. `getCachedLlmScore(agentId, taskId)` is called synchronously from bidding.ts.
 *   3. Results are cached per (agentId, taskId) and cleared after each bidding round.
 *
 * Design constraints:
 *   - 10-second timeout per call; falls back to null on failure.
 *   - Only used when group has fewer than 10 agents (latency control).
 *   - Uses the cheapest/fastest non-reasoning model available.
 */

import type { GuildAgent, GuildTask } from "./types.js";
import { serverLogger } from "../lib/logger.js";
import { getLLM } from "../llm/index.js";
import { loadUserConfig } from "../config/userConfig.js";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

// ─── Model selection ─────────────────────────────────────────────
/** Pick the LLM the user is already paying for. The previous hardcoded
 *  `deepseek:deepseek-chat` made round-trips to a non-Doubao provider on
 *  every bidding round even when the operator's whole stack was configured
 *  for Doubao — quietly leaking spend to a different account and breaking
 *  "I want everything to use Doubao" expectations. Override via env for
 *  ops experiments. */
function pickScorerModel(): string {
  const override = process.env.GUILD_LLM_SCORER_MODEL;
  if (override) return override;
  try {
    const cfg = loadUserConfig();
    if (cfg.modelId) return cfg.modelId;
  } catch { /* fall through */ }
  return "volcengine:doubao-seed-2-0-mini-260215";
}

// ─── Cache ───────────────────────────────────────────────────────
export interface LlmScoreResult {
  score: number;   // 0-10
  reason: string;
}

/** Pre-computed LLM scores — keyed by "agentId::taskId". */
const llmScoreCache = new Map<string, LlmScoreResult>();

// ─── Helpers ─────────────────────────────────────────────────────

/** Build a compact agent profile for the LLM prompt. */
function buildAgentProfile(agent: GuildAgent): string {
  const parts: string[] = [];
  if (agent.description) parts.push(`描述：${agent.description}`);
  if (agent.skills.length > 0) parts.push(`技能：${agent.skills.join("、")}`);
  if (agent.assets.length > 0) {
    const assetNames = agent.assets.map((a) => a.name).join("、");
    parts.push(`资产：${assetNames}`);
  }
  // Include a truncated system prompt (first 400 chars captures the role)
  const promptSnippet = agent.systemPrompt.slice(0, 400);
  if (promptSnippet) parts.push(`系统提示：${promptSnippet}`);
  return parts.join("\n");
}

/** Call the LLM and parse its JSON response with a hard timeout. */
async function callLlmScorer(
  agent: GuildAgent,
  task: GuildTask,
): Promise<LlmScoreResult | null> {
  const agentProfile = buildAgentProfile(agent);
  const taskText = `标题：${task.title}\n描述：${task.description}`;

  const systemPrompt = `你是一个任务匹配评分专家。请根据 Agent 的描述和任务内容，评估 Agent 完成该任务的适合程度。
只返回 JSON，格式：{ "score": <0到10的整数>, "reason": "<简短理由，15字以内>" }
score 含义：0=完全不匹配，5=一般匹配，10=非常契合。不要返回任何其他内容。`;

  const userPrompt = `Agent 信息：\n${agentProfile}\n\n任务信息：\n${taskText}`;

  const timeoutMs = 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const llm = getLLM(pickScorerModel());
    const messages = [
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt),
    ];

    const response = await llm.invoke(messages, {
      signal: controller.signal,
    });
    clearTimeout(timer);

    const content =
      typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);

    // Extract JSON from the response (may be wrapped in markdown code blocks)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      serverLogger.warn("[llmScorer] no JSON in response", {
        agentId: agent.id,
        taskId: task.id,
        content: content.slice(0, 200),
      });
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]) as { score?: unknown; reason?: unknown };
    const score = Number(parsed.score);
    if (Number.isNaN(score) || score < 0 || score > 10) {
      serverLogger.warn("[llmScorer] invalid score in response", {
        agentId: agent.id,
        taskId: task.id,
        parsed,
      });
      return null;
    }

    return {
      score: Math.round(score),
      reason: String(parsed.reason ?? ""),
    };
  } catch (e) {
    clearTimeout(timer);
    const msg = e instanceof Error ? e.message : String(e);
    serverLogger.warn("[llmScorer] call failed", {
      agentId: agent.id,
      taskId: task.id,
      error: msg,
    });
    return null;
  }
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Pre-compute LLM scores for a set of agents and a task in parallel.
 * Call this before the synchronous bidding loop.
 *
 * Only runs when the group has fewer than `maxAgents` agents to avoid
 * unbounded LLM call latency for large groups.
 */
export async function warmLlmScores(
  agents: GuildAgent[],
  task: GuildTask,
  maxAgents = 10,
): Promise<boolean> {
  if (agents.length >= maxAgents) return false;

  // Skip agents already cached for this task
  const uncached = agents.filter(
    (a) => !llmScoreCache.has(`${a.id}::${task.id}`)
  );
  if (uncached.length === 0) return true;

  serverLogger.info("[llmScorer] warming scores", {
    taskId: task.id,
    agentCount: uncached.length,
    model: pickScorerModel(),
  });

  // Run all agent evaluations in parallel (each has its own 10s timeout)
  const results = await Promise.allSettled(
    uncached.map(async (agent) => {
      const result = await callLlmScorer(agent, task);
      if (result !== null) {
        llmScoreCache.set(`${agent.id}::${task.id}`, result);
      }
    })
  );

  const failed = results.filter((r) => r.status === "rejected").length;
  if (failed > 0) {
    serverLogger.warn("[llmScorer] some agents failed scoring", {
      taskId: task.id,
      failed,
    });
  }

  return true;
}

/**
 * Synchronous lookup of a pre-computed LLM score.
 * Returns null if warmLlmScores was not called or the call failed.
 */
export function getCachedLlmScore(agentId: string, taskId: string): LlmScoreResult | null {
  return llmScoreCache.get(`${agentId}::${taskId}`) ?? null;
}

/**
 * Clean up task-specific LLM score cache after a bidding round.
 */
export function clearTaskLlmCache(taskId: string): void {
  const suffix = `::${taskId}`;
  const toDelete = [...llmScoreCache.keys()].filter((k) => k.endsWith(suffix));
  for (const k of toDelete) llmScoreCache.delete(k);
}

/**
 * Invalidate a specific agent's cached LLM scores (e.g. after profile update).
 */
export function invalidateAgentLlmScores(agentId: string): void {
  const prefix = `${agentId}::`;
  const toDelete = [...llmScoreCache.keys()].filter((k) => k.startsWith(prefix));
  for (const k of toDelete) llmScoreCache.delete(k);
}

/** Reset all state — used for testing. */
export function _resetLlmScorerForTest(): void {
  llmScoreCache.clear();
}
