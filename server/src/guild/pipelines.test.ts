import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { createGroup } from "./guildManager.js";
import { createTask, getSubtasks, getTask, failTask, getGroupTasks } from "./taskBoard.js";
import {
  listPipelines,
  getPipeline,
  substituteVars,
  expandPipeline,
  savePipeline,
  deletePipeline,
  validatePipeline,
  type PipelineTemplate,
} from "./pipelines.js";

const TEST_DATA_DIR = process.env.DATA_DIR!;
const PIPELINES_DIR = join(TEST_DATA_DIR, "guild", "pipelines");

const sample: PipelineTemplate = {
  id: "test-pl",
  name: "Test Pipeline",
  description: "two-step chain",
  inputs: [{ name: "url", required: true }, { name: "tag", default: "misc" }],
  steps: [
    { title: "Fetch ${url}", description: "grab the page at ${url}", dependsOn: [] },
    {
      title: "Process (${tag})",
      description: "process output of step 0",
      dependsOn: [0],
      acceptanceCriteria: "tagged with ${tag}",
    },
  ],
};

describe("pipelines", () => {
  beforeEach(() => {
    rmSync(join(TEST_DATA_DIR, "guild"), { recursive: true, force: true });
    mkdirSync(PIPELINES_DIR, { recursive: true });
    writeFileSync(join(PIPELINES_DIR, "test-pl.json"), JSON.stringify(sample));
  });
  afterEach(() => {
    rmSync(join(TEST_DATA_DIR, "guild"), { recursive: true, force: true });
  });

  it("substituteVars replaces known tokens and leaves unknown literal", () => {
    expect(substituteVars("hi ${name}, ${other}", { name: "x" })).toBe("hi x, ${other}");
  });

  it("listPipelines / getPipeline read from data dir", () => {
    const all = listPipelines();
    expect(all.map((t) => t.id)).toContain("test-pl");
    expect(getPipeline("test-pl")?.steps.length).toBe(2);
    expect(getPipeline("nope")).toBeNull();
  });

  it("expandPipeline creates subtasks with substituted vars and DAG edges", () => {
    const group = createGroup({ name: "G", description: "d" });
    const tpl = getPipeline("test-pl")!;
    const parent = createTask(group.id, {
      title: tpl.name,
      description: tpl.description ?? "",
      kind: "pipeline",
      pipelineId: tpl.id,
      pipelineInputs: { url: "https://x.test" },
    });

    const outcome = expandPipeline(group.id, parent, tpl, { url: "https://x.test" });
    expect(outcome.ok).toBe(true);
    expect(outcome.subtaskIds?.length).toBe(2);

    const subs = getSubtasks(group.id, parent.id);
    expect(subs[0].title).toBe("Fetch https://x.test");
    expect(subs[1].title).toBe("Process (misc)"); // default applied
    expect(subs[1].acceptanceCriteria).toBe("tagged with misc");
    expect(subs[1].dependsOn).toEqual([subs[0].id]);

    const refreshed = getTask(group.id, parent.id)!;
    expect(refreshed.subtaskIds?.length).toBe(2);
    expect(refreshed.workspaceRef).toBeTruthy();
  });

  it("expandPipeline rejects when required inputs are missing", () => {
    const group = createGroup({ name: "G", description: "d" });
    const tpl = getPipeline("test-pl")!;
    const parent = createTask(group.id, {
      title: tpl.name,
      description: "",
      kind: "pipeline",
      pipelineId: tpl.id,
    });
    const outcome = expandPipeline(group.id, parent, tpl, {});
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/url/);
    expect(getSubtasks(group.id, parent.id).length).toBe(0);
  });

  it("validatePipeline flags bad id, missing title, bad deps, undeclared vars", () => {
    const bad: PipelineTemplate = {
      id: "Bad ID!",
      name: "",
      inputs: [{ name: "ok" }],
      steps: [
        { title: "", description: "uses ${missing}", dependsOn: [] },
        { title: "refs future", description: "x", dependsOn: [5] },
      ],
    };
    const errs = validatePipeline(bad);
    const paths = errs.map((e) => e.path);
    expect(paths).toContain("id");
    expect(paths).toContain("name");
    expect(paths).toContain("steps[0].title");
    expect(paths.some((p) => p.startsWith("steps[1].dependsOn"))).toBe(true);
    expect(errs.some((e) => e.message.includes("missing"))).toBe(true);
  });

  it("savePipeline writes, refuses duplicate without overwrite, PUT overrides", () => {
    const tpl: PipelineTemplate = {
      id: "new-tpl",
      name: "New",
      steps: [{ title: "Step 1", description: "hi", dependsOn: [] }],
    };
    expect(savePipeline(tpl).ok).toBe(true);
    expect(savePipeline(tpl).ok).toBe(false); // duplicate rejected
    const updated: PipelineTemplate = { ...tpl, name: "Updated" };
    const r = savePipeline(updated, { expectedId: "new-tpl", allowOverwrite: true });
    expect(r.ok).toBe(true);
    expect(getPipeline("new-tpl")?.name).toBe("Updated");
  });

  it("savePipeline rejects id mismatch on PUT", () => {
    const tpl: PipelineTemplate = {
      id: "a",
      name: "A",
      steps: [{ title: "s", description: "d", dependsOn: [] }],
    };
    const r = savePipeline(tpl, { expectedId: "b", allowOverwrite: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/mismatch/);
  });

  it("deletePipeline removes file", () => {
    const tpl: PipelineTemplate = {
      id: "tmp",
      name: "Temp",
      steps: [{ title: "s", description: "d", dependsOn: [] }],
    };
    savePipeline(tpl);
    expect(getPipeline("tmp")).not.toBeNull();
    expect(deletePipeline("tmp")).toBe(true);
    expect(getPipeline("tmp")).toBeNull();
    expect(deletePipeline("tmp")).toBe(false);
  });

  it("expandPipeline threads retry policy onto subtasks with var substitution", () => {
    const withRetry: PipelineTemplate = {
      id: "retry-pl",
      name: "Retry",
      inputs: [{ name: "who", default: "ops" }],
      steps: [
        {
          title: "flaky",
          description: "x",
          dependsOn: [],
          retry: {
            max: 2,
            backoffMs: 0,
            onExhausted: "fallback",
            fallback: { title: "ask ${who}", description: "manual", suggestedAgentId: "human" },
          },
        },
      ],
    };
    savePipeline(withRetry);
    const group = createGroup({ name: "G", description: "d" });
    const tpl = getPipeline("retry-pl")!;
    const parent = createTask(group.id, { title: tpl.name, description: "", kind: "pipeline", pipelineId: tpl.id });
    expandPipeline(group.id, parent, tpl, {});
    const [sub] = getSubtasks(group.id, parent.id);
    expect(sub.retryPolicy?.max).toBe(2);
    expect(sub.retryPolicy?.onExhausted).toBe("fallback");
    expect(sub.retryPolicy?.fallback?.title).toBe("ask ops"); // substituted
  });

  it("failTask retries until max then finalizes with onExhausted=fail", () => {
    const group = createGroup({ name: "G", description: "d" });
    const t = createTask(group.id, {
      title: "flaky",
      description: "",
      kind: "subtask",
      retryPolicy: { max: 2, backoffMs: 0, onExhausted: "fail" },
    });
    // First failure: retry #1, status goes back to open
    let r = failTask(group.id, t.id, "a", "boom")!;
    expect(r.status).toBe("open");
    expect(r.retryCount).toBe(1);
    // Second failure: retry #2, still open
    r = failTask(group.id, t.id, "a", "boom")!;
    expect(r.status).toBe("open");
    expect(r.retryCount).toBe(2);
    // Third failure: budget exhausted → failed
    r = failTask(group.id, t.id, "a", "boom")!;
    expect(r.status).toBe("failed");
  });

  it("failTask with onExhausted=skip cancels and records skippedReason", () => {
    const group = createGroup({ name: "G", description: "d" });
    const t = createTask(group.id, {
      title: "skippable",
      description: "",
      kind: "subtask",
      retryPolicy: { max: 1, onExhausted: "skip" },
    });
    failTask(group.id, t.id, "a", "err"); // retry 1
    const r = failTask(group.id, t.id, "a", "err")!; // exhausted → skip
    expect(r.status).toBe("cancelled");
    expect(r.skippedReason).toMatch(/skipped/);
  });

  it("failTask with onExhausted=fallback creates a replacement task and rewires deps", () => {
    const group = createGroup({ name: "G", description: "d" });
    const a = createTask(group.id, {
      title: "A",
      description: "",
      kind: "subtask",
      retryPolicy: {
        max: 1,
        onExhausted: "fallback",
        fallback: { title: "A-fallback", description: "manual" },
      },
    });
    const b = createTask(group.id, {
      title: "B",
      description: "",
      kind: "subtask",
      dependsOn: [a.id],
    });
    failTask(group.id, a.id, "x", "err"); // retry 1
    const aFinal = failTask(group.id, a.id, "x", "err")!; // exhausted
    expect(aFinal.status).toBe("cancelled");
    const all = getGroupTasks(group.id);
    const fallback = all.find((t) => t.title === "A-fallback");
    expect(fallback).toBeDefined();
    const bRefreshed = getTask(group.id, b.id)!;
    expect(bRefreshed.dependsOn).toEqual([fallback!.id]);
  });

  it("expandPipeline honors compile-time branch kind", () => {
    const branchTpl: PipelineTemplate = {
      id: "branch-pl",
      name: "Branch demo",
      inputs: [{ name: "format", required: true }],
      steps: [
        { title: "prep", description: "always runs", dependsOn: [] },
        {
          kind: "branch",
          title: "format-branch",
          description: "pick parser",
          when: { eq: ["${format}", "pdf"] },
          dependsOn: [0],
          then: [{ title: "OCR ${format}", description: "parse PDF", dependsOn: [] }],
          else: [{ title: "HTML parse", description: "parse HTML", dependsOn: [] }],
        },
        { title: "summarize", description: "after branch", dependsOn: [1] },
      ],
    };
    savePipeline(branchTpl);
    const group = createGroup({ name: "G", description: "d" });
    const tpl = getPipeline("branch-pl")!;
    const parent = createTask(group.id, {
      title: tpl.name,
      description: "",
      kind: "pipeline",
      pipelineId: tpl.id,
    });
    const outcome = expandPipeline(group.id, parent, tpl, { format: "pdf" });
    expect(outcome.ok).toBe(true);
    const subs = getSubtasks(group.id, parent.id);
    // prep + OCR + summarize = 3; HTML parse not created
    expect(subs.map((s) => s.title)).toEqual(["prep", "OCR pdf", "summarize"]);
    // summarize depends on OCR (the last step of the chosen branch), not on "prep"
    expect(subs[2].dependsOn).toEqual([subs[1].id]);
    // OCR itself depends on prep (outerDeps of the branch)
    expect(subs[1].dependsOn).toEqual([subs[0].id]);
  });

  it("expandPipeline fans out foreach over an input list with join", () => {
    const feTpl: PipelineTemplate = {
      id: "fe-pl",
      name: "foreach demo",
      inputs: [{ name: "kps", required: true }],
      steps: [
        {
          kind: "foreach",
          title: "per-kp",
          description: "iterate",
          items: "${kps}",
          as: "kp",
          body: [
            { title: "gen ${kp}", description: "body step", dependsOn: [] },
          ],
          join: { title: "merge", description: "combine all", dependsOn: [] },
        },
      ],
    };
    savePipeline(feTpl);
    const group = createGroup({ name: "G", description: "d" });
    const tpl = getPipeline("fe-pl")!;
    const parent = createTask(group.id, {
      title: tpl.name,
      description: "",
      kind: "pipeline",
      pipelineId: tpl.id,
    });
    const outcome = expandPipeline(group.id, parent, tpl, { kps: "a,b,c" });
    expect(outcome.ok).toBe(true);
    const subs = getSubtasks(group.id, parent.id);
    // 3 iterations + 1 join = 4
    expect(subs.map((s) => s.title)).toEqual(["gen a", "gen b", "gen c", "merge"]);
    // join depends on all 3 iterations
    const joinTask = subs[3];
    expect(joinTask.dependsOn?.sort()).toEqual([subs[0].id, subs[1].id, subs[2].id].sort());
  });

  it("expandPipeline foreach handles JSON-array input", () => {
    const feTpl: PipelineTemplate = {
      id: "fe-json",
      name: "json foreach",
      inputs: [{ name: "items", required: true }],
      steps: [
        {
          kind: "foreach",
          title: "loop",
          description: "",
          items: "${items}",
          as: "x",
          body: [{ title: "do ${x}", description: "", dependsOn: [] }],
        },
      ],
    };
    savePipeline(feTpl);
    const group = createGroup({ name: "G", description: "d" });
    const tpl = getPipeline("fe-json")!;
    const parent = createTask(group.id, {
      title: tpl.name,
      description: "",
      kind: "pipeline",
      pipelineId: tpl.id,
    });
    const outcome = expandPipeline(group.id, parent, tpl, {
      items: JSON.stringify(["one", "two"]),
    });
    expect(outcome.ok).toBe(true);
    const subs = getSubtasks(group.id, parent.id);
    expect(subs.map((s) => s.title)).toEqual(["do one", "do two"]);
  });

  it("expandPipeline is idempotent", () => {
    const group = createGroup({ name: "G", description: "d" });
    const tpl = getPipeline("test-pl")!;
    const parent = createTask(group.id, {
      title: tpl.name,
      description: "",
      kind: "pipeline",
      pipelineId: tpl.id,
    });
    const first = expandPipeline(group.id, parent, tpl, { url: "u" });
    const second = expandPipeline(group.id, parent, tpl, { url: "u" });
    expect(first.subtaskIds).toEqual(second.subtaskIds);
    expect(getSubtasks(group.id, parent.id).length).toBe(2);
  });
});
