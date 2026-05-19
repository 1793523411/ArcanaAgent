import { AIMessage, BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { ModelAdapter } from "../llm/adapter.js";

export interface PlanningPrelude {
  planMessage?: AIMessage;
  executionConstraint?: HumanMessage;
  planSteps?: PlanStep[];
}

export interface PlanStep {
  title: string;
  acceptance_checks: string[];
}

const PLAN_REQUEST_PROMPT = `You are about to execute an action-oriented task. Emit a compact INTERNAL plan that you (and the harness) will follow during execution.

Output format:
PLAN:
1. <step title> | 验收: <check A>; <check B>
2. <step title> | 验收: <check A>
3. <step title> | 验收: <check A>; <check B>

Rules:
- 3-10 steps only
- each step must be actionable (it triggers a tool call or produces a concrete artifact)
- each step must include 1-3 acceptance checks
- no tool calls in this turn
- keep under 120 words

IMPORTANT — these acceptance checks are INTERNAL progress-tracking metadata for the harness. Do NOT echo them back to the user in your final answer (no "验收清单 / acceptance checklist / completion checks" section). The user only needs the final result, not the scaffolding.`;

// Puzzle / reasoning / math nouns — "answer this, don't plan-and-execute".
// Split from the explain patterns because we want intent-specific guidance
// downstream: puzzles → "lead with the bottom-line answer in one sentence";
// explanations → "lead with TL;DR / definition, then expand".
const PUZZLE_PATTERNS = [
  /谜题|脑筋急转弯|推理题|逻辑题|思考题/,
  /证明一下|帮我证明|算一下|计算下|帮我算/,
  /多少种|多少个|有几种|几种方法/,
  // Classical brainteaser scaffolding: "constraint + question".
  //   "你只能去房间一次... 怎么知道 ... ？" → 三开关三灯
  //   "只能称三次... 找出哪个球更重？"     → 称球
  //   "只能用一刀切... 怎么平分？"          → 切蛋糕
  // Anchored on ?/？ so casual statements ("我只去过一次北京。") don't
  // false-positive. `[^。！]` keeps the constraint and the question mark on
  // the same sentence so unrelated multi-sentence text doesn't drift in.
  /(只能|只有|只允许)[^。！]{0,30}(一次|两次|三次|N\s*次|n\s*次)[^。！]{0,80}[？?]/i,
];

// Concept / explanation question starters.
//
// Deliberately EXCLUDED:
//   - "请问" (politeness prefix, doesn't define intent — "请问能帮我重构吗" is
//     an action request, not an explain question)
//   - English `do\b` / `are\b` (too broad — "do this for me", "are you sure"
//     are not explain-intent imperatives/checks)
const EXPLAIN_PATTERNS = [
  /^(为什么|为啥|怎么解释|怎么会|如何理解|请解释|解释一下|麻烦解释|帮我理解)/,
  // Mid-string Chinese "what-is" markers (no `^` anchor) covering both
  // formal and colloquial shapes: "什么是闭包", "差异是什么", "啥是闭包",
  // "这个是啥", "啥意思". These are intentionally broad — worst case they
  // give the explain shape to a vague question, which is fine: those
  // messages also don't need the plan-flow scaffolding.
  /什么是|是什么|啥是|是啥|啥意思/,
  /^(why\b|how come\b|explain\b|what is\b|what are\b|what's\b|what does\b|who is\b|when did\b|where is\b|which\b|is it\b|does\b|how does\b|how do\b)/i,
];

const GREETING_PATTERN = /^(hi|hello|你好|在吗|谢谢|thanks|thx)[!！,. ]*$/;

const ACTION_PATTERN =
  /写|创建|新建|修改|重构|实现|修复|调试|执行|运行|分析|排查|测试|脚本|命令|代码|文件|部署|安装|配置|优化|迁移|generate|create|update|fix|debug|run|build|test|refactor|implement|file|code|script/;

export type IntentCategory = "chat" | "puzzle" | "explain" | "code_action" | "default";

// Classify the latest user message into one of five intent buckets so the
// system prompt can attach intent-specific guidance (e.g. puzzles get a sharper
// "lead with the answer in one sentence" nudge than the generic Answer Shape).
//
// Order matters: greetings first (highest precedence), then puzzle/explain
// (these win over action keywords because "解释一下这段代码" mentions "代码"
// but the intent is clearly explanation), then code_action, else default.
export function classifyConversationIntent(text: string): IntentCategory {
  if (!text) return "default";
  const normalized = text.trim().toLowerCase();
  if (!normalized) return "default";
  if (GREETING_PATTERN.test(normalized)) return "chat";
  if (PUZZLE_PATTERNS.some((re) => re.test(normalized))) return "puzzle";
  if (EXPLAIN_PATTERNS.some((re) => re.test(normalized))) return "explain";
  if (ACTION_PATTERN.test(normalized)) return "code_action";
  return "default";
}

function looksLikeQuestionOrPuzzle(normalized: string): boolean {
  return (
    EXPLAIN_PATTERNS.some((re) => re.test(normalized)) ||
    PUZZLE_PATTERNS.some((re) => re.test(normalized))
  );
}

export function getLastHumanText(messages: BaseMessage[]): string {
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

// Trigger planning ONLY when the user is asking for an action / tool-driven task.
//
// Historical bug (2026-05): we used `actionLike || normalized.length >= 24`,
// which meant ANY message ≥24 chars triggered the full PLAN -> execution-constraint
// flow — including puzzles ("三个开关控制三个灯泡…"), concept questions, and
// explanations. With adaptive thinking + high effort the model would then
// dutifully emit a 5-step "PLAN: 1. 明确题目条件… 2. 引入关键观察维度…" wall of
// meta-language and a user-facing acceptance checklist, burying the actual
// answer. See `todo.md` "Planning / Plan tracker — UX 减肥" for the discussion.
//
// New rule (delegated to the intent classifier): only the `code_action`
// bucket triggers planning. Puzzle / explain / chat / default short-circuit
// straight to the model with no plan scaffolding.
function shouldPlanByText(text: string): boolean {
  return classifyConversationIntent(text) === "code_action";
}

export const __planningInternals = { shouldPlanByText, looksLikeQuestionOrPuzzle };

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
  const content = `Execution constraint (INTERNAL — do NOT echo this scaffolding back to the user):
You must execute in plan-first mode.
Plan to follow:
${compactPlan}

Rules:
- Execute according to the plan sequence whenever feasible
- If a step fails, repair then continue
- A step is internally marked [x] only when its acceptance checks are satisfied with evidence
- Final user-facing answer focuses on the result and supporting reasoning. Do NOT emit a "验收清单 / acceptance checklist / completion checks" section — those are internal progress-tracking artifacts and belong in your reasoning channel, not in the visible reply.`;
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
