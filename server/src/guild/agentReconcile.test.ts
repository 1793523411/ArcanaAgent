import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "fs";
import { join } from "path";
import { createGroup, createAgent, assignAgentToGroup, getAgent, updateAgent } from "./guildManager.js";
import { createTask, assignTask, completeTask } from "./taskBoard.js";
import { reconcileStaleWorkingAgent } from "./agentReconcile.js";

const TEST_DATA_DIR = process.env.DATA_DIR!;

describe("agentReconcile", () => {
  beforeEach(() => {
    rmSync(join(TEST_DATA_DIR, "guild"), { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(join(TEST_DATA_DIR, "guild"), { recursive: true, force: true });
  });

  it("clears working state when task is already completed", () => {
    const group = createGroup({ name: "g", description: "g" });
    const agent = createAgent({
      name: "A",
      description: "d",
      systemPrompt: "General assistant",
    });
    assignAgentToGroup(agent.id, group.id);
    const task = createTask(group.id, {
      title: "t",
      description: "d",
      priority: "medium",
    });
    assignTask(group.id, task.id, agent.id);
    updateAgent(agent.id, { status: "working", currentTaskId: task.id });
    completeTask(group.id, task.id, agent.id, { summary: "done" });

    expect(getAgent(agent.id)?.status).toBe("working");

    const fixed = reconcileStaleWorkingAgent(agent.id);
    expect(fixed).toBe(true);
    expect(getAgent(agent.id)?.status).toBe("idle");
    expect(getAgent(agent.id)?.currentTaskId).toBeUndefined();
  });
});
