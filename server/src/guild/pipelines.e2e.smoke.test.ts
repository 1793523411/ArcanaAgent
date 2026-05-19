import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cpSync, readdirSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { cleanGuildDir } from "../test-setup.js";
import { createGroup } from "./guildManager.js";
import { createTask, getTask, getSubtasks } from "./taskBoard.js";
import {
  listPipelines,
  getPipeline,
  validatePipeline,
  expandPipeline,
} from "./pipelines.js";

const REAL_CONFIG_DIR = resolve(__dirname, "../../../config/pipelines");
const DATA_PIPELINES_DIR = join(process.env.DATA_DIR!, "guild", "pipelines");

describe("pipeline E2E smoke (real config templates)", () => {
  beforeEach(() => {
    cleanGuildDir();
    mkdirSync(DATA_PIPELINES_DIR, { recursive: true });
    for (const f of readdirSync(REAL_CONFIG_DIR)) {
      if (f.endsWith(".json")) {
        cpSync(join(REAL_CONFIG_DIR, f), join(DATA_PIPELINES_DIR, f));
      }
    }
  });
  afterEach(() => cleanGuildDir());

  it("every real template validates clean", () => {
    const all = listPipelines();
    expect(all.length).toBeGreaterThan(0);
    for (const tpl of all) {
      const errs = validatePipeline(tpl);
      expect(errs, `${tpl.id}: ${JSON.stringify(errs)}`).toEqual([]);
    }
  });

  it("blog-writer: final step's isFinal output bubbles to parent and matches template-level outputs", () => {
    const tpl = getPipeline("blog-writer")!;
    expect(tpl.outputs?.some((o) => o.ref === "final.md")).toBe(true);
    const group = createGroup({ name: "G", description: "" });
    const parent = createTask(group.id, {
      title: tpl.name,
      description: "",
      kind: "pipeline",
      pipelineId: tpl.id,
      pipelineInputs: { topic: "RAG 进阶" },
    });
    expandPipeline(group.id, parent, tpl, { topic: "RAG 进阶" });
    const refreshed = getTask(group.id, parent.id)!;
    const finalRefs = (refreshed.declaredOutputs ?? []).map((o) => o.ref);
    expect(finalRefs).toContain("final.md");
    // Parent declaredOutputs all marked final
    expect(refreshed.declaredOutputs?.every((o) => o.isFinal)).toBe(true);
    // Intermediate file should NOT be on the parent
    expect(finalRefs).not.toContain("research.md");
  });

  it("knowledge-point: two final deliverables surface on parent", () => {
    const tpl = getPipeline("knowledge-point")!;
    const group = createGroup({ name: "G", description: "" });
    const parent = createTask(group.id, {
      title: tpl.name,
      description: "",
      kind: "pipeline",
      pipelineId: tpl.id,
    });
    expandPipeline(group.id, parent, tpl, { url: "https://example.com/spec" });
    const refreshed = getTask(group.id, parent.id)!;
    const refs = (refreshed.declaredOutputs ?? []).map((o) => o.ref).sort();
    expect(refs).toEqual(["knowledge-points.json", "knowledge-points.md"].sort());
    // Each subtask with step-level outputs keeps them on the child too
    const lastSubtask = getSubtasks(group.id, parent.id).at(-1)!;
    expect(lastSubtask.declaredOutputs?.length).toBe(2);
  });
});
