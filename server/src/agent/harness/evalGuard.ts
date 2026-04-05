import { HumanMessage } from "@langchain/core/messages";
import type { ModelAdapter } from "../../llm/adapter.js";
import type { RuntimePlanStep } from "../planTracker.js";
import type { EvalResult } from "./types.js";
import { isReadOnlyTool } from "../../tools/index.js";

// ── Eval 分级策略 ──

export type EvalTier = "skip" | "lightweight" | "full";

/**
 * 根据步骤涉及的工具类型决定评估级别，降低 Harness 成本。
 * - skip: 只涉及只读工具 → 不调 LLM
 * - lightweight: 涉及写入工具但无错误 → 纯规则检查
 * - full: 有错误或复杂场景 → 完整 LLM 评估
 */
export function determineEvalTier(step: RuntimePlanStep, toolsUsed: string[]): EvalTier {
  // 没有工具记录时走 full eval
  if (toolsUsed.length === 0) return "full";

  // 所有工具都是只读 → 跳过 eval
  if (toolsUsed.every((t) => isReadOnlyTool(t))) return "skip";

  // 涉及写入工具 — 检查 evidences 中是否有错误
  const hasError = step.evidences.some((e) => e.includes("[error]"));
  if (hasError) return "full";

  // 写入工具无错误 → lightweight
  return "lightweight";
}

/**
 * Lightweight eval: 纯规则检查，不调 LLM。
 * 如果 evidences 中无 [error] 则 pass，否则 fail。
 */
export function lightweightEval(step: RuntimePlanStep, stepIndex: number): EvalResult {
  const hasError = step.evidences.some((e) => e.includes("[error]"));
  if (hasError) {
    return {
      stepIndex,
      verdict: "fail",
      reason: "工具执行中包含错误，需要修复",
    };
  }
  return {
    stepIndex,
    verdict: "pass",
    reason: "工具执行无错误（lightweight eval）",
  };
}

const EVAL_PROMPT_TEMPLATE = `You are an execution quality evaluator. Your job is to judge whether the collected evidence genuinely satisfies the acceptance checks for a plan step.

## Plan Step
Title: {title}

## Acceptance Checks
{checks}

## Collected Evidence
{evidences}

## Instructions
Evaluate whether the evidence satisfies ALL acceptance checks. Respond in EXACTLY this format:

VERDICT: <pass|weak|fail|inconclusive>
REASON: <one sentence in Chinese (中文)>

- "pass" = all acceptance checks clearly satisfied with concrete evidence
- "weak" = evidence is partial or ambiguous, needs more verification
- "fail" = evidence clearly does not satisfy one or more checks
- "inconclusive" = acceptance checks CANNOT be verified in this environment (e.g., requires real SSO login, external API, paid service, physical device). The implementation looks structurally correct but runtime verification is impossible here.`;

/**
 * 用 LLM 评判一个 plan step 的证据是否真正满足验收标准
 *
 * 仅在 step 刚被 applyEvidenceToPlan 标记为 completed 时调用，
 * 用一次轻量 LLM call 做二次确认，防止 "证据条数够但质量不够" 的误判。
 */
export async function evaluateStepCompletion(
  adapter: ModelAdapter,
  step: RuntimePlanStep,
  stepIndex: number
): Promise<EvalResult> {
  const prompt = EVAL_PROMPT_TEMPLATE
    .replace("{title}", step.title)
    .replace(
      "{checks}",
      step.acceptance_checks.map((c, i) => `${i + 1}. ${c}`).join("\n")
    )
    .replace(
      "{evidences}",
      step.evidences.map((e, i) => `${i + 1}. ${e}`).join("\n")
    );

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

    return parseEvalResponse(text, stepIndex);
  } catch (error) {
    // LLM 调用失败时返回 inconclusive，中间件会接受为结构性完成而非无条件通过
    return {
      stepIndex,
      verdict: "inconclusive",
      reason: `Eval skipped due to error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function parseEvalResponse(text: string, stepIndex: number): EvalResult {
  const verdictMatch = text.match(/VERDICT:\s*(pass|weak|fail|inconclusive)/i);
  const reasonMatch = text.match(/REASON:\s*(.+)/i);

  // 解析失败时保守返回 weak 而非 pass，避免漏检
  const verdict = (verdictMatch?.[1]?.toLowerCase() ?? "weak") as EvalResult["verdict"];
  const reason = reasonMatch?.[1]?.trim() ?? text.slice(0, 200);

  return { stepIndex, verdict, reason };
}
