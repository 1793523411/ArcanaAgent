import { describe, expect, it } from "vitest";
import {
  applyTextProgressToPlan,
  buildStepRegexCache,
  computeCurrentStep,
  createRuntimePlanSteps,
  detectModelGiveUp,
  findFirstPendingStep,
} from "./planTracker.js";
import type { PlanStep } from "./planning.js";

const steps: PlanStep[] = [
  { title: "分析初始概率", acceptance_checks: ["确认初始选中车概率1/3"] },
  { title: "分析主持人行为", acceptance_checks: ["确认主持人必开有山羊的门"] },
  { title: "计算条件概率", acceptance_checks: ["计算换门后获胜概率"] },
];

describe("applyTextProgressToPlan", () => {
  it("marks earlier steps completed when the visible answer reaches a later step at line start", () => {
    const runtime = createRuntimePlanSteps(steps);
    const next = applyTextProgressToPlan(
      runtime,
      "步骤 1: 分析初始概率\n证据：1/3\n\n步骤 2: 分析主持人行为\n"
    );

    expect(computeCurrentStep(next)).toBe(1);
    expect(next[0]).toMatchObject({ completed: true });
    expect(next[1]).toMatchObject({ completed: false });
    expect(next[0].evidences.at(-1)).toContain("分析初始概率");
  });

  it("recognizes checklist completion markers (✅ 步骤N)", () => {
    const runtime = createRuntimePlanSteps(steps);
    const next = applyTextProgressToPlan(
      runtime,
      "执行结果 checklist\n- ✅ 步骤1: 分析初始概率\n- ✅ 步骤2: 分析主持人行为\n"
    );

    expect(computeCurrentStep(next)).toBe(2);
    expect(next[0].completed).toBe(true);
    expect(next[1].completed).toBe(true);
    expect(next[2].completed).toBe(false);
  });

  it("recognizes markdown task list markers ([x] 步骤N)", () => {
    const runtime = createRuntimePlanSteps(steps);
    const next = applyTextProgressToPlan(
      runtime,
      "- [x] 步骤1 分析初始概率\n- [x] 步骤2 分析主持人行为\n- [ ] 步骤3 计算条件概率"
    );

    expect(computeCurrentStep(next)).toBe(2);
    expect(next[0].completed).toBe(true);
    expect(next[1].completed).toBe(true);
    expect(next[2].completed).toBe(false);
  });

  it("recognizes English checklist markers (✅ step N / [x] step N)", () => {
    const runtime = createRuntimePlanSteps(steps);
    const next = applyTextProgressToPlan(
      runtime,
      "Progress:\n- ✅ Step 1 done\n- [x] step 2 done\n"
    );

    expect(computeCurrentStep(next)).toBe(2);
  });

  it("does not advance progress for unrelated text", () => {
    const runtime = createRuntimePlanSteps(steps);

    expect(applyTextProgressToPlan(runtime, "我将按照计划步骤执行任务。")).toBe(runtime);
  });

  it("does not treat negated completion wording as completed (regression: 未完成 + 已完成 mix)", () => {
    const runtime = createRuntimePlanSteps(steps);

    expect(applyTextProgressToPlan(runtime, "步骤1 未完成，缺少概率证据")).toBe(runtime);
    expect(applyTextProgressToPlan(runtime, "步骤1 不通过，需要重算")).toBe(runtime);
    // Regression: the old sliding-window regex would match the trailing "已完成"
    // and incorrectly mark step 1 as complete.
    expect(
      applyTextProgressToPlan(runtime, "步骤1 未完成，但已完成基础调研，所以可以继续")
    ).toBe(runtime);
    // Regression: "无法通过" was caught by the weak (?<![未不])通过 lookbehind.
    expect(applyTextProgressToPlan(runtime, "步骤1 无法通过，需要重试")).toBe(runtime);
    // Regression: "完成不了" satisfied (?<!未)完成 because the preceding char was a space.
    expect(applyTextProgressToPlan(runtime, "步骤1 完成不了，缺乏数据")).toBe(runtime);
  });

  it("does not treat forward-looking planning narration as completed (regression: 内联步骤号)", () => {
    const runtime = createRuntimePlanSteps(steps);

    // "步骤2" appears mid-sentence after "然后开始", so the old logic would treat
    // it as a section header and infer step 1 done. New logic requires the step
    // marker at line start.
    expect(
      applyTextProgressToPlan(runtime, "我将完成步骤1的分析，然后开始步骤2，再做步骤3。")
    ).toBe(runtime);
    expect(applyTextProgressToPlan(runtime, "下一步将完成步骤1")).toBe(runtime);
  });

  it("requires explicit completion markers and ignores narrative '完成'", () => {
    const runtime = createRuntimePlanSteps(steps);

    expect(
      applyTextProgressToPlan(runtime, "步骤1 - 我需要查看代码，然后完成此任务")
    ).toBe(runtime);
  });

  it("buildStepRegexCache lets repeated calls reuse precompiled regexes", () => {
    const runtime = createRuntimePlanSteps(steps);
    const cache = buildStepRegexCache(steps);
    const text = "- ✅ 步骤1\n- ✅ 步骤2\n";

    const a = applyTextProgressToPlan(runtime, text, cache);
    const b = applyTextProgressToPlan(a, text, cache);
    // Idempotent: re-applying the same text returns the same array reference.
    expect(b).toBe(a);
  });
});

