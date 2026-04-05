import { HumanMessage } from "@langchain/core/messages";
import type { ModelAdapter } from "../../llm/adapter.js";
import type { RuntimePlanStep } from "../planTracker.js";
import { computeCurrentStep } from "../planTracker.js";
import { LoopDetector } from "./loopDetector.js";
import { evaluateStepCompletion, determineEvalTier, lightweightEval } from "./evalGuard.js";
import { generateReplan, mergeReplanIntoSteps, buildReplanInjectionMessage } from "./replanner.js";
import type { HarnessConfig, HarnessEvent, MiddlewareResult } from "./types.js";

/**
 * Harness 中间件 — 在每轮工具执行后运行，组合 Eval + LoopDetector + Replanner
 *
 * 集成方式：index.ts 在 toolOutputs 收集完成后调用 afterToolResults()，
 * 根据返回值决定是否更新 plan、注入消息、或终止执行。
 *
 * 当 harnessConfig 为 null 时不实例化此类，零开销。
 */
const MAX_WEAK_RETRIES_PER_STEP = 2;

export class HarnessMiddleware {
  private readonly config: HarnessConfig;
  private readonly adapter: ModelAdapter;
  private readonly loopDetector: LoopDetector;
  private replanCount = 0;

  /** 追踪上一轮已完成的 step 索引，用于检测新完成的 step */
  private lastCompletedIndex = -1;

  /** 每个步骤的连续 weak 计数，超过阈值自动接受 */
  private weakCounts = new Map<number, number>();

  /** 追踪每个 step 使用了哪些工具名（用于 EvalGuard 分级） */
  private stepToolsUsed = new Map<number, Set<string>>();

  constructor(config: HarnessConfig, adapter: ModelAdapter) {
    this.config = config;
    this.adapter = adapter;
    this.loopDetector = new LoopDetector({
      windowSize: config.loopWindowSize,
      similarityThreshold: config.loopSimilarityThreshold,
    });
  }

