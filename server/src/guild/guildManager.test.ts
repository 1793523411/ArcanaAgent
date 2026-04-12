import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync, existsSync } from "fs";
import { join } from "path";
import {
  createGroup,
  createAgent,
  assignAgentToGroup,
  deleteGroup,
  getGroup,
  getAgent,
  listGroups,
  getGuild,
} from "./guildManager.js";

const TEST_DATA_DIR = process.env.DATA_DIR!;

describe("deleteGroup", () => {
  beforeEach(() => {
    rmSync(join(TEST_DATA_DIR, "guild"), { recursive: true, force: true });
  });
  afterEach(() => {
    rmSync(join(TEST_DATA_DIR, "guild"), { recursive: true, force: true });
  });

  it("removes the group directory, releases agents to the pool, and updates the guild index", () => {
    const group = createGroup({ name: "Doomed", description: "to be deleted" });
    const agent = createAgent({
      name: "Worker",
      description: "w",
      systemPrompt: "do stuff",
    });
    assignAgentToGroup(agent.id, group.id);

    expect(listGroups().map((g) => g.id)).toContain(group.id);

    const ok = deleteGroup(group.id);
    expect(ok).toBe(true);

    // Group meta + workspace dir gone.
    expect(existsSync(join(TEST_DATA_DIR, "guild", "groups", group.id))).toBe(false);
    expect(getGroup(group.id)).toBeNull();
    expect(listGroups().map((g) => g.id)).not.toContain(group.id);

    // Guild.groups no longer references it.
    expect(getGuild().groups).not.toContain(group.id);

    // Agent was released back to the pool.
    const after = getAgent(agent.id);
    expect(after?.groupId).toBeUndefined();
    expect(getGuild().agentPool).toContain(agent.id);
  });

  it("returns false when the group does not exist", () => {
    expect(deleteGroup("grp_does_not_exist")).toBe(false);
  });

  it("keeps an agent bound to a second group when one of its groups is deleted", () => {
    const g1 = createGroup({ name: "G1", description: "a" });
    const g2 = createGroup({ name: "G2", description: "b" });
    const agent = createAgent({ name: "Shared", description: "s", systemPrompt: "p" });
    assignAgentToGroup(agent.id, g1.id);
    assignAgentToGroup(agent.id, g2.id);

    deleteGroup(g1.id);

    const after = getAgent(agent.id);
    expect(after?.groupId).toBe(g2.id);
    expect(getGuild().agentPool).not.toContain(agent.id);
  });
});
