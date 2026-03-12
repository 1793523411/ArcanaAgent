import { AIMessage, BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { ModelAdapter } from "../llm/adapter.js";

export interface PlanningPrelude {
  planMessage?: AIMessage;
  executionConstraint?: SystemMessage;
  planSteps?: string[];
}

const PLAN_REQUEST_PROMPT = `Before using any tools, provide a compact execution plan in the user's language.

Output format:
PLAN:
1. ...
2. ...
3. ...

Rules:
- 3-10 steps only
- each step must be actionable
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

export function extractPlanSteps(planText: string): string[] {
  const lines = planText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const steps = lines
    .filter((line) => /^(\d+[\).\s]|[-*]\s+)/.test(line))
    .map((line) => line.replace(/^(\d+[\).\s]+|[-*]\s+)/, "").trim())
    .filter(Boolean)
    .slice(0, 10);
  if (steps.length > 0) return steps;
  const compact = lines.filter((line) => !/^plan[:：]?$/i.test(line)).slice(0, 4);
  return compact;
}

function buildExecutionConstraint(planText: string): SystemMessage {
  const steps = extractPlanSteps(planText);
  const compactPlan = steps.length > 0 ? steps.map((s, i) => `${i + 1}. ${s}`).join("\n") : planText.trim();
  const content = `Execution constraint:
You must execute in plan-first mode.
Plan to follow:
${compactPlan}

Rules:
- Execute according to the plan sequence whenever feasible
- If a step fails, repair then continue
- Final answer must include a checklist with [x]/[ ] for each planned step`;
  return new SystemMessage(content);
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
  } catch {
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
