import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "fs";
import { cleanGuildDir } from "../test-setup.js";
import { join } from "path";
import { createGroup } from "./guildManager.js";
import {
  createTask,
  updateTask,
  getSubtasks,
  areDepsReady,
  getUnplannedRequirements,
} from "./taskBoard.js";

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
