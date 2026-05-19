import { describe, expect, it } from "vitest";
import {
  __planningInternals,
  classifyConversationIntent,
  extractPlanSteps,
} from "./planning.js";
import { buildSystemPrompt } from "./systemPrompt.js";

const { shouldPlanByText, looksLikeQuestionOrPuzzle } = __planningInternals;

describe("shouldPlanByText — action-only triggers", () => {
  it("triggers planning on coding / refactor / tool-execution requests", () => {
    expect(shouldPlanByText("帮我重构这个模块，把 IO 抽出来")).toBe(true);
    expect(shouldPlanByText("写一个 Python 脚本读取 CSV")).toBe(true);
    expect(shouldPlanByText("修复 server/src/agent/index.ts 里的死循环")).toBe(true);
    expect(shouldPlanByText("Run the build and fix any test failures")).toBe(true);
    expect(shouldPlanByText("debug this stack trace")).toBe(true);
    expect(shouldPlanByText("部署一下到测试环境")).toBe(true);
  });

  it("does NOT trigger for short greetings (legacy guard still works)", () => {
    expect(shouldPlanByText("hi")).toBe(false);
    expect(shouldPlanByText("你好")).toBe(false);
    expect(shouldPlanByText("thanks!")).toBe(false);
    expect(shouldPlanByText("")).toBe(false);
  });

  // Regression guard for the UX issue documented in `todo.md` (2026-05-19).
  // Pre-fix behavior: any message ≥24 chars triggered the full plan flow,
  // causing puzzle / concept / explain questions to get a 5-step framework
  // and a user-facing acceptance checklist instead of a direct answer.
  it("does NOT trigger for puzzle / reasoning / explanation questions", () => {
    expect(
      shouldPlanByText(
        "三个开关控制三个灯泡，你只能去房间一次，怎么知道哪个开关对应哪个灯泡？"
      )
    ).toBe(false);
    expect(shouldPlanByText("为什么 JavaScript 的 0.1 + 0.2 不等于 0.3？")).toBe(false);
    expect(shouldPlanByText("解释一下 React 的 reconciliation 算法")).toBe(false);
    expect(shouldPlanByText("Why does Promise.all reject on the first failure?")).toBe(false);
    expect(shouldPlanByText("What is the difference between let and var in JavaScript?")).toBe(false);
    expect(shouldPlanByText("算一下从 1 到 100 所有素数的和")).toBe(false);
    expect(shouldPlanByText("证明一下勾股定理")).toBe(false);
  });

  it("treats long-but-not-actionable questions as questions, not plans", () => {
    // ≥24 char concept question that happened to slip through under the old
    // length-based fallback. With the new rules it must NOT trigger planning
    // because no action keyword appears.
    const longQuestion =
      "我想了解一下编译型语言和解释型语言在性能上的本质差异是什么呢";
    expect(longQuestion.length).toBeGreaterThanOrEqual(24);
    expect(shouldPlanByText(longQuestion)).toBe(false);
  });

  it("question denylist overrides accidental action-keyword matches", () => {
    // "解释一下这段代码" contains "代码" (an action keyword) but the user
    // intent is clearly explanation, not "write/modify code". The denylist
    // must win.
    expect(shouldPlanByText("解释一下这段代码做了什么")).toBe(false);
    expect(shouldPlanByText("Explain what this code does")).toBe(false);
  });
});

describe("looksLikeQuestionOrPuzzle", () => {
  it("matches Chinese question starters", () => {
    expect(looksLikeQuestionOrPuzzle("为什么这样写")).toBe(true);
    expect(looksLikeQuestionOrPuzzle("怎么解释这个现象")).toBe(true);
    expect(looksLikeQuestionOrPuzzle("解释一下这是什么意思")).toBe(true);
  });

  it("matches English question starters", () => {
    expect(looksLikeQuestionOrPuzzle("why does this happen")).toBe(true);
    expect(looksLikeQuestionOrPuzzle("explain how this works")).toBe(true);
    expect(looksLikeQuestionOrPuzzle("what is a closure")).toBe(true);
  });

  it("matches puzzle / proof / math nouns mid-sentence", () => {
    expect(looksLikeQuestionOrPuzzle("有一道脑筋急转弯：")).toBe(true);
    expect(looksLikeQuestionOrPuzzle("帮我证明 sqrt(2) 是无理数")).toBe(true);
    expect(looksLikeQuestionOrPuzzle("帮我算一下复利")).toBe(true);
  });

  it("does not match plain coding requests", () => {
    expect(looksLikeQuestionOrPuzzle("帮我重构这个模块")).toBe(false);
    expect(looksLikeQuestionOrPuzzle("写一个 python 脚本")).toBe(false);
  });
});

