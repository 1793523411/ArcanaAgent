import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "fs";
import { join } from "path";
import { createGroup, createAgent, assignAgentToGroup } from "./guildManager.js";
import { createTask, getTask } from "./taskBoard.js";
import { autoBid, calculateConfidence, evaluateTask, setBiddingConfig } from "./bidding.js";

const TEST_DATA_DIR = process.env.DATA_DIR!;

describe("guild bidding", () => {
  beforeEach(() => {
    rmSync(join(TEST_DATA_DIR, "guild"), { recursive: true, force: true });
    setBiddingConfig({ minConfidenceThreshold: 0.3, assetBonusWeight: 0.15, loadDecayFactor: 0.9 });
  });

  afterEach(() => {
    rmSync(join(TEST_DATA_DIR, "guild"), { recursive: true, force: true });
  });

  it("priority widens the bidding threshold without inflating confidence", () => {
    // High-ish threshold so a borderline agent gets gated by priority alone.
    setBiddingConfig({ minConfidenceThreshold: 0.45, assetBonusWeight: 0.15, loadDecayFactor: 0.9 });

    const agent = createAgent({
      name: "Borderline Worker",
      description: "occasional helper",
      systemPrompt: "general assistant",
      assets: [{ type: "document", name: "guide", uri: "doc", description: "fix layout hooks" }],
    });
    const group = createGroup({ name: "FE", description: "frontend group" });
    assignAgentToGroup(agent.id, group.id);

    const baseTask = createTask(group.id, {
      title: "Fix layout",
      description: "Fix layout and hooks issue",
      priority: "low",
    });
    const urgentTask = createTask(group.id, {
      title: "Fix layout",
      description: "Fix layout and hooks issue",
      priority: "urgent",
    });

    // Confidence is identical: priority must not inflate the raw score.
    expect(calculateConfidence(agent, baseTask)).toBeCloseTo(calculateConfidence(agent, urgentTask), 6);

    // But the threshold gate widens for urgent → urgent bids while low does not.
    const lowBid = evaluateTask(agent, baseTask);
    const urgentBid = evaluateTask(agent, urgentTask);
    expect(lowBid).toBeNull();
    expect(urgentBid).not.toBeNull();
  });

  it("start auto-bid should keep bidding evidence on task", () => {
    const group = createGroup({ name: "Guild Team", description: "team" });
    const agent = createAgent({
      name: "API Agent",
      description: "API worker",
      systemPrompt: "Skilled at API and backend tasks",
      assets: [{ type: "api", name: "API spec", uri: "internal://api", description: "backend api endpoint design" }],
    });
    assignAgentToGroup(agent.id, group.id);

    const task = createTask(group.id, {
      title: "Design API endpoint",
      description: "Design backend API endpoint and response schema",
      priority: "high",
    });

    const bid = autoBid(group.id, task);
    expect(bid).not.toBeNull();

    const saved = getTask(group.id, task.id);
    expect(saved).not.toBeNull();
    expect(saved?.status).toBe("in_progress");
    expect(saved?.assignedAgentId).toBe(agent.id);
    expect(saved?.bids?.length).toBeGreaterThan(0);
  });
});
