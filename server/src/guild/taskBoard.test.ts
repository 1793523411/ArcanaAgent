import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "fs";
import { cleanGuildDir } from "../test-setup.js";
import { join } from "path";
import { createGroup } from "./guildManager.js";
import {
  createTask,
  updateTask,
  completeTask,
  getSubtasks,
  areDepsReady,
  getUnplannedRequirements,
  detectDependencyCycle,
  findOutputConflicts,
} from "./taskBoard.js";
import { getGroupSharedDir } from "./guildManager.js";
import { mkdirSync, writeFileSync } from "fs";
import { join as joinPath } from "path";

const TEST_DATA_DIR = process.env.DATA_DIR!;

describe("taskBoard subtasks & deps", () => {
  beforeEach(() => {
    cleanGuildDir();
  });
  afterEach(() => {
    cleanGuildDir();
  });

  it("getSubtasks returns children of a requirement", () => {
    const group = createGroup({ name: "G", description: "d" });
    const req = createTask(group.id, {
      title: "Build feature",
      description: "a requirement",
      kind: "requirement",
    });
    const s1 = createTask(group.id, {
      title: "Backend",
      description: "api work",
      kind: "subtask",
      parentTaskId: req.id,
    });
    const s2 = createTask(group.id, {
      title: "Frontend",
      description: "ui work",
      kind: "subtask",
      parentTaskId: req.id,
    });

    const subs = getSubtasks(group.id, req.id);
    expect(subs.map((t) => t.id).sort()).toEqual([s1.id, s2.id].sort());
  });

  it("areDepsReady blocks until every dep is completed", () => {
    const group = createGroup({ name: "G", description: "d" });
    const a = createTask(group.id, { title: "A", description: "first", kind: "subtask" });
    const b = createTask(group.id, {
      title: "B",
      description: "second",
      kind: "subtask",
      dependsOn: [a.id],
    });

    expect(areDepsReady(group.id, b)).toBe(false);

    updateTask(group.id, a.id, { status: "completed" });
    const bFresh = { ...b };
    expect(areDepsReady(group.id, bFresh)).toBe(true);
  });

  it("areDepsReady is tolerant of unknown dep ids", () => {
    const group = createGroup({ name: "G", description: "d" });
    const t = createTask(group.id, {
      title: "T",
      description: "weird",
      kind: "subtask",
      dependsOn: ["task_ghost_xxx"],
    });
    expect(areDepsReady(group.id, t)).toBe(true);
  });

  it("createTask honors initialStatus for planner 2-pass hold", () => {
    const group = createGroup({ name: "G", description: "d" });
    const held = createTask(group.id, {
      title: "Hold me",
      description: "waiting for deps",
      kind: "subtask",
      initialStatus: "blocked",
    });
    expect(held.status).toBe("blocked");
    const normal = createTask(group.id, { title: "Normal", description: "x" });
    expect(normal.status).toBe("open");
  });

  it("detectDependencyCycle finds self-references and 2-cycles", () => {
    const group = createGroup({ name: "G", description: "d" });
    const a = createTask(group.id, { title: "A", description: "x" });
    const b = createTask(group.id, { title: "B", description: "y", dependsOn: [a.id] });

    // Editing B with deps=[B.id] → self-ref
    expect(detectDependencyCycle(group.id, b.id, [b.id])).not.toBeNull();

    // Editing A to depend on B → A→B→A cycle (B already depends on A)
    const cycle = detectDependencyCycle(group.id, a.id, [b.id]);
    expect(cycle).not.toBeNull();
    expect(cycle).toEqual(expect.arrayContaining([a.id, b.id]));

    // Legit chain A→B, no cycle
    expect(detectDependencyCycle(group.id, null, [a.id])).toBeNull();

    // Unknown deps don't crash and don't report a cycle
    expect(detectDependencyCycle(group.id, null, ["task_ghost"])).toBeNull();
  });

  it("getUnplannedRequirements lists requirement tasks without subtaskIds", () => {
    const group = createGroup({ name: "G", description: "d" });
    const req = createTask(group.id, {
      title: "Big feature",
      description: "...",
      kind: "requirement",
    });
    createTask(group.id, { title: "Adhoc fix", description: "...", kind: "adhoc" });

    let unplanned = getUnplannedRequirements(group.id);
    expect(unplanned.map((t) => t.id)).toEqual([req.id]);

    updateTask(group.id, req.id, { subtaskIds: ["some_child"] });
    unplanned = getUnplannedRequirements(group.id);
    expect(unplanned).toHaveLength(0);
  });
});

