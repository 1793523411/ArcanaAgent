/**
 * Unified decomposition entrypoint. Parent tasks turn into subtasks by one of
 * three strategies today:
 *
 *   - llm       : Lead agent calls the Planner; subtasks are dynamic and
 *                 depend on what the LLM produces. (kind === "requirement")
 *   - template  : Pipeline template statically defines the subtask DAG with
 *                 ${var} interpolation. (kind === "pipeline")
 *   - manual    : No decomposition — the task is atomic / already-subtask
 *                 content. (kind === "adhoc" / undefined)
 *
 * Prior to this module, callers (autonomousScheduler, HTTP routes) branched
 * on `task.kind` and called `planRequirement` / `expandPipeline` directly,
 * duplicating the kind → strategy mapping. `decompose()` centralizes that
 * dispatch so the rest of the system sees a single "turn this parent into
 * subtasks" API.
 *
 * This is an additive facade — the underlying planner and pipeline flows are
 * unchanged, so this commit is safe to revert without breaking existing work.
 */

import type { GuildTask } from "./types.js";
import { planRequirement } from "./planner.js";
import { expandPipeline, getPipeline } from "./pipelines.js";

export type DecompositionStrategy = "llm" | "template" | "manual";

export interface DecomposeOutcome {
  ok: boolean;
  subtaskIds?: string[];
  reason?: string;
  /** Which branch actually ran. Callers can log / route on this. */
  strategy: DecompositionStrategy;
}

/** Classify a task's intended strategy without calling any decomposer. */
export function decompositionStrategyFor(task: GuildTask): DecompositionStrategy {
  if (task.kind === "requirement") return "llm";
  if (task.kind === "pipeline") return "template";
  return "manual";
}

/** Single entrypoint for "turn parent into subtasks". Safe to call
 *  repeatedly: already-decomposed parents short-circuit to their existing
 *  subtask list. */
export async function decompose(
  groupId: string,
  parent: GuildTask,
): Promise<DecomposeOutcome> {
  const strategy = decompositionStrategyFor(parent);

  if (strategy === "llm") {
    // Already decomposed? — skip without calling the LLM again. Matches the
    // pre-facade scheduler check (t.subtaskIds length > 0).
    if (parent.subtaskIds && parent.subtaskIds.length > 0) {
      return { ok: true, subtaskIds: parent.subtaskIds, reason: "Already decomposed", strategy };
    }
    const out = await planRequirement(groupId, parent);
    return { ok: out.ok, subtaskIds: out.subtaskIds, reason: out.reason, strategy };
  }

  if (strategy === "template") {
    if (!parent.pipelineId) {
      return { ok: false, reason: "Pipeline parent missing pipelineId", strategy };
    }
    const tpl = getPipeline(parent.pipelineId);
    if (!tpl) {
      return { ok: false, reason: `Pipeline template not found: ${parent.pipelineId}`, strategy };
    }
    const out = expandPipeline(groupId, parent, tpl, parent.pipelineInputs ?? {});
    return { ok: out.ok, subtaskIds: out.subtaskIds, reason: out.reason, strategy };
  }

  // manual — the parent is a leaf by design. Nothing to do.
  return { ok: true, subtaskIds: [], strategy };
}
