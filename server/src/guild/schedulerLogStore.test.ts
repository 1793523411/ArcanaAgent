import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { createGroup, createAgent } from "./guildManager.js";
import {
  appendSchedulerDispatched,
  appendSchedulerStalled,
  clearSchedulerLog,
  getSchedulerLog,
  SCHEDULER_LOG_MAX,
} from "./schedulerLogStore.js";

const TEST_DATA_DIR = process.env.DATA_DIR!;

describe("schedulerLogStore", () => {
  beforeEach(() => {
    rmSync(join(TEST_DATA_DIR, "guild"), { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(join(TEST_DATA_DIR, "guild"), { recursive: true, force: true });
  });

  it("persists dispatched and stalled entries and respects max length", () => {
    const group = createGroup({ name: "g", description: "g" });
    const agent = createAgent({
      name: "Worker",
      description: "w",
      systemPrompt: "You are helpful.",
    });
    const at = "2026-04-11T12:00:00.000Z";
    const e1 = appendSchedulerDispatched(group.id, at, "task_1", agent.id, "Title A", 0.88);
    expect(e1.kind).toBe("dispatched");
    expect(e1.message).toContain("Worker");
    expect(e1.message).toContain("Title A");
    expect(getSchedulerLog(group.id)).toHaveLength(1);

    appendSchedulerStalled(group.id, at, 3, "stuck");
    expect(getSchedulerLog(group.id)).toHaveLength(2);

    for (let i = 0; i < SCHEDULER_LOG_MAX + 5; i++) {
      appendSchedulerStalled(group.id, at, 1, `m${i}`);
    }
    expect(getSchedulerLog(group.id).length).toBeLessThanOrEqual(SCHEDULER_LOG_MAX);

    const logFile = join(TEST_DATA_DIR, "guild", "groups", group.id, "schedulerLog.json");
    expect(existsSync(logFile)).toBe(true);
    const raw = JSON.parse(readFileSync(logFile, "utf-8")) as { entries: unknown[] };
    expect(raw.entries.length).toBeLessThanOrEqual(SCHEDULER_LOG_MAX);
  });

  it("clearSchedulerLog empties the file", () => {
    const group = createGroup({ name: "g2", description: "g2" });
    appendSchedulerStalled(group.id, new Date().toISOString(), 2, "x");
    expect(getSchedulerLog(group.id).length).toBe(1);
    clearSchedulerLog(group.id);
    expect(getSchedulerLog(group.id)).toHaveLength(0);
  });
});
