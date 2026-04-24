import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanGuildDir } from "../test-setup.js";
import {
  extractJson,
  findBalancedJsonSpans,
  deepSanitize,
  normalizeGroupPlan,
  normalizePipelinePlan,
} from "./aiDesigner.js";
import { createAgent } from "./guildManager.js";

// ─── extractJson ───────────────────────────────────────────────

describe("extractJson", () => {
  it("parses a bare JSON object", () => {
    expect(extractJson('{"x":1}')).toEqual({ x: 1 });
  });

  it("parses JSON inside a ```json``` fence", () => {
    const input = 'prose before\n```json\n{"x":2}\n```\nprose after';
    expect(extractJson(input)).toEqual({ x: 2 });
  });

  it("parses JSON inside an unlabeled ``` fence", () => {
    const input = "here you go:\n```\n{\"y\":3}\n```";
    expect(extractJson(input)).toEqual({ y: 3 });
  });

  it("extracts the biggest balanced JSON from surrounding chatter", () => {
    const input = 'I analyzed it, here is the plan: {"a":1,"nested":{"b":2}} thanks';
    expect(extractJson(input)).toEqual({ a: 1, nested: { b: 2 } });
  });

  it("is quote-aware — braces inside strings don't throw off balancing", () => {
    // The reasoning text includes "{" but it's inside a JSON string.
    const input = '```json\n{"msg":"this } is in a string","ok":true}\n```';
    expect(extractJson(input)).toEqual({ msg: "this } is in a string", ok: true });
  });

  it("prefers the longest balanced span among multiple candidates", () => {
    // Two objects in the response: a small one and the real plan. Want the larger.
    const input = 'small: {"x":1}. big: {"real":true,"steps":[1,2,3,4]}';
    expect(extractJson(input)).toEqual({ real: true, steps: [1, 2, 3, 4] });
  });

  it("falls back through fenced, balanced, and whole content", () => {
    // Code fence is invalid JSON; balanced span later is valid.
    const input = '```\nnot json\n```\nbut this is: {"ok":1}';
    expect(extractJson(input)).toEqual({ ok: 1 });
  });

  it("throws on no valid JSON anywhere", () => {
    expect(() => extractJson("just prose, no JSON here")).toThrow(/无法解析/);
  });
});

// ─── findBalancedJsonSpans ────────────────────────────────────

