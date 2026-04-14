import { AIMessage, BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { ModelAdapter } from "../llm/adapter.js";
import { serverLogger } from "../lib/logger.js";

export interface PlanningPrelude {
  planMessage?: AIMessage;
  executionConstraint?: HumanMessage;
  planSteps?: PlanStep[];
}

export interface PlanStep {
  title: string;
  acceptance_checks: string[];
}

const PLAN_REQUEST_PROMPT = `Before using any tools, provide a compact execution plan in the user's language.

Output format:
PLAN:
1. <step title> | 验收: <check A>; <check B>
2. <step title> | 验收: <check A>
3. <step title> | 验收: <check A>; <check B>

Rules:
- 3-10 steps only
- each step must be actionable
- each step must include 1-3 acceptance checks
- no tool calls in this turn
- keep under 120 words`;

function getLastHumanText(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg._getType() === "human") {
      const content = msg.content;
      if (typeof content === "string") return content.trim();
      if (Array.isArray(content)) {
        return content
          .map((x) => (typeof x === "string" ? x : (x as { text?: string })?.text ?? ""))
          .join("")
          .trim();
      }
      return "";
    }
  }
  return "";
}

function shouldPlanByText(text: string): boolean {
  if (!text) return false;
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  if (/^(hi|hello|你好|在吗|谢谢|thanks|thx)[!！,. ]*$/.test(normalized)) return false;
  const actionLike =
    /写|创建|新建|修改|重构|实现|修复|调试|执行|运行|分析|排查|测试|脚本|命令|代码|文件|部署|安装|配置|优化|迁移|generate|create|update|fix|debug|run|build|test|refactor|implement|file|code|script/.test(
      normalized
    );
  return actionLike || normalized.length >= 24;
}

export function extractPlanSteps(planText: string): PlanStep[] {
  const lines = planText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const parsed = lines
    .filter((line) => /^(\d+[\).\s]|[-*]\s+)/.test(line))
    .map((line) => line.replace(/^(\d+[\).\s]+|[-*]\s+)/, "").trim())
    .filter(Boolean)
    .slice(0, 10)
    .map((line) => {
      const split = line.split(/\s*\|\s*验收[:：]\s*/i);
      const title = split[0]?.trim() ?? "";
      const checks = (split[1] ?? "")
        .split(/[;；]/)
        .map((c) => c.trim())
        .filter(Boolean)
        .slice(0, 3);
      return {
        title,
        acceptance_checks: checks.length > 0 ? checks : [`验证：${title}`],
      };
    })
    .filter((s) => s.title.length > 0);
  if (parsed.length > 0) return parsed;
  const compact = lines
    .filter((line) => !/^plan[:：]?$/i.test(line))
    .slice(0, 4)
    .map((title) => ({ title, acceptance_checks: [`验证：${title}`] }));
  return compact;
}

function buildExecutionConstraint(planText: string): HumanMessage {
  const steps = extractPlanSteps(planText);
  const compactPlan = steps.length > 0
    ? steps.map((s, i) => `${i + 1}. ${s.title} | 验收: ${s.acceptance_checks.join("; ")}`).join("\n")
    : planText.trim();
  const content = `Execution constraint:
You must execute in plan-first mode.
Plan to follow:
${compactPlan}

Rules:
- Execute according to the plan sequence whenever feasible
- If a step fails, repair then continue
- A step can be marked [x] only if all its acceptance checks are satisfied with evidence
- Final answer must include checklist + evidence for each completed step`;
  return new HumanMessage(content);
}

export async function buildPlanningPrelude(
  adapter: ModelAdapter,
  systemMessage: SystemMessage,
  messages: BaseMessage[],
  enabled = true
): Promise<PlanningPrelude> {
  if (!enabled) return {};
  const latestUserText = getLastHumanText(messages);
  if (!shouldPlanByText(latestUserText)) return {};
  const plannerModel = adapter.getLLM();
  let planResponse: AIMessage;
  try {
    planResponse = await plannerModel.invoke([
      systemMessage,
      ...messages,
      new HumanMessage(PLAN_REQUEST_PROMPT),
    ]) as AIMessage;
  } catch (err) {
    serverLogger.warn("[planning] Plan generation failed, skipping", { error: err instanceof Error ? err.message : String(err) });
    return {};
  }
  const content = typeof planResponse.content === "string"
    ? planResponse.content.trim()
    : Array.isArray(planResponse.content)
      ? planResponse.content
          .map((x) => (typeof x === "string" ? x : (x as { text?: string })?.text ?? ""))
          .join("")
          .trim()
      : "";
  if (!content) return {};
  const planMessage = new AIMessage({ content });
  const executionConstraint = buildExecutionConstraint(content);
  return { planMessage, executionConstraint, planSteps: extractPlanSteps(content) };
}
