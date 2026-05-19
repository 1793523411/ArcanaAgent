import type { PlanStep } from "./planning.js";

export type RuntimePlanStep = PlanStep & {
  evidences: string[];
  completed: boolean;
};

export function createRuntimePlanSteps(steps: PlanStep[]): RuntimePlanStep[] {
  return steps.map((s) => ({
    ...s,
    evidences: [],
    completed: false,
  }));
}

export function summarizeToolEvidence(toolName: string | undefined, output: string): string {
  const oneLine = output.replace(/\s+/g, " ").trim();
  const short = oneLine.length > 180 ? `${oneLine.slice(0, 180)}…` : oneLine;
  return toolName ? `${toolName}: ${short || "(no output)"}` : (short || "(no output)");
}

export function summarizeTextEvidence(step: PlanStep, stepIndex: number): string {
  const checks = step.acceptance_checks.length > 0
    ? `；验收：${step.acceptance_checks.join("；")}`
    : "";
  return `文本输出已推进步骤 ${stepIndex + 1}：${step.title}${checks}`;
}

export function applyEvidenceToPlan(steps: RuntimePlanStep[], evidence: string): RuntimePlanStep[] {
  const firstPending = steps.findIndex((s) => !s.completed);
  if (firstPending < 0) return steps;
  const target = steps[firstPending];
  const nextEvidences = [...target.evidences, evidence].slice(-6);
  const requiredChecks = Math.max(1, target.acceptance_checks.length);
  const completed = nextEvidences.length >= requiredChecks;
  // 保留严格门槛：证据条数需覆盖验收项数量，避免"单条证据"导致步骤过早完成。
  const cloned = [...steps];
  cloned[firstPending] = {
    ...target,
    evidences: nextEvidences,
    completed,
  };
  return cloned;
}

// ─── Text-based plan progress (heuristic) ──────────────────────────────────
//
// 历史背景：早期实现用 `步骤N + [^\n]{0,160} + (完成|通过|done|✅)` 的滑窗匹配，
// 对真实 LLM 输出有大量假阳性：
//   - "步骤1 未完成，但已完成基础调研" → 误命中末尾 "已完成"
//   - "步骤1 无法通过" → 弱否定保护 (?<![未不]) 漏判 "无"
//   - "我将完成步骤1，然后开始步骤2" → 被后续 "步骤2" 标记位前推
//   - "完成不了" → 也命中 "完成"
//
// 修复策略 (2025-Q2)：只接受**强信号**——明确的 checklist / 完成标记 / 行首标题。
// 叙述性文本一律不推进 plan。代价：模型必须用规范化的清单格式才能让 plan tracker
// 跟上；好处：彻底消除 false positive，保护既有 tool-evidence 门槛 (applyEvidenceToPlan)
// 的语义不被叙述性文本绕过。
//
// 注意：当 plan 无 tool 参与（纯叙述/分析类任务）时，这里的强信号仍是唯一的进度来源，
// 因此保留"直接置 completed"的语义（不强求 acceptance_checks 计数），与 tool evidence
// 路径形成两条互补但都明确的进入条件。

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 仅匹配出现在行首（或受常见列表/标题前缀引导）的步骤标记位。 */
function buildStepMarkerRegex(step: PlanStep, stepIndex: number): RegExp {
  const n = stepIndex + 1;
  const title = escapeRegExp(step.title.trim());
  // (?:^|\n)[\s\-*#>0-9.]{0,8} 限定出现在行首附近，最多吃掉 8 个 markdown/列表前缀字符。
  // 这避免 "我将完成步骤1, 然后步骤2" 这种内联叙述被当成步骤标题。
  const linePrefix = `(?:^|\\n)[\\s\\-*#>0-9.()]{0,8}`;
  const numbered = `(?:步骤|step|第)\\s*${n}(?:\\s*步)?[\\s::\\-—.、]`;
  // 步骤标题（去重后）作为额外触发条件，且必须独立成段。
  const titleAlt = title ? `|${linePrefix}${title}` : "";
  return new RegExp(`(?:${linePrefix}${numbered}${titleAlt})`, "i");
}

/** 仅匹配明确的 checklist / 完成标记，不接受叙述性 "...完成..." 模式。 */
function buildStepCompletedRegex(stepIndex: number): RegExp {
  const n = stepIndex + 1;
  const stepWord = `(?:步骤|step)\\s*${n}\\b`;
  return new RegExp(
    `(?:` +
      // ✅ 步骤N / ☑ 步骤N / ✓ 步骤N
      `[✅✓✔☑]\\s*${stepWord}` +
      `|` +
      // 步骤N ✅（标记位紧跟在步骤号之后，最多隔 8 个字符如冒号/标题）
      `${stepWord}[^\\n]{0,8}[✅✓✔☑]` +
      `|` +
      // - [x] 步骤N / [x] step N（markdown 任务列表）
      `\\[\\s*[xX]\\s*\\][^\\n]{0,8}${stepWord}` +
    `)`,
    "i"
  );
}

interface StepRegexCache {
  marker: RegExp;
  completed: RegExp;
}

/** 预编译每个 step 的正则，避免在 token 流的每次回调里重复 new RegExp。 */
export function buildStepRegexCache(steps: PlanStep[]): StepRegexCache[] {
  return steps.map((step, idx) => ({
    marker: buildStepMarkerRegex(step, idx),
    completed: buildStepCompletedRegex(idx),
  }));
}

