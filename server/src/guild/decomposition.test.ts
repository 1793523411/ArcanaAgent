import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { cleanGuildDir } from "../test-setup.js";
import { createGroup } from "./guildManager.js";
import { createTask, getSubtasks } from "./taskBoard.js";
import { decompose, decompositionStrategyFor } from "./decomposition.js";

const TEST_DATA_DIR = process.env.DATA_DIR!;
const PIPELINES_DIR = join(TEST_DATA_DIR, "guild", "pipelines");

describe("decompose dispatch", () => {
  beforeEach(() => {
    cleanGuildDir();
    mkdirSync(PIPELINES_DIR, { recursive: true });
  });
  afterEach(() => cleanGuildDir());

  it("classifies tasks via decompositionStrategyFor", () => {
    const g = createGroup({ name: "G", description: "d" });
    const req = createTask(g.id, { title: "r", description: "", kind: "requirement" });
    const pip = createTask(g.id, { title: "p", description: "", kind: "pipeline" });
    const adh = createTask(g.id, { title: "a", description: "", kind: "adhoc" });
    expect(decompositionStrategyFor(req)).toBe("llm");
    expect(decompositionStrategyFor(pip)).toBe("template");
    expect(decompositionStrategyFor(adh)).toBe("manual");
  });

  it("manual strategy is a no-op success for adhoc tasks", async () => {
    const g = createGroup({ name: "G", description: "d" });
    const t = createTask(g.id, { title: "a", description: "", kind: "adhoc" });
    const out = await decompose(g.id, t);
    expect(out.ok).toBe(true);
    expect(out.strategy).toBe("manual");
    expect(out.subtaskIds).toEqual([]);
  });

  it("template strategy expands a pipeline via its stored pipelineId + inputs", async () => {
    const tplSpec = {
      id: "facade",
      name: "Facade Test",
      inputs: [{ name: "topic", required: true }],
      steps: [
        { title: "Step about ${topic}", description: "do it", dependsOn: [] },
      ],
    };
    writeFileSync(join(PIPELINES_DIR, "facade.json"), JSON.stringify(tplSpec));

    const g = createGroup({ name: "G", description: "d" });
    const parent = createTask(g.id, {
      title: "run",
      description: "",
      kind: "pipeline",
      pipelineId: "facade",
      pipelineInputs: { topic: "widgets" },
    });

    const out = await decompose(g.id, parent);
    expect(out.ok).toBe(true);
    expect(out.strategy).toBe("template");
    expect(out.subtaskIds?.length).toBe(1);

    const subs = getSubtasks(g.id, parent.id);
    expect(subs[0].title).toContain("widgets");
  });

  it("template strategy fails cleanly when pipelineId is missing or bogus", async () => {
    const g = createGroup({ name: "G", description: "d" });

    const noId = createTask(g.id, { title: "p", description: "", kind: "pipeline" });
    const out1 = await decompose(g.id, noId);
    expect(out1.ok).toBe(false);
    expect(out1.reason).toMatch(/missing pipelineId/);
    expect(out1.strategy).toBe("template");

    const badId = createTask(g.id, {
      title: "p",
      description: "",
      kind: "pipeline",
      pipelineId: "nonexistent-template",
    });
    const out2 = await decompose(g.id, badId);
    expect(out2.ok).toBe(false);
    expect(out2.reason).toMatch(/not found/);
  });

  it("llm strategy short-circuits when the parent is already decomposed", async () => {
    const g = createGroup({ name: "G", description: "d" });
    const req = createTask(g.id, { title: "r", description: "", kind: "requirement" });
    // Pretend planning already happened by attaching subtaskIds directly.
    const { updateTask } = await import("./taskBoard.js");
    updateTask(g.id, req.id, { subtaskIds: ["existing_sub_1", "existing_sub_2"] });
    const fresh = (await import("./taskBoard.js")).getTask(g.id, req.id)!;

    const out = await decompose(g.id, fresh);
    expect(out.ok).toBe(true);
    expect(out.strategy).toBe("llm");
    expect(out.reason).toMatch(/Already decomposed/);
    expect(out.subtaskIds).toEqual(["existing_sub_1", "existing_sub_2"]);
  });
});
