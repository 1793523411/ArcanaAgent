import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage } from "@langchain/core/messages";
import { streamAgentWithTokens } from "../index.js";
import type { StreamAgentOptions } from "../riskDetection.js";
import type { HarnessConfig, HarnessEvent, EvalResult, LoopDetectionResult } from "./types.js";
import { DEFAULT_HARNESS_CONFIG } from "./types.js";

// ─── Driver Configuration ───────────────────────────────────────

export interface HarnessDriverConfig {
  /** 最大外层重试次数（每次重试 = 一次完整的 agent 执行） */
  maxOuterRetries: number;
  /** Harness 中间件配置（传递给 streamAgentWithTokens） */
  harnessConfig: HarnessConfig;
}

export const DEFAULT_DRIVER_CONFIG: HarnessDriverConfig = {
  maxOuterRetries: 2,
  harnessConfig: { ...DEFAULT_HARNESS_CONFIG, autoApproveReplan: true },
};

// ─── Driver Events ──────────────────────────────────────────────

export interface HarnessDriverEvent {
  kind: "driver_lifecycle";
  phase: "started" | "iteration_start" | "iteration_end" | "completed" | "max_retries_reached";
  iteration: number;
  maxRetries: number;
  harnessEventsInIteration?: HarnessEvent[];
  timestamp: string;
}

// ─── Meta-Loop Driver ───────────────────────────────────────────

/**
 * Harness meta-loop 驱动器
 *
 * 包装 streamAgentWithTokens，在外层提供重试机制：
 * 1. 运行 agent 执行（内层由 HarnessMiddleware 监控 eval/loop/replan）
 * 2. 执行结束后检查是否有未解决的 harness 事件（eval fail、loop 等）
 * 3. 如果最后一轮有严重问题且未被内层 replan 解决，外层重试
 *
 * 外层重试的条件：
 * - 内层执行产生了 eval fail 或 loop detection 但 replan 次数已耗尽
 * - 未达到外层最大重试次数
 *
 * 使用方式：与 streamAgentWithTokens 相同的 AsyncGenerator 接口，
 * 可直接替换 routes.ts 中的调用。
 */
export async function* streamHarnessAgent(
  messages: BaseMessage[],
  onToken: (token: string) => void,
  modelId: string | undefined,
  onReasoningToken: ((token: string) => void) | undefined,
  skillContext: string | undefined,
  options: StreamAgentOptions,
  driverConfig: HarnessDriverConfig = DEFAULT_DRIVER_CONFIG,
  onDriverEvent?: (event: HarnessDriverEvent) => void
): AsyncGenerator<Record<string, unknown>, void, unknown> {
  const now = () => new Date().toISOString();

  const emitDriver = (
    phase: HarnessDriverEvent["phase"],
    iteration: number,
    harnessEvents?: HarnessEvent[]
  ) => {
    onDriverEvent?.({
      kind: "driver_lifecycle",
      phase,
      iteration,
      maxRetries: driverConfig.maxOuterRetries,
      harnessEventsInIteration: harnessEvents,
      timestamp: now(),
    });
  };

  emitDriver("started", 0);

  // 合并 harness 配置到 options
  const baseOptions: StreamAgentOptions = {
    ...options,
    harnessConfig: driverConfig.harnessConfig,
  };

  const iterationSummaries: string[] = [];

  for (let iteration = 0; iteration <= driverConfig.maxOuterRetries; iteration++) {
    emitDriver("iteration_start", iteration);

    // 如果有历史失败摘要，注入到 messages 中让 agent 避免重复
    const iterationMessages: BaseMessage[] = iterationSummaries.length > 0
      ? [
          ...messages,
          new HumanMessage(
            `[Harness Driver] Previous iteration(s) failed. Review to avoid repeating the same mistakes:\n\n${iterationSummaries.join("\n\n")}\n\nDo NOT repeat the same approaches. Try fundamentally different strategies.`
          ),
        ]
      : messages;

    const iterationHarnessEvents: HarnessEvent[] = [];
    const iterationOptions: StreamAgentOptions = {
      ...baseOptions,
      onHarnessEvent: (event) => {
        iterationHarnessEvents.push(event);
        // 同时转发给原始回调
        options.onHarnessEvent?.(event);
      },
    };

    // 透传内层 generator 的所有 yield
    for await (const chunk of streamAgentWithTokens(
      iterationMessages,
      onToken,
      modelId,
      onReasoningToken,
      skillContext,
      iterationOptions
    )) {
      yield chunk as Record<string, unknown>;
    }

    emitDriver("iteration_end", iteration, iterationHarnessEvents);

    // 判断是否需要外层重试
    const hasUnresolvedFailure = iterationHarnessEvents.some((e) => {
      if (e.kind === "eval" && "verdict" in e.data) {
        return e.data.verdict === "fail";
      }
      if (e.kind === "loop_detection" && "detected" in e.data) {
        return e.data.detected === true;
      }
      return false;
    });

    // 检查最后一次 replan 之后是否还有未解决的 failure
    const lastReplanIdx = iterationHarnessEvents
      .map((e, i) => [e, i] as const)
      .filter(([e]) => e.kind === "replan" && "shouldReplan" in e.data && e.data.shouldReplan)
      .pop()?.[1] ?? -1;
    const eventsAfterReplan = lastReplanIdx >= 0
      ? iterationHarnessEvents.slice(lastReplanIdx + 1)
      : [];
    // replan 必须有后续事件证明其生效，否则不算已解决
    const replanResolved = lastReplanIdx >= 0
      && eventsAfterReplan.length > 0
      && !eventsAfterReplan.some((e) => {
        if (e.kind === "eval" && "verdict" in e.data) return e.data.verdict === "fail";
        if (e.kind === "loop_detection" && "detected" in e.data) return e.data.detected === true;
        return false;
      });

    if (!hasUnresolvedFailure || replanResolved) {
      // 执行成功或内层已解决
      emitDriver("completed", iteration);
      return;
    }

    if (iteration === driverConfig.maxOuterRetries) {
      // 外层重试也用完了
      emitDriver("max_retries_reached", iteration);
      return;
    }

    // 外层重试：构建本轮失败摘要，供下一轮参考
    const summaryParts: string[] = [`### Iteration ${iteration + 1} Summary (FAILED)`];
    const evalFailures = iterationHarnessEvents.filter(
      (e) => e.kind === "eval" && "verdict" in e.data && (e.data as EvalResult).verdict === "fail"
    );
    if (evalFailures.length > 0) {
      summaryParts.push(`Eval failures (${evalFailures.length}):`);
      for (const ef of evalFailures.slice(0, 10)) {
        const data = ef.data as EvalResult;
        summaryParts.push(`  - Step ${data.stepIndex + 1}: ${data.reason}`);
      }
    }
    const loops = iterationHarnessEvents.filter(
      (e) => e.kind === "loop_detection" && "detected" in e.data && (e.data as LoopDetectionResult).detected
    );
    if (loops.length > 0) {
      summaryParts.push(`Loop detections (${loops.length}):`);
      for (const l of loops.slice(0, 3)) {
        summaryParts.push(`  - ${(l.data as LoopDetectionResult).description ?? "repeated tool pattern"}`);
      }
    }
    iterationSummaries.push(summaryParts.join("\n"));
    // 后续迭代会进入下一轮循环
  }
}
