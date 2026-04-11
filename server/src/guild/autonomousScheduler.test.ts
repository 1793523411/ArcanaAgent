import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "fs";
import { join } from "path";
import { createGroup, createAgent, assignAgentToGroup, updateAgent } from "./guildManager.js";
import { createTask, getTask } from "./taskBoard.js";
import { guildEventBus } from "./eventBus.js";
import { GuildAutonomousScheduler } from "./autonomousScheduler.js";

const TEST_DATA_DIR = process.env.DATA_DIR!;

function flush(ms = 30): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("GuildAutonomousScheduler", () => {
  beforeEach(() => {
    rmSync(join(TEST_DATA_DIR, "guild"), { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(join(TEST_DATA_DIR, "guild"), { recursive: true, force: true });
  });

  it("dispatches newly created open task without user assignment", async () => {
    const group = createGroup({ name: "g1", description: "g1" });
    const agent = createAgent({
      name: "A1",
      description: "generalist",
      systemPrompt: "General coding assistant",
    });
    assignAgentToGroup(agent.id, group.id);

    const executeMock = vi.fn(async () => ({ summary: "ok" }));
    const scheduler = new GuildAutonomousScheduler({ executeAgentTaskFn: executeMock });
    scheduler.start();

    const task = createTask(group.id, {
      title: "Do something",
      description: "Please handle this task",
      priority: "medium",
    });

    await flush(80);
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(executeMock).toHaveBeenCalledWith(agent.id, group.id, task.id);
    scheduler.stop();
  });

  it("dispatches open tasks when an agent becomes idle", async () => {
    const group = createGroup({ name: "g2", description: "g2" });
    const agent = createAgent({
      name: "A2",
      description: "worker",
      systemPrompt: "General coding assistant",
    });
    assignAgentToGroup(agent.id, group.id);
    updateAgent(agent.id, { status: "working", currentTaskId: "busy" });
    const task = createTask(group.id, {
      title: "Pending work",
      description: "Still open now",
      priority: "high",
    });

    const executeMock = vi.fn(async () => ({ summary: "ok" }));
    const scheduler = new GuildAutonomousScheduler({ executeAgentTaskFn: executeMock });
    scheduler.start();

    updateAgent(agent.id, { status: "idle", currentTaskId: undefined });
    guildEventBus.emit({ type: "agent_status_changed", agentId: agent.id, status: "idle" });

    await flush(80);
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(executeMock).toHaveBeenCalledWith(agent.id, group.id, task.id);

    const updated = getTask(group.id, task.id);
    expect(updated?.status).toBe("in_progress");
    scheduler.stop();
  });

  it("deduplicates concurrent trigger events for the same group", async () => {
    const group = createGroup({ name: "g3", description: "g3" });
    const agent = createAgent({
      name: "A3",
      description: "worker",
      systemPrompt: "General coding assistant",
    });
    assignAgentToGroup(agent.id, group.id);
    const task = createTask(group.id, {
      title: "One task",
      description: "single task only once",
      priority: "medium",
    });

    const executeMock = vi.fn(async () => ({ summary: "ok" }));
    const scheduler = new GuildAutonomousScheduler({ executeAgentTaskFn: executeMock });
    scheduler.start();

    guildEventBus.emit({ type: "agent_status_changed", agentId: agent.id, status: "idle" });
    guildEventBus.emit({ type: "agent_status_changed", agentId: agent.id, status: "idle" });
    guildEventBus.emit({ type: "agent_status_changed", agentId: agent.id, status: "idle" });

    await flush(80);
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(executeMock).toHaveBeenCalledWith(agent.id, group.id, task.id);
    scheduler.stop();
  });
});