function inferCompletedCountFromText(
  steps: RuntimePlanStep[],
  text: string,
  cache?: StepRegexCache[]
): number {
  if (!text.trim()) return 0;

  const regexes = cache ?? buildStepRegexCache(steps);
  let inferred = 0;
  for (let i = 0; i < steps.length; i++) {
    if (regexes[i].completed.test(text)) {
      inferred = Math.max(inferred, i + 1);
    }
    if (i + 1 < steps.length && regexes[i + 1].marker.test(text)) {
      inferred = Math.max(inferred, i + 1);
    }
  }
  return inferred;
}

export function applyTextProgressToPlan(
  steps: RuntimePlanStep[],
  text: string,
  cache?: StepRegexCache[]
): RuntimePlanStep[] {
  const completedCount = inferCompletedCountFromText(steps, text, cache);
  if (completedCount <= 0) return steps;

  let changed = false;
  const next = steps.map((step, idx) => {
    if (idx >= completedCount || step.completed) return step;
    changed = true;
    const evidence = summarizeTextEvidence(step, idx);
    return {
      ...step,
      evidences: step.evidences.includes(evidence) ? step.evidences : [...step.evidences, evidence].slice(-6),
      completed: true,
    };
  });
  return changed ? next : steps;
}

export function computeCurrentStep(steps: RuntimePlanStep[]): number {
  let done = 0;
  for (const step of steps) {
    if (!step.completed) break;
    done += 1;
  }
  return done;
}

export function forceCompletePlan(steps: RuntimePlanStep[]): RuntimePlanStep[] {
  return steps.map((step) => ({
    ...step,
    completed: true,
  }));
}

// ─── Give-up detection ─────────────────────────────────────────────────────
//
// Background: when a model emits a final turn with `toolCalls.length === 0`,
// the orchestrator unconditionally calls `forceCompletePlan` to avoid leaving
// the plan UI stuck in "running" forever. Side effect: if the model just gave
// up (e.g. "无法完成此操作 / I'm unable to ..."), every remaining step is
// flipped to `completed: true`, evalGuard never sees them, and the harness
// driver decides the iteration finished cleanly — masking the real failure.
//
// `detectModelGiveUp` is a focused, conservative heuristic for that surrender
// pattern. It only inspects the tail (last `WINDOW` chars) of the final
// answer — i.e. the conclusion paragraph — to avoid false positives on
// teaching/explanatory text that legitimately uses words like 无法/cannot
// earlier in the body.

const GIVE_UP_TAIL_WINDOW = 400;

/**
 * Patterns that strongly signal "the model is giving up on the request",
 * not "the model is explaining a concept that involves 'cannot'".
 * Each alternative requires a verb cluster that targets the user's task.
 */
const GIVE_UP_PATTERN = new RegExp(
  [
    // 中文：无法/不能/未能/没法/没能 + (完成|执行|读取|访问|获取|找到|得到|实现|继续|帮你|为您|为你)
    "(?:无法|不能|未能|没法|没能|没办法)(?:[\\s\\S]{0,4})(?:完成|执行|读取|访问|获取|找到|得到|实现|继续|帮(?:你|您|您完成)|为(?:你|您))",
    // 中文：抱歉/对不起 ... 无法/不能
    "(?:抱歉|对不起|很遗憾)[\\s\\S]{0,30}(?:无法|不能|未能)",
    // 中文：没有 + (权限|工具|可用工具|相应权限|访问权限)
    "没有(?:相应)?(?:权限|工具|可用工具|访问权限|读取权限)",
    // 中文：当前/此处 + 无法/没办法
    "(?:当前|目前|此处|本会话|这个环境)(?:[\\s\\S]{0,10})(?:无法|不能|没办法|没有办法)",
    // 中文：需要您/请您手动
    "(?:需要|请)(?:您|你)(?:[\\s\\S]{0,10})(?:手动|自行|亲自|自己)",
    // 英文：I'm unable to / I am unable to / I'm not able to
    "\\bI(?:'m| am|\\s+am)?\\s+(?:unable|not\\s+able)\\s+to\\b",
    // 英文：I cannot / I can't
    "\\bI\\s+can(?:not|'?t)\\b",
    // 英文：I don't have the ability/access/permission
    "\\bI\\s+do(?:n'?t| not)\\s+have\\s+(?:the\\s+)?(?:ability|access|permission|tools?)\\b",
    // 英文：Sorry,? (I) can(not|'t) | am unable
    "\\b(?:Sorry|Apologies),?\\s+(?:I\\s+)?(?:can(?:not|'?t)|am\\s+unable)\\b",
    // 英文：I apologize ... cannot/unable
    "\\bI\\s+apologize[\\s\\S]{0,60}(?:can(?:not|'?t)|unable)\\b",
  ].join("|"),
  "i"
);

export interface GiveUpDetection {
  hit: boolean;
  /** The matched fragment, useful for logging / eval reason text. */
  matched?: string;
}

/**
 * Detect whether the final model answer reads as an explicit surrender
 * ("can't complete the task"). Only inspects the trailing
 * GIVE_UP_TAIL_WINDOW characters so educational prose earlier in the body
 * doesn't trip false positives.
 */
export function detectModelGiveUp(content: string): GiveUpDetection {
  if (!content) return { hit: false };
  const tail = content.length > GIVE_UP_TAIL_WINDOW
    ? content.slice(-GIVE_UP_TAIL_WINDOW)
    : content;
  const match = tail.match(GIVE_UP_PATTERN);
  if (!match) return { hit: false };
  return { hit: true, matched: match[0] };
}

/**
 * Locate the first step that has not yet been completed.
 * Returns -1 if every step is already completed.
 */
export function findFirstPendingStep(steps: RuntimePlanStep[]): number {
  return steps.findIndex((s) => !s.completed);
}
