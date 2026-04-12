import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "fs";
import { join } from "path";
import {
  createWorkspace,
  readWorkspace,
  appendDecision,
  appendHandoff,
  updatePlanSection,
  setWorkspaceStatus,
  setOpenQuestions,
  snapshotForPrompt,
} from "./workspace.js";
import type { TaskHandoff } from "./types.js";

const TEST_DATA_DIR = process.env.DATA_DIR!;

describe("guild workspace", () => {
  const groupId = "grp_ws_test";
  const parentTaskId = "task_req_1";

  beforeEach(() => {
    rmSync(join(TEST_DATA_DIR, "guild"), { recursive: true, force: true });
  });
  afterEach(() => {
    rmSync(join(TEST_DATA_DIR, "guild"), { recursive: true, force: true });
  });

  it("creates a workspace and reads it back", () => {
    const ref = createWorkspace(groupId, parentTaskId, "Ship login feature", "Users can log in via SSO", "agent_lead");
    expect(ref).toContain("workspaces");

    const ws = readWorkspace(groupId, parentTaskId);
    expect(ws).not.toBeNull();
    expect(ws!.meta.title).toBe("Ship login feature");
    expect(ws!.meta.leadAgentId).toBe("agent_lead");
    expect(ws!.meta.status).toBe("planning");
    expect(ws!.goal).toContain("SSO");
  });

  it("appends decisions and handoffs without clobbering prior content", () => {
    createWorkspace(groupId, parentTaskId, "R1", "goal", "agent_lead");

    appendDecision(groupId, parentTaskId, "agent_lead", "使用 OIDC 而非 SAML");
    appendDecision(groupId, parentTaskId, "agent_alice", "API 路径约定 /auth/*");

    const handoff: TaskHandoff = {
      fromAgentId: "agent_alice",
      toSubtaskId: "task_sub_ui",
      summary: "Backend auth endpoints ready",
      artifacts: [
        { kind: "commit", ref: "abc123", description: "feat(auth): add endpoints" },
        { kind: "file", ref: "docs/auth.md" },
      ],
      inputsConsumed: [],
      openQuestions: ["Session TTL 待确认"],
      createdAt: new Date().toISOString(),
    };
    appendHandoff(groupId, parentTaskId, "task_sub_api", handoff);

    const ws = readWorkspace(groupId, parentTaskId)!;
    expect(ws.decisions).toContain("OIDC");
    expect(ws.decisions).toContain("/auth/*");
    expect(ws.handoffs).toContain("task_sub_api");
    expect(ws.handoffs).toContain("Backend auth endpoints ready");
    expect(ws.handoffs).toContain("abc123");
    expect(ws.handoffs).toContain("Session TTL");
  });

  it("updates plan, scope, status, and open questions independently", () => {
    createWorkspace(groupId, parentTaskId, "R2", "goal2", "agent_lead");

    updatePlanSection(groupId, parentTaskId, "| id | title |\n|----|------|\n| t1 | API |");
    setWorkspaceStatus(groupId, parentTaskId, "in_progress");
    setOpenQuestions(groupId, parentTaskId, ["能否复用 v1 DB schema?", "谁负责 SRE 评审?"]);

    const ws = readWorkspace(groupId, parentTaskId)!;
    expect(ws.plan).toContain("t1");
    expect(ws.meta.status).toBe("in_progress");
    expect(ws.openQuestions).toContain("复用 v1");
    expect(ws.openQuestions).toContain("SRE 评审");
  });

  it("snapshotForPrompt emits goal/plan/handoffs/open questions compactly", () => {
    createWorkspace(groupId, parentTaskId, "R3", "Do the thing", "agent_lead");
    updatePlanSection(groupId, parentTaskId, "- step 1\n- step 2");
    appendHandoff(groupId, parentTaskId, "task_x", {
      fromAgentId: "agent_x",
      summary: "done step 1",
      artifacts: [],
      createdAt: new Date().toISOString(),
    });
    setOpenQuestions(groupId, parentTaskId, ["is step 3 in scope?"]);

    const snap = snapshotForPrompt(groupId, parentTaskId)!;
    expect(snap).toContain("Do the thing");
    expect(snap).toContain("step 1");
    expect(snap).toContain("done step 1");
    expect(snap).toContain("is step 3 in scope?");
  });
});
