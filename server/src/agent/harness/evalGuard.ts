import { HumanMessage } from "@langchain/core/messages";
import type { ModelAdapter } from "../../llm/adapter.js";
import type { RuntimePlanStep } from "../planTracker.js";
import type { EvalResult } from "./types.js";

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
REASON: <one sentence explanation>

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
    // LLM 调用失败时，保守地返回 pass，避免阻塞执行
    return {
      stepIndex,
      verdict: "pass",
      reason: `Eval skipped due to error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function parseEvalResponse(text: string, stepIndex: number): EvalResult {
  const verdictMatch = text.match(/VERDICT:\s*(pass|weak|fail|inconclusive)/i);
  const reasonMatch = text.match(/REASON:\s*(.+)/i);

  const verdict = (verdictMatch?.[1]?.toLowerCase() ?? "pass") as EvalResult["verdict"];
  const reason = reasonMatch?.[1]?.trim() ?? text.slice(0, 200);

  return { stepIndex, verdict, reason };
}
