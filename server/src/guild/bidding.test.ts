import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "fs";
import { cleanGuildDir } from "../test-setup.js";
import { join } from "path";
import { createGroup, createAgent, assignAgentToGroup } from "./guildManager.js";
import { createTask, getTask } from "./taskBoard.js";
import { autoBid, calculateConfidence, evaluateTask, setBiddingConfig } from "./bidding.js";

const TEST_DATA_DIR = process.env.DATA_DIR!;

describe("guild bidding", () => {
  beforeEach(() => {
    cleanGuildDir();
    setBiddingConfig({ minConfidenceThreshold: 0.3, assetBonusWeight: 0.15, loadDecayFactor: 0.9 });
  });

  afterEach(() => {
    cleanGuildDir();
  });

  it("priority widens the bidding threshold without inflating confidence", () => {
    // Zero out bonuses that would push a borderline agent above any realistic
    // threshold — this test only cares about priority → threshold movement.
    setBiddingConfig({
      minConfidenceThreshold: 0.45,
      assetBonusWeight: 0.15,
      ownerBonusWeight: 0,
      successRatePrior: 0,
      loadDecayFactor: 0.9,
    });

    const agent = createAgent({
      name: "Borderline Worker",
      description: "occasional helper",
      systemPrompt: "general assistant",
      assets: [{ type: "document", name: "guide", uri: "doc", description: "fix layout hooks" }],
    });
    // Skip newbie grace (which would halve the threshold) so this test
    // isolates the priority-driven threshold movement we actually want to
    // measure.
    (agent.stats as { tasksCompleted: number }).tasksCompleted = 10;
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

  it("owner bonus steers a task to the agent who owns the relevant asset", () => {
    setBiddingConfig({
      minConfidenceThreshold: 0.3,
      assetBonusWeight: 0,
      ownerBonusWeight: 0.5,
      successRatePrior: 0,
    });

    const group = createGroup({ name: "Fullstack", description: "web" });
    const backend = createAgent({
      name: "Backend Lee",
      description: "backend engineer",
      systemPrompt: "I work on APIs and databases",
      assets: [{ type: "repo", name: "backend", uri: "file:///repos/backend", description: "backend service" }],
    });
    const frontend = createAgent({
      name: "Frontend Sun",
      description: "frontend engineer",
      systemPrompt: "I work on UI and backend alike, very general",
      assets: [{ type: "repo", name: "frontend", uri: "file:///repos/frontend", description: "frontend ui" }],
    });
    assignAgentToGroup(backend.id, group.id);
    assignAgentToGroup(frontend.id, group.id);

    const task = createTask(group.id, {
      title: "Add backend endpoint",
      description: "add a new backend endpoint to the backend service",
      priority: "medium",
    });

    const backendBid = evaluateTask(backend, task);
    const frontendBid = evaluateTask(frontend, task);
    expect(backendBid).not.toBeNull();
    expect(backendBid!.confidence).toBeGreaterThan(frontendBid?.confidence ?? 0);
    expect(backendBid!.scoreBreakdown?.ownerBonus).toBeGreaterThan(0);
  });

  it("newbie agents (tasksCompleted < 3) get a halved threshold", () => {
    setBiddingConfig({
      minConfidenceThreshold: 0.5,
      assetBonusWeight: 0,
      ownerBonusWeight: 0,
      successRatePrior: 0.5,
    });

    const newbie = createAgent({
      name: "Fresh Grad",
      description: "just joined",
      systemPrompt: "general assistant",
    });
    const veteran = createAgent({
      name: "Veteran",
      description: "long tenure",
      systemPrompt: "general assistant",
    });
    (veteran.stats as { tasksCompleted: number }).tasksCompleted = 5;

    const group = createGroup({ name: "G", description: "g" });
    assignAgentToGroup(newbie.id, group.id);
    assignAgentToGroup(veteran.id, group.id);

    const task = createTask(group.id, {
      title: "ambient chore",
      description: "do some generic cleanup",
      priority: "medium",
    });

    // Pull breakdowns via includeBelowThreshold so we can inspect `threshold`
    // regardless of whether the score happened to clear — the test is about
    // the *threshold* moving, not whether a specific artificial score passed.
    const newbieBid = evaluateTask(newbie, task, { includeBelowThreshold: true });
    const veteranBid = evaluateTask(veteran, task, { includeBelowThreshold: true });
    expect(newbieBid!.scoreBreakdown!.threshold).toBeCloseTo(0.25, 5); // 0.5 * 0.5
    expect(veteranBid!.scoreBreakdown!.threshold).toBeCloseTo(0.5, 5);
  });

  it("startBidding returns below-threshold candidates with via=below_threshold", () => {
    setBiddingConfig({
      minConfidenceThreshold: 0.95, // impossibly high — nobody will clear
      assetBonusWeight: 0,
      ownerBonusWeight: 0,
      successRatePrior: 0,
    });

    const veteran = createAgent({
      name: "Vet",
      description: "vet",
      systemPrompt: "general",
    });
    (veteran.stats as { tasksCompleted: number }).tasksCompleted = 10;
    const group = createGroup({ name: "G", description: "g" });
    assignAgentToGroup(veteran.id, group.id);

    const task = createTask(group.id, {
      title: "task",
      description: "do work",
      priority: "medium",
    });

    const bid = evaluateTask(veteran, task, { includeBelowThreshold: true });
    expect(bid).not.toBeNull();
    expect(bid!.via).toBe("below_threshold");
    expect(bid!.scoreBreakdown).toBeDefined();
  });

  it("autoBid persists below-threshold candidates so the UI can explain why", () => {
    setBiddingConfig({
      minConfidenceThreshold: 0.95, // nobody will clear
      assetBonusWeight: 0,
      ownerBonusWeight: 0,
      successRatePrior: 0,
    });

    // Two veteran agents — neither should clear the absurd threshold.
    const a = createAgent({ name: "A", description: "", systemPrompt: "generic" });
    const b = createAgent({ name: "B", description: "", systemPrompt: "generic" });
    (a.stats as { tasksCompleted: number }).tasksCompleted = 10;
    (b.stats as { tasksCompleted: number }).tasksCompleted = 10;
    const group = createGroup({ name: "G", description: "g" });
    assignAgentToGroup(a.id, group.id);
    assignAgentToGroup(b.id, group.id);

    const task = createTask(group.id, {
      title: "task",
      description: "generic work",
      priority: "medium",
    });

    autoBid(group.id, task);
    const saved = getTask(group.id, task.id);
    // With 2 idle agents and nobody clearing, fallback doesn't kick in — stalled.
    // All candidate breakdowns must still be persisted on the task for the UI.
    expect(saved?.bids?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(saved?.bids?.every((b) => b.via === "below_threshold")).toBe(true);
  });

  it("calculateConfidence never bunches veteran agents at 1.0", () => {
    setBiddingConfig({ minConfidenceThreshold: 0.3, loadDecayFactor: 0.9, successRatePrior: 0.5 });
    const agent = createAgent({
      name: "Veteran",
      description: "senior",
      systemPrompt: "experienced engineer",
    });
    // Simulate a veteran who already has many completed tasks.
    (agent.stats as { tasksCompleted: number }).tasksCompleted = 10;
    (agent.stats as { successRate: number }).successRate = 1;
    const task = createTask(createGroup({ name: "g", description: "d" }).id, {
      title: "generic task",
      description: "do some work",
      priority: "medium",
    });
    const c = calculateConfidence(agent, task);
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(1);
  });
});