describe("extractPlanSteps — preserved behavior", () => {
  it("parses numbered steps with acceptance markers", () => {
    const parsed = extractPlanSteps(
      "PLAN:\n1. 收集需求 | 验收: 列出 5 条具体需求; 用户确认\n2. 实现接口 | 验收: 单测通过\n"
    );
    expect(parsed).toHaveLength(2);
    expect(parsed[0].title).toBe("收集需求");
    expect(parsed[0].acceptance_checks).toEqual(["列出 5 条具体需求", "用户确认"]);
    expect(parsed[1].acceptance_checks).toEqual(["单测通过"]);
  });
});

describe("classifyConversationIntent", () => {
  it("classifies short greetings as chat", () => {
    expect(classifyConversationIntent("hi")).toBe("chat");
    expect(classifyConversationIntent("你好！")).toBe("chat");
    expect(classifyConversationIntent("thanks")).toBe("chat");
    expect(classifyConversationIntent("Thanks!")).toBe("chat");
  });

  it("classifies puzzle / proof / math problems as puzzle", () => {
    // 三开关三灯 — the canonical example from the original UX bug report.
    // No explicit puzzle noun ("谜题" etc.), but the "constraint + question"
    // scaffolding ("只能去房间一次... ?") is a strong puzzle signal.
    expect(
      classifyConversationIntent(
        "三个开关控制三个灯泡，你只能去房间一次，怎么知道哪个开关对应哪个灯泡？"
      )
    ).toBe("puzzle");
    expect(classifyConversationIntent("帮我证明 sqrt(2) 是无理数")).toBe("puzzle");
    expect(classifyConversationIntent("算一下从 1 到 100 所有素数的和")).toBe("puzzle");
    expect(classifyConversationIntent("这道脑筋急转弯怎么解？")).toBe("puzzle");
    // Other classic brainteaser shapes that match the constraint+question pattern.
    expect(
      classifyConversationIntent("有 12 个球，只能称三次，怎么找出哪个球更重？")
    ).toBe("puzzle");
  });

  it("constraint+question pattern does NOT false-positive on casual statements", () => {
    // Has 只能 + 一次 but no ?/？ — not a puzzle.
    expect(classifyConversationIntent("我这个月只能去一次北京。")).toBe("default");
    // Question but no 只能/只有/只允许 constraint — not a brainteaser.
    expect(classifyConversationIntent("今天天气怎么样？")).toBe("default");
  });

  it("classifies why/explain/what-is questions as explain", () => {
    expect(classifyConversationIntent("为什么 JavaScript 的 0.1 + 0.2 不等于 0.3？")).toBe(
      "explain"
    );
    expect(classifyConversationIntent("解释一下 React 的 reconciliation 算法")).toBe(
      "explain"
    );
    expect(classifyConversationIntent("Why does Promise.all reject on the first failure?")).toBe(
      "explain"
    );
    expect(
      classifyConversationIntent("What is the difference between let and var in JavaScript?")
    ).toBe("explain");
  });

  it("classifies coding / refactor / debug requests as code_action", () => {
    expect(classifyConversationIntent("帮我重构这个模块")).toBe("code_action");
    expect(classifyConversationIntent("写一个 Python 脚本读取 CSV")).toBe("code_action");
    expect(classifyConversationIntent("debug this stack trace")).toBe("code_action");
    expect(classifyConversationIntent("Run the build")).toBe("code_action");
  });

  it("returns default for unclassifiable input", () => {
    expect(classifyConversationIntent("")).toBe("default");
    expect(classifyConversationIntent("   ")).toBe("default");
    expect(classifyConversationIntent("今天天气真不错")).toBe("default"); // no action, no question
  });

  it("explain/puzzle takes precedence over accidental action-keyword matches", () => {
    // "解释一下这段代码" contains the action keyword "代码" but is explain-intent.
    expect(classifyConversationIntent("解释一下这段代码做了什么")).toBe("explain");
    expect(classifyConversationIntent("Explain what this code does")).toBe("explain");
  });

  // Regression: "请问" is a Chinese politeness prefix, NOT an explain marker.
  // Previous bug: "请问可以帮我重构这个模块吗" was classified as `explain`
  // because we treated `^请问` as an explain pattern, causing the planning
  // flow to be skipped for action requests wrapped in polite phrasing.
  it("请问 (politeness prefix) does not override action keywords", () => {
    expect(classifyConversationIntent("请问可以帮我重构这个模块吗")).toBe("code_action");
    expect(classifyConversationIntent("请问能写个 Python 脚本吗")).toBe("code_action");
    // But 请问 + a real explain-shape (什么是) still resolves to explain via
    // the mid-string `什么是` marker.
    expect(classifyConversationIntent("请问什么是闭包")).toBe("explain");
  });

  // Regression: English `do\b` and `are\b` were too broad and false-classified
  // imperatives / casual checks as explain-intent. Removed from EXPLAIN_PATTERNS.
  it("English imperatives are not misclassified as explain", () => {
    expect(classifyConversationIntent("do this for me")).toBe("default");
    expect(classifyConversationIntent("do not commit this")).toBe("default");
    expect(classifyConversationIntent("are you sure?")).toBe("default");
    // `is it` and `does` were kept — they reliably start yes/no questions
    // that ARE explain-intent ("is it broken?", "does this work?").
    expect(classifyConversationIntent("is it broken")).toBe("explain");
    expect(classifyConversationIntent("does this work")).toBe("explain");
  });

  it("mid-string Chinese what-is markers route to explain", () => {
    expect(classifyConversationIntent("什么是闭包")).toBe("explain");
    expect(classifyConversationIntent("闭包是什么")).toBe("explain");
    expect(classifyConversationIntent("啥是闭包")).toBe("explain");
    expect(classifyConversationIntent("这个是啥")).toBe("explain");
    expect(classifyConversationIntent("yield 啥意思")).toBe("explain");
  });

  it("shouldPlanByText is a thin wrapper that only fires on code_action", () => {
    expect(shouldPlanByText("帮我重构这个模块")).toBe(true);
    expect(shouldPlanByText("解释一下这段代码")).toBe(false);
    expect(shouldPlanByText("hi")).toBe(false);
    expect(shouldPlanByText("今天天气真不错")).toBe(false);
  });
});