describe("findBalancedJsonSpans", () => {
  it("finds a single object", () => {
    expect(findBalancedJsonSpans("{}")).toEqual(["{}"]);
  });

  it("finds adjacent spans", () => {
    expect(findBalancedJsonSpans('{"a":1}{"b":2}')).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("handles nested braces", () => {
    expect(findBalancedJsonSpans('{"a":{"b":1}}')).toEqual(['{"a":{"b":1}}']);
  });

  it("respects escaped quotes inside strings", () => {
    // The } in the string and the escaped quote must not confuse balancing.
    const input = '{"s":"he said \\"}\\""}';
    expect(findBalancedJsonSpans(input)).toEqual([input]);
  });
});

// ─── deepSanitize ─────────────────────────────────────────────

describe("deepSanitize", () => {
  it("strips top-level __proto__ / constructor / prototype keys", () => {
    const raw = { a: 1, __proto__: { polluted: true }, constructor: { bad: 1 }, prototype: "x" };
    expect(deepSanitize(raw)).toEqual({ a: 1 });
  });

  it("strips pollution keys at any nested depth", () => {
    const raw = { outer: { inner: { __proto__: { polluted: true }, safe: "ok" } } };
    expect(deepSanitize(raw)).toEqual({ outer: { inner: { safe: "ok" } } });
  });

  it("strips pollution inside arrays", () => {
    const raw = [{ __proto__: { polluted: true }, a: 1 }, { b: 2 }];
    expect(deepSanitize(raw)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("returns undefined past the max recursion depth", () => {
    // Build a chain deeper than the 12-level cap.
    let nested: unknown = { leaf: 1 };
    for (let i = 0; i < 20; i++) nested = { next: nested };
    const cleaned = deepSanitize(nested);
    // Walk down — at some point we should hit undefined rather than infinite descent.
    let cur: unknown = cleaned;
    let depth = 0;
    while (cur && typeof cur === "object" && "next" in (cur as object)) {
      cur = (cur as { next: unknown }).next;
      depth++;
      if (depth > 30) break; // runaway guard
    }
    expect(depth).toBeLessThanOrEqual(13); // cap of 12 leaves a final sentinel
  });

  it("passes through primitives unchanged", () => {
    expect(deepSanitize(42)).toBe(42);
    expect(deepSanitize("str")).toBe("str");
    expect(deepSanitize(null)).toBe(null);
    expect(deepSanitize(undefined)).toBe(undefined);
  });
});

// ─── normalizeGroupPlan (with real guild data for reuse checks) ─

describe("normalizeGroupPlan", () => {
  beforeEach(() => cleanGuildDir());
  afterEach(() => cleanGuildDir());

  const mkAgent = (name: string) =>
    createAgent({
      name,
      description: "t",
      icon: "🤖",
      color: "#3B82F6",
      systemPrompt: "p",
      allowedTools: ["*"],
    });

  it("accepts a minimal plan", () => {
    const raw = {
      group: { name: "G", description: "d" },
      agents: [
        { action: "create", spec: { name: "A", description: "a", icon: "🤖", color: "#3B82F6", systemPrompt: "sp" } },
      ],
    };
    const plan = normalizeGroupPlan(raw);
    expect(plan.group.name).toBe("G");
    expect(plan.agents).toHaveLength(1);
    expect(plan.agents[0].action).toBe("create");
  });

  it("drops reuse items whose agentId does not exist", () => {
    const raw = {
      group: { name: "G", description: "d" },
      agents: [
        { action: "reuse", agentId: "ghost-agent-does-not-exist" },
        { action: "create", spec: { name: "A", systemPrompt: "sp" } },
      ],
    };
    const plan = normalizeGroupPlan(raw);
    expect(plan.agents).toHaveLength(1);
    expect(plan.agents[0].action).toBe("create");
  });

  it("keeps reuse items that reference existing agents", () => {
    const a = mkAgent("real");
    const raw = {
      group: { name: "G", description: "d" },
      agents: [{ action: "reuse", agentId: a.id }],
    };
    const plan = normalizeGroupPlan(raw);
    expect(plan.agents).toHaveLength(1);
    expect(plan.agents[0]).toMatchObject({ action: "reuse", agentId: a.id });
  });

  it("remaps leadIndex after filtering dropped agents", () => {
    const real = mkAgent("real");
    // Original LLM indices: [0 ghost, 1 real, 2 create]. leadIndex=1 means "real".
    // After filter, indices become [0 real, 1 create]. leadIndex should remap to 0.
    const raw = {
      group: { name: "G", description: "d" },
      agents: [
        { action: "reuse", agentId: "ghost" },
        { action: "reuse", agentId: real.id },
        { action: "create", spec: { name: "C", systemPrompt: "p" } },
      ],
      leadIndex: 1,
    };
    const plan = normalizeGroupPlan(raw);
    expect(plan.agents).toHaveLength(2);
    expect(plan.leadIndex).toBe(0);
  });

  it("caps agents at 20 to resist runaway LLM output", () => {
    const raw = {
      group: { name: "G", description: "d" },
      agents: Array.from({ length: 50 }, (_, i) => ({
        action: "create",
        spec: { name: `A${i}`, systemPrompt: "sp" },
      })),
    };
    const plan = normalizeGroupPlan(raw);
    expect(plan.agents.length).toBeLessThanOrEqual(20);
  });

  it("rejects malformed LLM colors (defaults hex only)", () => {
    const raw = {
      group: { name: "G", description: "d" },
      agents: [
        {
          action: "create",
          spec: {
            name: "A",
            systemPrompt: "p",
            color: "red; background-image: url(evil.example.com)",
          },
        },
      ],
    };
    const plan = normalizeGroupPlan(raw);
    const agent = plan.agents[0];
    if (agent.action !== "create") throw new Error("expected create");
    // normalizeSpec falls back to the default hex when input is not valid hex.
    expect(agent.spec.color).toMatch(/^#[0-9A-Fa-f]{3,8}$/);
  });

  it("strips __proto__ from LLM-produced asset metadata", () => {
    const raw = {
      group: { name: "G", description: "d" },
      agents: [
        {
          action: "create",
          spec: {
            name: "A",
            systemPrompt: "p",
            assets: [
              {
                type: "document",
                name: "doc",
                uri: "file:///x",
                metadata: { nested: { __proto__: { polluted: true }, safe: "ok" } },
              },
            ],
          },
        },
      ],
    };
    const plan = normalizeGroupPlan(raw);
    const agent = plan.agents[0];
    if (agent.action !== "create") throw new Error("expected create");
    const meta = agent.spec.assets?.[0]?.metadata as Record<string, unknown> | undefined;
    expect(meta).toBeDefined();
    // Nested __proto__ key must not appear even indirectly.
    const nested = meta?.nested as Record<string, unknown>;
    expect(nested.safe).toBe("ok");
    expect(Object.prototype.hasOwnProperty.call(nested, "__proto__")).toBe(false);
  });

  it("coerces unknown artifactStrategy to 'isolated'", () => {
    const raw = {
      group: { name: "G", description: "d", artifactStrategy: "nonsense" },
      agents: [{ action: "create", spec: { name: "A", systemPrompt: "p" } }],
    };
    expect(normalizeGroupPlan(raw).group.artifactStrategy).toBe("isolated");
  });

  it("accepts 'collaborative' explicitly", () => {
    const raw = {
      group: { name: "G", description: "d", artifactStrategy: "collaborative" },
      agents: [{ action: "create", spec: { name: "A", systemPrompt: "p" } }],
    };
    expect(normalizeGroupPlan(raw).group.artifactStrategy).toBe("collaborative");
  });
});

// ─── normalizePipelinePlan ────────────────────────────────────

describe("normalizePipelinePlan", () => {
  beforeEach(() => cleanGuildDir());
  afterEach(() => cleanGuildDir());

  it("sanitizes the template id", () => {
    const raw = {
      template: {
        id: "My Fancy Pipeline!!!",
        name: "t",
        steps: [{ kind: "task", title: "s", description: "" }],
      },
      agents: [],
    };
    const plan = normalizePipelinePlan(raw);
    expect(plan.template.id).toMatch(/^[a-z0-9_-]+$/);
    expect(plan.template.id).not.toContain(" ");
  });

  it("caps steps per level", () => {
    const raw = {
      template: {
        id: "big",
        name: "big",
        steps: Array.from({ length: 100 }, (_, i) => ({
          kind: "task",
          title: `step ${i}`,
          description: "",
        })),
      },
      agents: [],
    };
    const plan = normalizePipelinePlan(raw);
    expect(plan.template.steps.length).toBeLessThanOrEqual(50);
  });

  it("drops blank-title task steps", () => {
    const raw = {
      template: {
        id: "p",
        name: "p",
        steps: [
          { kind: "task", title: "good", description: "" },
          { kind: "task", title: "", description: "" },
          { kind: "task", title: "  ", description: "" },
          { kind: "task", title: "also good", description: "" },
        ],
      },
      agents: [],
    };
    const plan = normalizePipelinePlan(raw);
    expect(plan.template.steps.map((s) => s.title)).toEqual(["good", "also good"]);
  });

  it("remaps dependsOn indices after dropping invalid steps", () => {
    // Raw: [0 good, 1 empty-dropped, 2 depends-on-0]. After drop: [0 good, 1 depends-on-0].
    // dependsOn=[0] → stays 0 (matches original index 0 which stayed).
    const raw = {
      template: {
        id: "p",
        name: "p",
        steps: [
          { kind: "task", title: "a", description: "" },
          { kind: "task", title: "", description: "" }, // dropped
          { kind: "task", title: "c", description: "", dependsOn: [0] },
        ],
      },
      agents: [],
    };
    const plan = normalizePipelinePlan(raw);
    expect(plan.template.steps.map((s) => s.title)).toEqual(["a", "c"]);
    expect(plan.template.steps[1].dependsOn).toEqual([0]);
  });

  it("drops self-reference and forward-reference dependencies", () => {
    const raw = {
      template: {
        id: "p",
        name: "p",
        steps: [
          { kind: "task", title: "a", description: "", dependsOn: [0, 5] }, // self + out-of-range
          { kind: "task", title: "b", description: "", dependsOn: [0, 1] }, // self
        ],
      },
      agents: [],
    };
    const plan = normalizePipelinePlan(raw);
    expect(plan.template.steps[0].dependsOn).toEqual([]);
    expect(plan.template.steps[1].dependsOn).toEqual([0]);
  });

  it("drops 'when' with unknown operator", () => {
    const raw = {
      template: {
        id: "p",
        name: "p",
        steps: [
          { kind: "branch", title: "b", description: "", when: { bogus_op: 1 } },
        ],
      },
      agents: [],
    };
    const plan = normalizePipelinePlan(raw);
    // when should be stripped since it fails validateExpression.
    const step = plan.template.steps[0] as { when?: unknown };
    expect(step.when).toBeUndefined();
  });

  it("accepts 'when' with a valid operator", () => {
    const raw = {
      template: {
        id: "p",
        name: "p",
        steps: [
          { kind: "branch", title: "b", description: "", when: { eq: ["${x}", "y"] } },
        ],
      },
      agents: [],
    };
    const plan = normalizePipelinePlan(raw);
    const step = plan.template.steps[0] as { when?: unknown };
    expect(step.when).toEqual({ eq: ["${x}", "y"] });
  });

  it("cuts off nested steps beyond the recursion cap", () => {
    // Build a chain of branches nested ~15 deep — must not crash, must prune.
    const build = (d: number): Record<string, unknown> => {
      if (d === 0) return { kind: "task", title: "leaf", description: "" };
      return {
        kind: "branch",
        title: `b${d}`,
        description: "",
        when: { eq: ["${x}", "x"] },
        then: [build(d - 1)],
      };
    };
    const raw = {
      template: { id: "deep", name: "deep", steps: [build(15)] },
      agents: [],
    };
    // Should just return a pruned template, not throw.
    const plan = normalizePipelinePlan(raw);
    expect(plan.template.steps.length).toBeGreaterThan(0);
  });

  it("assigns default planKey when missing", () => {
    const raw = {
      template: { id: "p", name: "p", steps: [{ kind: "task", title: "x", description: "" }] },
      agents: [
        { action: "create", spec: { name: "A", systemPrompt: "p" } },
        { action: "create", spec: { name: "B", systemPrompt: "p" } },
      ],
    };
    const plan = normalizePipelinePlan(raw);
    expect(plan.agents.map((a) => a.planKey)).toEqual(["K0", "K1"]);
  });

  it("preserves caller-supplied planKey", () => {
    const raw = {
      template: { id: "p", name: "p", steps: [{ kind: "task", title: "x", description: "" }] },
      agents: [
        { planKey: "writer", action: "create", spec: { name: "A", systemPrompt: "p" } },
      ],
    };
    const plan = normalizePipelinePlan(raw);
    expect(plan.agents[0].planKey).toBe("writer");
  });

  it("preserves valid acceptanceAssertions and drops malformed ones", () => {
    const raw = {
      template: {
        id: "p",
        name: "p",
        steps: [
          {
            kind: "task",
            title: "x",
            description: "",
            acceptanceAssertions: [
              { type: "file_exists", ref: "ok.md" },
              { type: "file_contains", ref: "ok.md", pattern: "header", regex: true },
              { type: "file_exists" }, // malformed: no ref — dropped
              { type: "unknown_kind", ref: "ok.md" }, // malformed: bad type — dropped
              { type: "file_contains", ref: "ok.md" }, // malformed: no pattern — dropped
              "not even an object", // malformed — dropped
            ],
          },
        ],
      },
      agents: [],
    };
    const plan = normalizePipelinePlan(raw);
    const step = plan.template.steps[0] as {
      acceptanceAssertions?: Array<Record<string, unknown>>;
    };
    expect(step.acceptanceAssertions).toBeDefined();
    expect(step.acceptanceAssertions).toHaveLength(2);
    expect(step.acceptanceAssertions?.[0]).toMatchObject({ type: "file_exists", ref: "ok.md" });
    expect(step.acceptanceAssertions?.[1]).toMatchObject({
      type: "file_contains",
      ref: "ok.md",
      pattern: "header",
      regex: true,
    });
  });

  it("skips acceptanceAssertions altogether when all entries are malformed", () => {
    const raw = {
      template: {
        id: "p",
        name: "p",
        steps: [
          {
            kind: "task",
            title: "x",
            description: "",
            acceptanceAssertions: [{ ref: "no-type" }, 123, null],
          },
        ],
      },
      agents: [],
    };
    const plan = normalizePipelinePlan(raw);
    const step = plan.template.steps[0] as {
      acceptanceAssertions?: Array<Record<string, unknown>>;
    };
    expect(step.acceptanceAssertions).toBeUndefined();
  });
});