  /**
   * 在每轮工具执行完成后调用
   */
  async afterToolResults(
    planSteps: RuntimePlanStep[],
    toolOutputs: Array<{ name: string; result: string }>,
    contextSummary: string
  ): Promise<MiddlewareResult> {
    const events: HarnessEvent[] = [];
    const now = () => new Date().toISOString();

    // 1. 记录工具输出到循环检测器
    if (this.config.loopDetectionEnabled) {
      for (const out of toolOutputs) {
        this.loopDetector.record(out.name, out.result);
      }
    }

    // 1b. 追踪当前 step 使用的工具名（用于 EvalGuard 分级）
    const currentStepIdx = computeCurrentStep(planSteps);
    if (currentStepIdx >= 0) {
      const used = this.stepToolsUsed.get(currentStepIdx) ?? new Set();
      for (const out of toolOutputs) used.add(out.name);
      this.stepToolsUsed.set(currentStepIdx, used);
    }

    // 2. Eval：检查是否有 plan step 刚被标记完成
    if (this.config.evalEnabled && planSteps.length > 0) {
      const currentCompleted = computeCurrentStep(planSteps) - 1; // 最后一个已完成的 index
      if (currentCompleted > this.lastCompletedIndex && currentCompleted >= 0) {
        const justCompleted = planSteps[currentCompleted];
        if (justCompleted?.completed) {
          // ── EvalGuard 分级策略 ──
          const toolsUsed = Array.from(this.stepToolsUsed.get(currentCompleted) ?? []);
          const tier = determineEvalTier(justCompleted, toolsUsed);

          let evalResult;
          if (tier === "skip") {
            // 只读工具步骤：跳过 LLM eval，直接 pass
            evalResult = { stepIndex: currentCompleted, verdict: "pass" as const, reason: "只读工具步骤，跳过评估（skip tier）" };
          } else if (tier === "lightweight") {
            // 写入无错误：纯规则检查
            evalResult = lightweightEval(justCompleted, currentCompleted);
          } else {
            // full: 完整 LLM eval
            evalResult = await evaluateStepCompletion(
              this.adapter,
              justCompleted,
              currentCompleted
            );
          }
          events.push({ kind: "eval", data: evalResult, timestamp: now() });

          if (evalResult.verdict === "weak") {
            const weakCount = (this.weakCounts.get(currentCompleted) ?? 0) + 1;
            this.weakCounts.set(currentCompleted, weakCount);

            if (weakCount > MAX_WEAK_RETRIES_PER_STEP) {
              // 多次 weak 后自动接受，避免无限循环
              this.lastCompletedIndex = currentCompleted;
              return {
                events,
                injectMessages: [
                  new HumanMessage(
                    `[Harness Eval] Step "${justCompleted.title}" evidence remains weak after ${weakCount} attempts. Accepting and moving on.`
                  ),
                ],
              };
            }

            const resetSteps = [...planSteps];
            resetSteps[currentCompleted] = { ...justCompleted, completed: false };
            this.lastCompletedIndex = currentCompleted - 1;
            return {
              events,
              updatedPlanSteps: resetSteps,
              injectMessages: [
                new HumanMessage(
                  `[Harness Eval] Step "${justCompleted.title}" evidence is weak (attempt ${weakCount}/${MAX_WEAK_RETRIES_PER_STEP}): ${evalResult.reason}. Please run additional verification to strengthen the evidence.`
                ),
              ],
            };
          }

          if (evalResult.verdict === "inconclusive") {
            this.lastCompletedIndex = currentCompleted;
            return {
              events,
              injectMessages: [
                new HumanMessage(
                  `[Harness Eval] Step "${justCompleted.title}" cannot be verified in this environment: ${evalResult.reason}. Accepting as structurally complete — continue to the next step.`
                ),
              ],
            };
          }

          if (evalResult.verdict === "fail") {
            // 克隆步骤数组，重置失败步骤
            const resetSteps = [...planSteps];
            resetSteps[currentCompleted] = { ...justCompleted, completed: false, evidences: [] };
            this.lastCompletedIndex = currentCompleted - 1;

            const replanResult = await this.tryReplan(resetSteps, "eval_fail", contextSummary, events);
            if (replanResult) {
              this.loopDetector.reset();
              return replanResult;
            }
            return {
              events,
              updatedPlanSteps: resetSteps,
              injectMessages: [
                new HumanMessage(
                  `[Harness Eval] Step "${justCompleted.title}" FAILED evaluation: ${evalResult.reason}. The step has been reset. Please try a different approach and collect new evidence.`
                ),
              ],
            };
          }

          // verdict === "pass" — 步骤通过验证，返回 eval 事件供前端展示
          this.lastCompletedIndex = currentCompleted;
          return { events };
        }
        this.lastCompletedIndex = currentCompleted;
      }
    }

    // 3. 循环检测
    if (this.config.loopDetectionEnabled) {
      const loopResult = this.loopDetector.detect();
      if (loopResult.detected) {
        events.push({ kind: "loop_detection", data: loopResult, timestamp: now() });

        // 循环检测触发 → 尝试重规划
        const replanResult = await this.tryReplan(planSteps, "loop_detected", contextSummary, events);
        if (replanResult) {
          this.loopDetector.reset(); // 重规划后重置检测器
          return replanResult;
        }

        // 重规划也用完了 → 注入消息让 agent 换策略
        return {
          events,
          injectMessages: [
            new HumanMessage(
              `[Harness] Loop detected: ${loopResult.description}. You are repeating the same actions. Try a completely different approach.`
            ),
          ],
        };
      }
    }

    return { events };
  }

  /**
   * 尝试重规划。如果已达到最大次数，返回 null。
   */
  private async tryReplan(
    planSteps: RuntimePlanStep[],
    trigger: "eval_fail" | "loop_detected",
    contextSummary: string,
    events: HarnessEvent[]
  ): Promise<MiddlewareResult | null> {
    if (!this.config.replanEnabled) return null;
    if (this.replanCount >= this.config.maxReplanAttempts) return null;

    const decision = await generateReplan(
      this.adapter,
      planSteps,
      trigger,
      contextSummary,
      { autoApprove: this.config.autoApproveReplan }
    );

    events.push({ kind: "replan", data: decision, timestamp: new Date().toISOString() });
    this.replanCount++;

    if (!decision.shouldReplan || !decision.revisedSteps) return null;

    // pendingApproval: 不自动应用新计划，但仍需传回步骤重置（planSteps 已包含 reset）
    if (decision.pendingApproval) {
      const suggestion = decision.revisedSteps.map((s, i) => `${i + 1}. ${s.title}`).join("\n");
      return {
        events,
        updatedPlanSteps: planSteps,
        injectMessages: [
          new HumanMessage(
            `[Harness] Replan suggested (trigger: ${trigger}). Proposed new steps:\n${suggestion}\n\nThe current plan remains unchanged but the failed step has been reset. Consider adopting a different strategy based on the suggestion above.`
          ),
        ],
      };
    }

    const mergedSteps = mergeReplanIntoSteps(planSteps, decision.revisedSteps);

    return {
      updatedPlanSteps: mergedSteps,
      injectMessages: [buildReplanInjectionMessage(mergedSteps)],
      events,
    };
  }
}
