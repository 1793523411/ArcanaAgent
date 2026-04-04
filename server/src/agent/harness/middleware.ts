import { HumanMessage } from "@langchain/core/messages";
import type { ModelAdapter } from "../../llm/adapter.js";
import type { RuntimePlanStep } from "../planTracker.js";
import { computeCurrentStep } from "../planTracker.js";
import { LoopDetector } from "./loopDetector.js";
import { evaluateStepCompletion } from "./evalGuard.js";
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
export class HarnessMiddleware {
  private readonly config: HarnessConfig;
  private readonly adapter: ModelAdapter;
  private readonly loopDetector: LoopDetector;
  private replanCount = 0;

  /** 追踪上一轮已完成的 step 索引，用于检测新完成的 step */
  private lastCompletedIndex = -1;

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

    // 2. Eval：检查是否有 plan step 刚被标记完成
    if (this.config.evalEnabled && planSteps.length > 0) {
      const currentCompleted = computeCurrentStep(planSteps) - 1; // 最后一个已完成的 index
      if (currentCompleted > this.lastCompletedIndex && currentCompleted >= 0) {
        const justCompleted = planSteps[currentCompleted];
        if (justCompleted?.completed) {
          const evalResult = await evaluateStepCompletion(
            this.adapter,
            justCompleted,
            currentCompleted
          );
          events.push({ kind: "eval", data: evalResult, timestamp: now() });

          if (evalResult.verdict === "weak") {
            // 注入提示消息，提醒 agent 补充验证
            this.lastCompletedIndex = currentCompleted;
            return {
              events,
              injectMessages: [
                new HumanMessage(
                  `[Harness Eval] Step "${justCompleted.title}" evidence is weak: ${evalResult.reason}. Please provide stronger evidence before continuing.`
                ),
              ],
            };
          }

          if (evalResult.verdict === "inconclusive") {
            // 环境限制无法验证 — 接受为结构性完成，不触发 replan
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
            // Eval 失败 → 触发重规划（先更新 index 防止重复 eval）
            this.lastCompletedIndex = currentCompleted;
            const replanResult = await this.tryReplan(planSteps, "eval_fail", contextSummary, events);
            if (replanResult) {
              this.loopDetector.reset(); // 重规划后重置检测器，避免新旧 plan 数据交叉误判
              return replanResult;
            }
          }
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
    this.replanCount++; // LLM 调用即计数，无论是否 auto-approve

    if (!decision.shouldReplan || !decision.revisedSteps) return null;

    const mergedSteps = mergeReplanIntoSteps(planSteps, decision.revisedSteps);

    return {
      updatedPlanSteps: mergedSteps,
      injectMessages: [buildReplanInjectionMessage(mergedSteps)],
      events,
    };
  }
}
