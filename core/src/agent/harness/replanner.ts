import { HumanMessage } from "@langchain/core/messages";
import type { ModelAdapter } from "../../llm/adapter.js";
import type { RuntimePlanStep } from "../planTracker.js";
import { extractPlanSteps, type PlanStep } from "../planning.js";
import type { ReplanDecision } from "./types.js";

const REPLAN_PROMPT_TEMPLATE = `You are a plan revision assistant. The current execution plan has encountered issues and needs revision.

## Trigger
{trigger}

## Current Plan (completed steps marked with [x])
{currentPlan}

## Context Summary
{contextSummary}

## Instructions
Generate a revised plan for the REMAINING (uncompleted) steps only. Keep completed steps as-is.
Focus on alternative approaches to avoid repeating the same failure.
Output step titles and acceptance checks in Chinese (中文).

Output format (same as original plan):
PLAN:
1. <步骤标题> | 验收: <验收标准A>; <验收标准B>
2. <步骤标题> | 验收: <验收标准A>

Rules:
- Only output the NEW steps to replace uncompleted ones
- 1-8 steps max
- Each step must have 1-3 acceptance checks
- Suggest a different approach from what failed`;

/**
 * 动态重规划器 — 当 Eval 失败或循环检测触发时，生成修订后的 plan
 *
 * 保留已完成步骤，只替换未完成部分。
 * 复用 planning.ts 的 extractPlanSteps 解析新 plan。
 */
export async function generateReplan(
  adapter: ModelAdapter,
  currentSteps: RuntimePlanStep[],
  trigger: "eval_fail" | "loop_detected",
  contextSummary: string,
  config: { autoApprove: boolean }
): Promise<ReplanDecision> {
  const triggerDescription =
    trigger === "eval_fail"
      ? "Plan step evaluation failed — evidence does not satisfy acceptance checks"
      : "Loop detected — agent is repeating the same actions without progress";

  const planText = currentSteps
    .map((s, i) => {
      const status = s.completed ? "[x]" : "[ ]";
      return `${status} ${i + 1}. ${s.title} | 验收: ${s.acceptance_checks.join("; ")}`;
    })
    .join("\n");

  const prompt = REPLAN_PROMPT_TEMPLATE
    .replace("{trigger}", triggerDescription)
    .replace("{currentPlan}", planText)
    .replace("{contextSummary}", contextSummary || "(no additional context)");

  try {
    const model = adapter.getLLM();
    const response = await model.invoke([
      new HumanMessage(prompt),
    ]);

    const text =
      typeof response.content === "string"
        ? response.content
        : Array.isArray(response.content)
          ? response.content
              .map((x) => (typeof x === "string" ? x : (x as { text?: string })?.text ?? ""))
              .join("")
          : "";

    if (!text.trim()) {
      return { shouldReplan: false, trigger: "none" };
    }

    const newSteps = extractPlanSteps(text);
    if (newSteps.length === 0) {
      return { shouldReplan: false, trigger: "none" };
    }

    return {
      shouldReplan: true,
      trigger,
      revisedSteps: newSteps,
      pendingApproval: !config.autoApprove,
    };
  } catch {
    // LLM 调用失败时不重规划，让原 plan 继续执行
    return { shouldReplan: false, trigger: "none" };
  }
}

/**
 * 将重规划结果合并到当前 plan：保留已完成步骤 + 替换未完成步骤
 */
export function mergeReplanIntoSteps(
  currentSteps: RuntimePlanStep[],
  revisedSteps: PlanStep[]
): RuntimePlanStep[] {
  const completed = currentSteps.filter((s) => s.completed);
  const newPending: RuntimePlanStep[] = revisedSteps.map((s) => ({
    ...s,
    evidences: [],
    completed: false,
  }));
  return [...completed, ...newPending];
}

/**
 * 构造重规划后的注入消息，告知 agent plan 已更新
 */
export function buildReplanInjectionMessage(
  mergedSteps: RuntimePlanStep[]
): HumanMessage {
  const planText = mergedSteps
    .map((s, i) => {
      const status = s.completed ? "[x]" : "[ ]";
      return `${status} ${i + 1}. ${s.title} | 验收: ${s.acceptance_checks.join("; ")}`;
    })
    .join("\n");

  return new HumanMessage(
    `[Harness] Plan has been revised due to execution issues. Updated plan:\n${planText}\n\nContinue execution from the first uncompleted step.`
  );
}