describe("findFirstPendingStep", () => {
  it("returns the index of the first uncompleted step", () => {
    const runtime = createRuntimePlanSteps(steps);
    expect(findFirstPendingStep(runtime)).toBe(0);
    runtime[0].completed = true;
    expect(findFirstPendingStep(runtime)).toBe(1);
    runtime[1].completed = true;
    runtime[2].completed = true;
    expect(findFirstPendingStep(runtime)).toBe(-1);
  });
});

describe("detectModelGiveUp", () => {
  it("hits common 中文 surrender phrasings at the end of the answer", () => {
    expect(detectModelGiveUp("当前无法完成此操作，请检查路径。").hit).toBe(true);
    expect(detectModelGiveUp("抱歉，我无法读取该文件。").hit).toBe(true);
    expect(detectModelGiveUp("很遗憾，目前无法访问该资源。").hit).toBe(true);
    expect(detectModelGiveUp("没有相应权限去读取该路径。").hit).toBe(true);
    expect(detectModelGiveUp("需要您手动复制文件到 workspace。").hit).toBe(true);
  });

  it("hits common English surrender phrasings", () => {
    expect(detectModelGiveUp("I'm unable to read this file.").hit).toBe(true);
    expect(detectModelGiveUp("I cannot access that path.").hit).toBe(true);
    expect(detectModelGiveUp("I can't complete this task.").hit).toBe(true);
    expect(detectModelGiveUp("I don't have the permission to do this.").hit).toBe(true);
    expect(detectModelGiveUp("Sorry, I am unable to proceed.").hit).toBe(true);
    expect(detectModelGiveUp("I apologize, but I cannot continue.").hit).toBe(true);
  });

  it("returns matched fragment for diagnostics", () => {
    const r = detectModelGiveUp("分析完成。当前无法完成此操作。");
    expect(r.hit).toBe(true);
    // The regex has multiple alternatives that can match this phrase
    // (either "当前 ... 无法" or "无法完成"); both are acceptable surrender
    // signals — we just want any non-empty matched fragment for logging.
    expect(r.matched && r.matched.length).toBeGreaterThan(0);
    expect(r.matched).toMatch(/无法/);
  });

  it("does NOT trigger on instructional / explanatory prose", () => {
    // 教学/解释类内容里出现 无法/cannot，但不是模型在放弃任务
    expect(detectModelGiveUp("Promise 的 then 回调返回值会被自动包装。这里我们说的是一个新的执行模型。").hit).toBe(false);
    expect(detectModelGiveUp("用户无法直接修改只读字段，所以我们需要……此外，函数返回了正确的结果。").hit).toBe(false);
    expect(detectModelGiveUp("以下三种情况下程序可能 cannot find module: 1. 路径错误 2. 缺依赖 3. 缓存。综上，已成功修复并验证。").hit).toBe(false);
  });

  it("does NOT trigger on empty / short content", () => {
    expect(detectModelGiveUp("").hit).toBe(false);
    expect(detectModelGiveUp("好的").hit).toBe(false);
  });

  it("only inspects the tail window so early '无法' in long answers does not trip", () => {
    // 在 400 字符之前有 "无法"，但结尾是正常总结 → 不应触发
    const prefix = "在分析过程中我发现了用户无法直接修改的只读字段。" + "x".repeat(450);
    const positive = prefix + "总结：所有步骤已正常完成，输出符合预期。";
    expect(detectModelGiveUp(positive).hit).toBe(false);
  });
});
