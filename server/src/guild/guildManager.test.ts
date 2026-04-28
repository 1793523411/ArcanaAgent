import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync, existsSync } from "fs";
import { cleanGuildDir } from "../test-setup.js";
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
  buildForkParams,
} from "./guildManager.js";

const TEST_DATA_DIR = process.env.DATA_DIR!;

describe("deleteGroup", () => {
  beforeEach(() => {
    cleanGuildDir();
  });
  afterEach(() => {
    cleanGuildDir();
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

describe("buildForkParams", () => {
  beforeEach(() => cleanGuildDir());
  afterEach(() => cleanGuildDir());

  it("copies profile & assets when no overrides provided, appending '(派生)' to the name", () => {
    const source = createAgent({
      name: "Backend Lee",
      description: "API specialist",
      icon: "🦀",
      color: "#EF4444",
      systemPrompt: "I write backends",
      allowedTools: ["run_command", "read_file"],
      modelId: "claude-opus-4-7",
      assets: [
        { type: "repo", name: "backend", uri: "file:///r/backend", description: "repo" },
      ],
    });

    const forked = buildForkParams(source);

    expect(forked.name).toBe("Backend Lee (派生)");
    expect(forked.description).toBe("API specialist");
    expect(forked.icon).toBe("🦀");
    expect(forked.color).toBe("#EF4444");
    expect(forked.systemPrompt).toBe("I write backends");
    expect(forked.allowedTools).toEqual(["run_command", "read_file"]);
    expect(forked.modelId).toBe("claude-opus-4-7");
    // Assets are stripped of id/addedAt so createAgent will re-mint them —
    // otherwise two agents would share asset ids.
    expect(forked.assets).toEqual([
      { type: "repo", name: "backend", uri: "file:///r/backend", description: "repo", metadata: undefined, tags: undefined },
    ]);
  });

  it("applies overrides on top of source fields", () => {
    const source = createAgent({
      name: "Generalist",
      description: "generic",
      systemPrompt: "I help",
    });

    const forked = buildForkParams(source, {
      name: "Mobile Specialist",
      systemPrompt: "I specialize in iOS/Android",
    });

    expect(forked.name).toBe("Mobile Specialist");
    expect(forked.systemPrompt).toBe("I specialize in iOS/Android");
    // Untouched fields still come from the source.
    expect(forked.description).toBe("generic");
  });

  it("accepts an assets override that wholesale replaces source assets", () => {
    const source = createAgent({
      name: "Src",
      description: "",
      systemPrompt: "",
      assets: [{ type: "repo", name: "old-repo", uri: "file:///old" }],
    });

    const forked = buildForkParams(source, {
      assets: [{ type: "document", name: "new-doc", uri: "https://docs.example" }],
    });

    expect(forked.assets).toHaveLength(1);
    expect(forked.assets?.[0]).toMatchObject({ name: "new-doc", type: "document" });
  });

  it("yields params that createAgent can consume to produce an independent agent", () => {
    const source = createAgent({
      name: "Prototype",
      description: "",
      systemPrompt: "be helpful",
    });

    const forkedAgent = createAgent(buildForkParams(source));

    expect(forkedAgent.id).not.toBe(source.id);
    expect(forkedAgent.name).toBe("Prototype (派生)");
    // Fresh stats — the caveat we surface in the UI is honored here.
    expect(forkedAgent.stats.tasksCompleted).toBe(0);
    expect(forkedAgent.stats.successRate).toBe(0);
  });
});