describe("findOutputConflicts", () => {
  beforeEach(() => cleanGuildDir());
  afterEach(() => cleanGuildDir());

  it("returns empty when candidate has no declared outputs", () => {
    const g = createGroup({ name: "G", description: "d" });
    const a = createTask(g.id, { title: "A", description: "" });
    const b = createTask(g.id, {
      title: "B",
      description: "",
      declaredOutputs: [{ ref: "final.md", kind: "file" }],
    });
    expect(findOutputConflicts(g.id, a)).toEqual([]);
    // Sibling B has its own outputs but A has none; still no conflicts for A.
    expect(b.declaredOutputs).toHaveLength(1);
  });

  it("returns overlapping in-progress tasks", () => {
    const g = createGroup({ name: "G", description: "d" });
    const holder = createTask(g.id, {
      title: "Holder",
      description: "",
      declaredOutputs: [{ ref: "final.md", kind: "file" }],
    });
    updateTask(g.id, holder.id, { status: "in_progress" });

    const waiter = createTask(g.id, {
      title: "Waiter",
      description: "",
      declaredOutputs: [{ ref: "final.md", kind: "file" }],
    });
    const conflicts = findOutputConflicts(g.id, waiter);
    expect(conflicts.map((c) => c.id)).toEqual([holder.id]);
  });

  it("returns overlapping open tasks", () => {
    const g = createGroup({ name: "G", description: "d" });
    const t1 = createTask(g.id, {
      title: "T1",
      description: "",
      declaredOutputs: [{ ref: "report.md", kind: "file" }],
    });
    const t2 = createTask(g.id, {
      title: "T2",
      description: "",
      declaredOutputs: [{ ref: "report.md", kind: "file" }],
    });
    expect(findOutputConflicts(g.id, t2).map((c) => c.id)).toEqual([t1.id]);
  });

  it("excludes completed, failed, and cancelled tasks", () => {
    const g = createGroup({ name: "G", description: "d" });
    const done = createTask(g.id, {
      title: "Done",
      description: "",
      declaredOutputs: [{ ref: "final.md", kind: "file" }],
    });
    updateTask(g.id, done.id, { status: "completed" });
    const waiter = createTask(g.id, {
      title: "Waiter",
      description: "",
      declaredOutputs: [{ ref: "final.md", kind: "file" }],
    });
    expect(findOutputConflicts(g.id, waiter)).toEqual([]);
  });

  it("excludes the candidate itself even if its own ref matches", () => {
    const g = createGroup({ name: "G", description: "d" });
    const t = createTask(g.id, {
      title: "T",
      description: "",
      declaredOutputs: [{ ref: "x.md", kind: "file" }],
    });
    updateTask(g.id, t.id, { status: "in_progress" });
    // Refresh from store so the candidate reflects the new status.
    const refreshed = { ...t, status: "in_progress" as const };
    expect(findOutputConflicts(g.id, refreshed)).toEqual([]);
  });

  it("no conflict when declared refs don't overlap", () => {
    const g = createGroup({ name: "G", description: "d" });
    const a = createTask(g.id, {
      title: "A",
      description: "",
      declaredOutputs: [{ ref: "a.md", kind: "file" }],
    });
    updateTask(g.id, a.id, { status: "in_progress" });
    const b = createTask(g.id, {
      title: "B",
      description: "",
      declaredOutputs: [{ ref: "b.md", kind: "file" }],
    });
    expect(findOutputConflicts(g.id, b)).toEqual([]);
  });
});

describe("completeTask with acceptanceAssertions", () => {
  beforeEach(() => cleanGuildDir());
  afterEach(() => cleanGuildDir());

  it("completes normally when the task has no assertions", () => {
    const g = createGroup({ name: "G", description: "d" });
    const t = createTask(g.id, { title: "plain", description: "" });
    const res = completeTask(g.id, t.id, "agent_1", { summary: "done" });
    expect(res?.status).toBe("completed");
  });

  it("transitions to failed when a file_exists assertion fails", () => {
    const g = createGroup({ name: "G", description: "d" });
    const t = createTask(g.id, {
      title: "deliver",
      description: "",
      acceptanceAssertions: [{ type: "file_exists", ref: "missing.md" }],
    });
    const res = completeTask(g.id, t.id, "agent_1", { summary: "agent says done" });
    expect(res?.status).toBe("failed");
    expect(res?.result?.summary).toMatch(/验收未通过/);
    expect(res?.result?.summary).toMatch(/missing\.md/);
  });

  it("transitions to completed when the assertion passes", () => {
    const g = createGroup({ name: "G", description: "d" });
    const t = createTask(g.id, {
      title: "deliver",
      description: "",
      acceptanceAssertions: [{ type: "file_exists", ref: "ok.md" }],
    });
    // Seed the file in the isolated-mode per-task directory.
    const sharedDir = getGroupSharedDir(g.id);
    const taskDir = joinPath(sharedDir, t.id);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(joinPath(taskDir, "ok.md"), "content");

    const res = completeTask(g.id, t.id, "agent_1", { summary: "done" });
    expect(res?.status).toBe("completed");
  });

  it("file_contains failure is surfaced with the specific assertion reason", () => {
    const g = createGroup({ name: "G", description: "d" });
    const t = createTask(g.id, {
      title: "deliver",
      description: "",
      acceptanceAssertions: [
        { type: "file_exists", ref: "final.md" },
        { type: "file_contains", ref: "final.md", pattern: "## 结论" },
      ],
    });
    // File exists but doesn't contain the required section.
    const sharedDir = getGroupSharedDir(g.id);
    const taskDir = joinPath(sharedDir, t.id);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(joinPath(taskDir, "final.md"), "just prose, no structure");

    const res = completeTask(g.id, t.id, "agent_1", { summary: "done" });
    expect(res?.status).toBe("failed");
    expect(res?.result?.summary).toMatch(/未包含/);
  });
});
