import type { GuildTask, Group, TaskStatus } from "./types.js";
import { guildEventBus } from "./eventBus.js";
import { listGroups, getGroupAgents } from "./guildManager.js";
import { getGroupTasks, getTask, findTaskGroup } from "./taskBoard.js";
import { autoBid } from "./bidding.js";
import { executeAgentTask } from "./agentExecutor.js";
import { reconcileGroupWorkingAgents, reconcileGroupOrphanTasks } from "./agentReconcile.js";
import { serverLogger } from "../lib/logger.js";
import { appendSchedulerDispatched, appendSchedulerStalled } from "./schedulerLogStore.js";
import { decompose } from "./decomposition.js";
import { areDepsReady } from "./taskBoard.js";
import { warmBiddingEmbeddingsBatch, clearTaskEmbeddingCache, isEmbeddingAvailable, preloadEmbeddingModel } from "./embeddingScorer.js";
import { warmLlmScores, clearTaskLlmCache } from "./llmScorer.js";

interface SchedulerDeps {
  listGroupsFn?: () => Group[];
  getGroupTasksFn?: (groupId: string, status?: TaskStatus[]) => GuildTask[];
  getTaskFn?: (groupId: string, taskId: string) => GuildTask | null;
  autoBidFn?: (groupId: string, task: GuildTask) => import("./types.js").TaskBid | null;
  executeAgentTaskFn?: (agentId: string, groupId: string, taskId: string) => Promise<unknown>;
}

