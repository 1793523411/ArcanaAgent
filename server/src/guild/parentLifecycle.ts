/**
 * Mechanics shared by the Requirement (LLM) and Pipeline (template)
 * decomposition paths — stamping the parent task after its subtasks are
 * known, and setting up the workspace.md that the plan section writes into.
 *
 * Prior to this module, planner.ts and pipelines.ts each had their own
 * ~10 lines doing the same thing (createWorkspace + updateTask with
 * workspaceRef; then updateTask with status=in_progress + subtaskIds, plus
 * renderPlanTable into the Plan section). Any fix to those mechanics had to
 * happen in two places.
 *
 * Scope-discipline note: flow-specific concerns stay in their owning files:
 * planner writes Scope / OpenQuestions sections; pipelines writes Deliverables
 * and declaredOutputs. Those sections legitimately differ between flows.
 */

import type { GuildTask } from "./types.js";
import { getGroup } from "./guildManager.js";
import { createWorkspace, updatePlanSection, renderPlanTable } from "./workspace.js";
import { updateTask } from "./taskBoard.js";

/** Create a workspace.md for the parent and record its ref on the task.
 *  Called up-front so the Plan section has a place to live even if the
 *  downstream decomposer (LLM or template expansion) fails mid-flight. */
export function ensureParentWorkspace(
  groupId: string,
  parent: GuildTask,
  fallbackOwner: string,
): string {
  const group = getGroup(groupId);
  const owner = group?.leadAgentId ?? fallbackOwner;
  const ref = createWorkspace(groupId, parent.id, parent.title, parent.description, owner);
  updateTask(groupId, parent.id, { workspaceRef: ref });
  return ref;
}

/** Stamp the parent as in_progress with its subtask list + render the Plan
 *  section. Used once decomposition has produced subtasks. `extras` lets
 *  each flow pass its specific fields (e.g. pipelines' declaredOutputs)
 *  without forking the helper. */
export function finalizeParentDecomposition(
  groupId: string,
  parent: GuildTask,
  subtasks: GuildTask[],
  extras?: Parameters<typeof updateTask>[2],
): void {
  const subtaskIds = subtasks.map((t) => t.id);
  updateTask(groupId, parent.id, {
    status: "in_progress",
    startedAt: new Date().toISOString(),
    subtaskIds,
    ...(extras ?? {}),
  });
  updatePlanSection(groupId, parent.id, renderPlanTable(subtasks));
}
