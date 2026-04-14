import type { PlanStep } from "./planning.js";

export type RuntimePlanStep = PlanStep & {
  evidences: string[];
  completed: boolean;
};

export function createRuntimePlanSteps(steps: PlanStep[]): RuntimePlanStep[] {
  return steps.map((s) => ({
    ...s,
    evidences: [],
    completed: false,
  }));
}

const ERROR_EVIDENCE_PREFIX = "[evidence:error] ";

export function isErrorEvidence(evidence: string): boolean {
  return evidence.startsWith(ERROR_EVIDENCE_PREFIX);
}

export function summarizeToolEvidence(toolName: string | undefined, output: string, isError = false): string {
  const oneLine = output.replace(/\s+/g, " ").trim();
  const short = oneLine.length > 180 ? `${oneLine.slice(0, 180)}…` : oneLine;
  const body = toolName ? `${toolName}: ${short || "(no output)"}` : (short || "(no output)");
  return isError ? `${ERROR_EVIDENCE_PREFIX}${body}` : body;
}

export function applyEvidenceToPlan(steps: RuntimePlanStep[], evidence: string): RuntimePlanStep[] {
  const firstPending = steps.findIndex((s) => !s.completed);
  if (firstPending < 0) return steps;
  const target = steps[firstPending];
  const allEvidences = [...target.evidences, evidence];
  // Walk backwards to keep the last 6 successes and last 3 errors while preserving chronological order
  const MAX_SUCCESS = 6;
  const MAX_ERRORS = 3;
  let successCount = 0;
  let errorCount = 0;
  const kept: boolean[] = new Array(allEvidences.length).fill(false);
  for (let i = allEvidences.length - 1; i >= 0; i--) {
    if (isErrorEvidence(allEvidences[i])) {
      if (errorCount < MAX_ERRORS) { kept[i] = true; errorCount++; }
    } else {
      if (successCount < MAX_SUCCESS) { kept[i] = true; successCount++; }
    }
  }
  const nextEvidences = allEvidences.filter((_, i) => kept[i]);
  const requiredChecks = Math.max(1, target.acceptance_checks.length);
  const completed = successCount >= requiredChecks;
  // 保留严格门槛：证据条数需覆盖验收项数量，避免"单条证据"导致步骤过早完成。
  const cloned = [...steps];
  cloned[firstPending] = {
    ...target,
    evidences: nextEvidences,
    completed,
  };
  return cloned;
}

export function computeCurrentStep(steps: RuntimePlanStep[]): number {
  let done = 0;
  for (const step of steps) {
    if (!step.completed) break;
    done += 1;
  }
  return done;
}

export function forceCompletePlan(steps: RuntimePlanStep[]): RuntimePlanStep[] {
  return steps.map((step) => ({
    ...step,
    completed: true,
  }));
}
