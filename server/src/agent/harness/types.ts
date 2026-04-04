import type { BaseMessage } from "@langchain/core/messages";
import type { PlanStep } from "../planning.js";
import type { RuntimePlanStep } from "../planTracker.js";

// ─── Configuration ───────────────────────────────────────────────

export interface HarnessConfig {
  /** 是否启用 Eval（LLM 验证 plan step 完成质量） */
  evalEnabled: boolean;
  /** 是否启用循环检测（纯算法，零 token 成本） */
  loopDetectionEnabled: boolean;
  /** 是否启用动态重规划 */
  replanEnabled: boolean;
  /** 自动批准重规划（Harness 模式下为 true，Default/Team 模式下为 false） */
  autoApproveReplan: boolean;
  /** 最大重规划次数 */
  maxReplanAttempts: number;
  /** 循环检测滑动窗口大小 */
  loopWindowSize: number;
  /** trigram Jaccard 相似度阈值（0-1） */
  loopSimilarityThreshold: number;
}

export const DEFAULT_HARNESS_CONFIG: HarnessConfig = {
  evalEnabled: true,
  loopDetectionEnabled: true,
  replanEnabled: true,
  autoApproveReplan: false,
  maxReplanAttempts: 3,
  loopWindowSize: 6,
  loopSimilarityThreshold: 0.7,
};

// ─── Eval ────────────────────────────────────────────────────────

export interface EvalResult {
  stepIndex: number;
  verdict: "pass" | "weak" | "fail" | "inconclusive";
  reason: string;
}

// ─── Loop Detection ──────────────────────────────────────────────

export interface LoopDetectionResult {
  detected: boolean;
  type?: "exact_cycle" | "semantic_stall";
  description?: string;
  /** 最近的 tool call 摘要快照 */
  windowSnapshot?: string[];
}

// ─── Replan ──────────────────────────────────────────────────────

export interface ReplanDecision {
  shouldReplan: boolean;
  trigger: "eval_fail" | "loop_detected" | "none";
  revisedSteps?: PlanStep[];
  /** 当 autoApprove 为 false 时，replan 仅作为建议，需用户确认 */
  pendingApproval?: boolean;
}

// ─── Events ──────────────────────────────────────────────────────

export type HarnessEventKind = "eval" | "loop_detection" | "replan";

export interface HarnessEvent {
  kind: HarnessEventKind;
  data: EvalResult | LoopDetectionResult | ReplanDecision;
  timestamp: string;
}

// ─── Middleware Result ───────────────────────────────────────────

export interface MiddlewareResult {
  /** 重规划后的新 plan steps（null 表示无变化） */
  updatedPlanSteps?: RuntimePlanStep[];
  /** 需要注入到对话中的消息（如提示 agent 补充验证） */
  injectMessages?: BaseMessage[];
  /** 是否终止执行 */
  abort?: boolean;
  /** 本轮产生的 harness 事件 */
  events: HarnessEvent[];
}