const PRIORITY_RANK: Record<GuildTask["priority"], number> = {
  urgent: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const RECONCILE_INTERVAL_MS = 20 * 1000;

/** Per-group concurrency cap. Without this the scheduler will dispatch every
 *  eligible task at once — fine for a 3-agent demo, ruinous when the LLM is
 *  rate-limited or the group has 16+ agents. Each agent_status_changed →
 *  scheduleGroup re-runs the dispatch, so capping here just defers extra work
 *  to the next tick (when an agent frees up). Override via env for ops tuning. */
const MAX_CONCURRENT_PER_GROUP = Math.max(
  1,
  Number.parseInt(process.env.GUILD_MAX_CONCURRENT_PER_GROUP ?? "", 10) || 4,
);

export class GuildAutonomousScheduler {
  private started = false;
  private scheduledGroups = new Set<string>();
  private runningGroups = new Set<string>();
  private pendingReruns = new Set<string>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly listGroupsFn: () => Group[];
  private readonly getGroupTasksFn: (groupId: string, status?: TaskStatus[]) => GuildTask[];
  private readonly getTaskFn: (groupId: string, taskId: string) => GuildTask | null;
  private readonly autoBidFn: (groupId: string, task: GuildTask) => import("./types.js").TaskBid | null;
  private readonly executeAgentTaskFn: (agentId: string, groupId: string, taskId: string) => Promise<unknown>;
  private readonly onEventBound: (event: import("./types.js").GuildEvent) => void;

  constructor(deps: SchedulerDeps = {}) {
    this.listGroupsFn = deps.listGroupsFn ?? listGroups;
    this.getGroupTasksFn = deps.getGroupTasksFn ?? getGroupTasks;
    this.getTaskFn = deps.getTaskFn ?? getTask;
    this.autoBidFn = deps.autoBidFn ?? autoBid;
    this.executeAgentTaskFn = deps.executeAgentTaskFn ?? executeAgentTask;
    this.onEventBound = this.onEvent.bind(this);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    guildEventBus.onAll(this.onEventBound);

    // Start loading the embedding model in the background so semantic scoring
    // is available for subsequent dispatch cycles (first cycle uses token fallback).
    preloadEmbeddingModel();

    // Recover orphaned tasks/agents from prior process death before scheduling.
    for (const group of this.listGroupsFn()) {
      if (group.status !== "active") continue;
      try {
        reconcileGroupOrphanTasks(group.id);
        reconcileGroupWorkingAgents(group.id);
      } catch (e) {
        serverLogger.error("[guild] startup reconcile failed", { groupId: group.id, error: String(e) });
      }
      this.scheduleGroup(group.id);
    }

    // Periodic sweep: catches stuck-in-process executions (model timeout, lost
    // stream) AND wakes up tasks whose retryAt backoff has expired. We always
    // call scheduleGroup — not just when orphans were reset — because a task
    // may have been reopened with a future retryAt by failTask, and the
    // scheduler has no other event-driven path to re-evaluate it once that
    // timestamp passes. scheduleGroup is idempotent (runningGroups/scheduled-
    // Groups guards), so extra invocations are cheap.
    this.sweepTimer = setInterval(() => {
      if (!this.started) return;
      for (const group of this.listGroupsFn()) {
        if (group.status !== "active") continue;
        try {
          reconcileGroupOrphanTasks(group.id);
          reconcileGroupWorkingAgents(group.id);
          this.scheduleGroup(group.id);
        } catch (e) {
          serverLogger.error("[guild] sweep reconcile failed", { groupId: group.id, error: String(e) });
        }
      }
    }, RECONCILE_INTERVAL_MS);
    if (typeof this.sweepTimer === "object" && this.sweepTimer && "unref" in this.sweepTimer) {
      (this.sweepTimer as { unref: () => void }).unref();
    }
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    guildEventBus.offAll(this.onEventBound);
    this.scheduledGroups.clear();
    this.runningGroups.clear();
    this.pendingReruns.clear();
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private onEvent(event: import("./types.js").GuildEvent): void {
    if (!this.started) return;
    switch (event.type) {
      case "task_created":
        this.scheduleGroup(event.task.groupId);
        break;
      case "agent_status_changed":
        if (event.status === "idle") this.scheduleGroupsForAgent(event.agentId);
        break;
      case "task_completed":
      case "task_failed":
        this.scheduleGroupForTask(event.taskId);
        break;
      case "group_updated":
        this.scheduleGroup(event.groupId);
        break;
      default:
        break;
    }
  }

  private scheduleGroupsForAgent(agentId: string): void {
    const groups = this.listGroupsFn();
    for (const group of groups) {
      if (group.status !== "active") continue;
      if (group.agents.includes(agentId)) this.scheduleGroup(group.id);
    }
  }

  private scheduleGroupForTask(taskId: string): void {
    const groupId = findTaskGroup(taskId);
    if (groupId) this.scheduleGroup(groupId);
  }

  private scheduleGroup(groupId: string): void {
    if (!this.started) return;
    if (this.runningGroups.has(groupId)) {
      // A dispatch is in flight; ask it to re-run after it finishes so we don't
      // drop task_created / status_changed events that arrive mid-dispatch.
      this.pendingReruns.add(groupId);
      return;
    }
    if (this.scheduledGroups.has(groupId)) return;
    this.scheduledGroups.add(groupId);
    queueMicrotask(() => {
      void this.runGroupDispatch(groupId);
    });
  }

  private async runGroupDispatch(groupId: string): Promise<void> {
    this.scheduledGroups.delete(groupId);
    if (!this.started || this.runningGroups.has(groupId)) return;
    this.runningGroups.add(groupId);
    try {
      reconcileGroupOrphanTasks(groupId);
      reconcileGroupWorkingAgents(groupId);
      const openTasks = this.getGroupTasksFn(groupId, ["open", "bidding", "planning"]);
      const sorted = [...openTasks].sort((a, b) => {
        const byPriority = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
        if (byPriority !== 0) return byPriority;
        return Date.parse(a.createdAt) - Date.parse(b.createdAt);
      });
      if (sorted.length === 0) return;

      // 1) Route parent tasks (requirement / pipeline) through the unified
      //    decomposition entrypoint. Adhoc / leaf tasks are skipped by the
      //    facade's "manual" branch without calling an LLM or template.
      //    We only kick pipelines that haven't already been expanded — route
      //    creation usually expands them at POST time, but the idempotent
      //    check here is a safety net for any path that created the task
      //    without expanding.
      const parentsToDecompose = sorted.filter(
        (t) =>
          (t.kind === "requirement" || t.kind === "pipeline") &&
          (!t.subtaskIds || t.subtaskIds.length === 0),
      );
      for (const parent of parentsToDecompose) {
        if (!this.started) break;
        try {
          const outcome = await decompose(groupId, parent);
          if (!outcome.ok) {
            serverLogger.warn("[guild] decomposition failed, task left for bidding fallback", {
              groupId,
              taskId: parent.id,
              strategy: outcome.strategy,
              reason: outcome.reason,
            });
          }
        } catch (e) {
          serverLogger.error("[guild] decomposition threw", {
            groupId,
            taskId: parent.id,
            error: String(e),
          });
        }
      }

      // 2) After planning, refresh eligible tasks: adhoc + subtask with deps ready,
      //    skipping requirements (they stay as orchestration nodes).
      const refreshed = this.getGroupTasksFn(groupId, ["open", "bidding"]).sort((a, b) => {
        const byPriority = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
        if (byPriority !== 0) return byPriority;
        return Date.parse(a.createdAt) - Date.parse(b.createdAt);
      });
      const nowMs = Date.now();
      const eligible = refreshed.filter((t) => {
        if (t.kind === "requirement" || t.kind === "pipeline") return false;
        // Respect retry backoff — don't dispatch until the backoff window elapses.
        if (t.retryAt && Date.parse(t.retryAt) > nowMs) return false;
        return areDepsReady(groupId, t);
      });

      // Pre-warm embeddings for all eligible tasks so the sync bidding path
      // can use semantic similarity instead of token overlap.
      // Only runs when the embedding model is already loaded — the first dispatch
      // cycle uses token matching; subsequent cycles get semantic scoring.
      const groupAgents = getGroupAgents(groupId);
      // Parallel warmup — embedding + LLM across all eligible tasks at once.
      // Serializing each task wastes up to ~10s per task when the LLM scorer
      // is engaged; Promise.all keeps worst-case latency bounded to one round.
      if (isEmbeddingAvailable()) {
        // Single batched call across all tasks — HF pipeline serializes on
        // the same instance, so per-task Promise.all doesn't actually parallelize.
        await warmBiddingEmbeddingsBatch(groupAgents, eligible).catch(() => {
          // Embedding warmup is best-effort; token fallback will be used.
        });
      }

      // LLM scoring: only runs for small groups (<10 agents) — warmLlmScores
      // guards that internally. Must complete before the bid loop so
      // getCachedLlmScore() can return results.
      await Promise.all(
        eligible.map((c) =>
          warmLlmScores(groupAgents, c).catch(() => {
            // LLM scoring is best-effort; embedding/token fallback will be used.
          }),
        ),
      );

      let assignedAny = false;
      // Track every eligible task so finally{} can sweep both embedding AND
      // LLM caches symmetrically — previously only embedding was tracked,
      // letting LLM cache entries linger until process restart.
      const warmedTaskIds = eligible.map((t) => t.id);
      // Count agents already working before we start dispatching so the cap
      // accounts for in-flight executions from prior cycles, not just this loop.
      let inFlight = groupAgents.filter((a) => a.status === "working").length;
      try {
      for (const candidate of eligible) {
        if (!this.started) break;
        if (inFlight >= MAX_CONCURRENT_PER_GROUP) {
          // Defer remaining tasks; agent_status_changed → scheduleGroup will
          // re-run the dispatch when a slot frees up.
          this.pendingReruns.add(groupId);
          break;
        }
        const task = this.getTaskFn(groupId, candidate.id);
        if (!task || (task.status !== "open" && task.status !== "bidding")) continue;
        const winner = this.autoBidFn(groupId, task);
        if (!winner) {
          clearTaskEmbeddingCache(candidate.id);
          clearTaskLlmCache(candidate.id);
          continue;
        }
        assignedAny = true;
        const atDispatched = new Date().toISOString();
        const schedulerLogEntry = appendSchedulerDispatched(
          groupId,
          atDispatched,
          task.id,
          winner.agentId,
          task.title,
          winner.confidence,
        );
        guildEventBus.emit({
          type: "scheduler_task_dispatched",
          groupId,
          taskId: task.id,
          agentId: winner.agentId,
          taskTitle: task.title,
          confidence: winner.confidence,
          schedulerLogEntry,
        });
        clearTaskEmbeddingCache(task.id);
        clearTaskLlmCache(task.id);
        inFlight += 1;
        this.executeAgentTaskFn(winner.agentId, groupId, task.id).catch((e) => {
          serverLogger.error("[guild] autonomous scheduler execution failed", {
            groupId,
            taskId: task.id,
            agentId: winner.agentId,
            error: String(e),
          });
        });
      }

      if (!assignedAny) {
        const atStalled = new Date().toISOString();
        const stallMessage = `仍有 ${sorted.length} 个待处理任务（open/bidding），但当前无法分配（无空闲 Agent 或无人达到竞标门槛）`;
        const schedulerLogEntry = appendSchedulerStalled(groupId, atStalled, sorted.length, stallMessage);
        guildEventBus.emit({
          type: "scheduler_dispatch_stalled",
          groupId,
          openTaskCount: sorted.length,
          message: stallMessage,
          schedulerLogEntry,
        });
      }
      } finally {
        // Sweep any orphaned task caches (e.g. from early break / post-dispatch throw)
        for (const tid of warmedTaskIds) {
          clearTaskEmbeddingCache(tid);
          clearTaskLlmCache(tid);
        }
      }
    } finally {
      this.runningGroups.delete(groupId);
      if (this.pendingReruns.delete(groupId) && this.started) {
        this.scheduleGroup(groupId);
      }
    }
  }
}

export const guildAutonomousScheduler = new GuildAutonomousScheduler();
