import { getAgent, updateAgent, getGroupAgents, listGroups } from "./guildManager.js";
import { getGroupTasks, updateTask, getTask } from "./taskBoard.js";
import { isExecutionActive } from "./agentExecutor.js";
import { guildEventBus } from "./eventBus.js";
import { serverLogger } from "../lib/logger.js";

const BIDDING_STALE_MS = 30 * 1000;
// Give a freshly assigned task time to register an active execution before treating
// it as orphaned. Production executors register synchronously after assignment, but
// scheduler retries / sweeps may race the executeAgentTask invocation by a few ms.
const IN_PROGRESS_GRACE_MS = 5 * 1000;

/**
 * If an agent is marked working but their current task is not actually being executed
 * by this process, reset them to idle so bidding can use them.
 */
export function reconcileStaleWorkingAgent(agentId: string): boolean {
  const agent = getAgent(agentId);
  if (!agent) return false;
  if (agent.status !== "working") return false;

  if (!agent.currentTaskId) {
    updateAgent(agentId, { status: "idle", currentTaskId: undefined });
    guildEventBus.emit({ type: "agent_status_changed", agentId, status: "idle" });
    guildEventBus.emit({ type: "agent_updated", agentId });
    return true;
  }

  // Find the task across every group the agent belongs to (first hit wins).
  const candidateGroups = listGroups()
    .filter((g) => g.agents.includes(agentId))
    .map((g) => g.id);
  if (agent.groupId && !candidateGroups.includes(agent.groupId)) {
    candidateGroups.push(agent.groupId);
  }
  let foundActive = false;
  for (const groupId of candidateGroups) {
    const t = getTask(groupId, agent.currentTaskId);
    if (!t) continue;
    if (
      t.status === "in_progress" &&
      t.assignedAgentId === agentId &&
      isExecutionActive(groupId, t.id)
    ) {
      foundActive = true;
      break;
    }
  }

  if (foundActive) return false;

  updateAgent(agentId, { status: "idle", currentTaskId: undefined });
  guildEventBus.emit({ type: "agent_status_changed", agentId, status: "idle" });
  guildEventBus.emit({ type: "agent_updated", agentId });
  return true;
}

export function reconcileGroupWorkingAgents(groupId: string): void {
  for (const a of getGroupAgents(groupId)) {
    reconcileStaleWorkingAgent(a.id);
  }
}

/**
 * Reset orphaned in_progress / stuck bidding tasks back to open so the scheduler
 * can pick them up again. Orphaned = no live execution registered in this process.
 *
 * Returns the number of tasks reset.
 */
export function reconcileGroupOrphanTasks(groupId: string): number {
  const stuck = getGroupTasks(groupId, ["in_progress", "bidding"]);
  let resetCount = 0;
  const now = Date.now();

  for (const t of stuck) {
    if (t.status === "in_progress") {
      if (isExecutionActive(groupId, t.id)) continue;
      // Skip recent assignments — the executor registers itself a few ticks after
      // assignTask, so we avoid stomping on tasks that just transitioned to in_progress.
      const startedAt = t.startedAt ? Date.parse(t.startedAt) : 0;
      if (startedAt && now - startedAt < IN_PROGRESS_GRACE_MS) continue;
      const reset = updateTask(groupId, t.id, {
        status: "open",
        assignedAgentId: undefined,
        startedAt: undefined,
      });
      if (!reset) continue;

      if (t.assignedAgentId) {
        const a = getAgent(t.assignedAgentId);
        if (a && a.currentTaskId === t.id) {
          updateAgent(a.id, { status: "idle", currentTaskId: undefined });
          guildEventBus.emit({ type: "agent_status_changed", agentId: a.id, status: "idle" });
          guildEventBus.emit({ type: "agent_updated", agentId: a.id });
        }
      }

      guildEventBus.emit({ type: "task_updated", task: reset });
      resetCount++;
      serverLogger.warn("[guild] Reset orphan in_progress task", {
        groupId,
        taskId: t.id,
        previousAgentId: t.assignedAgentId,
      });
      continue;
    }

    // status === "bidding": reset if older than threshold and no execution active
    const startedAt = t.startedAt ? Date.parse(t.startedAt) : 0;
    const createdAt = Date.parse(t.createdAt);
    const reference = startedAt || createdAt;
    if (!reference || now - reference < BIDDING_STALE_MS) continue;
    if (isExecutionActive(groupId, t.id)) continue;

    const reset = updateTask(groupId, t.id, { status: "open" });
    if (!reset) continue;
    guildEventBus.emit({ type: "task_updated", task: reset });
    resetCount++;
    serverLogger.warn("[guild] Reset stale bidding task", { groupId, taskId: t.id });
  }

  return resetCount;
}