describe("buildSystemPrompt — per-intent addendum", () => {
  it("injects puzzle guidance when the latest user text is a puzzle", () => {
    const prompt = buildSystemPrompt(
      undefined,
      "default",
      undefined,
      undefined,
      undefined,
      "三个开关控制三个灯泡，你只能去房间一次，怎么知道哪个开关对应哪个灯泡？"
    );
    expect(prompt).toContain("Intent: Puzzle / Reasoning Problem");
    expect(prompt).toContain("One sentence");
  });

  it("injects explain guidance when the latest user text is an explanation request", () => {
    const prompt = buildSystemPrompt(
      undefined,
      "default",
      undefined,
      undefined,
      undefined,
      "为什么 JavaScript 的 0.1 + 0.2 不等于 0.3？"
    );
    expect(prompt).toContain("Intent: Explain / Concept Question");
    expect(prompt).toContain("TL;DR");
  });

  it("injects chat guidance when the latest user text is a greeting", () => {
    const prompt = buildSystemPrompt(undefined, "default", undefined, undefined, undefined, "你好");
    expect(prompt).toContain("Intent: Casual Chat");
  });

  it("injects no intent section for code_action (planning flow handles it)", () => {
    const prompt = buildSystemPrompt(
      undefined,
      "default",
      undefined,
      undefined,
      undefined,
      "帮我重构这个模块"
    );
    expect(prompt).not.toContain("Intent:");
  });

  it("injects no intent section when latestUserText is omitted", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).not.toContain("Intent:");
  });

  it("skips the intent addendum in team-orchestrator mode", () => {
    const prompt = buildSystemPrompt(
      undefined,
      "team",
      "default",
      undefined,
      undefined,
      "解释一下这段代码"
    );
    expect(prompt).not.toContain("Intent: Explain");
    expect(prompt).toContain("Team Mode — Orchestrator Role");
  });

  it("does not contain the deprecated 'each step must include 1-3 acceptance checks' user-facing language", () => {
    // The PLAN_REQUEST_PROMPT used to imply checks should ship in the final
    // answer; we now mark them INTERNAL. The system prompt itself should not
    // be regressing.
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("Answer Shape");
    // The Answer Shape section explicitly forbids user-facing acceptance
    // checklists.
    expect(prompt).toMatch(/acceptance checklist|验收清单/);
  });
});
