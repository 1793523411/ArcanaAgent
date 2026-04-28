import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { cleanGuildDir } from "../test-setup.js";
import { join } from "path";
import {
  saveMemory,
  searchRelevant,
  reinforceMemory,
  pruneWeakMemories,
  settleTaskMemory,
  getMemories,
} from "./memoryManager.js";
import type { GuildTask, TaskResult } from "./types.js";

const TEST_DATA_DIR = process.env.DATA_DIR!;
const AGENT_ID = "agent_mem_test";

function memIndexPath(): string {
  return join(TEST_DATA_DIR, "guild", "agents", AGENT_ID, "memory", "index.json");
}

describe("memoryManager v2", () => {
  beforeEach(() => {
    cleanGuildDir();
  });
  afterEach(() => {
    cleanGuildDir();
  });

  it("saveMemory persists v2 fields and marks schema version", () => {
    const m = saveMemory(AGENT_ID, {
      type: "experience",
      title: "Fix login bug",
      summary: "Root cause was stale cookie",
      content: "long description",
      tags: ["auth", "bug"],
      sourceTaskId: "task_1",
      groupId: "group_1",
    });
    expect(m.v).toBe(2);
    expect(m.strength).toBe(1);
    expect(m.pinned).toBe(false);
    expect(m.summary).toContain("stale cookie");
    expect(m.updatedAt).toBeDefined();

    const raw = JSON.parse(readFileSync(memIndexPath(), "utf-8"));
    expect(raw[0].v).toBe(2);
    expect(raw[0].sourceTaskId).toBe("task_1");
  });

  it("searchRelevant persists access count bumps to disk", () => {
    const m = saveMemory(AGENT_ID, {
      type: "experience",
      title: "API retry strategy",
      content: "exponential backoff for 5xx",
      tags: ["api"],
    });
    expect(m.accessCount).toBe(0);

    searchRelevant(AGENT_ID, "retry strategy for api");
    const after = JSON.parse(readFileSync(memIndexPath(), "utf-8"));
    expect(after[0].accessCount).toBe(1);
    expect(after[0].lastAccessedAt).toBeDefined();

    // A second lookup should compound.
    searchRelevant(AGENT_ID, "api retry");
    const after2 = JSON.parse(readFileSync(memIndexPath(), "utf-8"));
    expect(after2[0].accessCount).toBe(2);
  });

  it("migrates v1 records (no strength/pinned) on load", () => {
    const dir = join(TEST_DATA_DIR, "guild", "agents", AGENT_ID, "memory");
    mkdirSync(dir, { recursive: true });
    const v1Record = {
      id: "mem_legacy_1",
      type: "experience",
      title: "legacy memory",
      content: "from before",
      tags: [],
      createdAt: "2024-01-01T00:00:00.000Z",
      accessCount: 3,
    };
    writeFileSync(join(dir, "index.json"), JSON.stringify([v1Record]));

    const loaded = getMemories(AGENT_ID);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].v).toBe(2);
    expect(loaded[0].strength).toBe(1);
    expect(loaded[0].pinned).toBe(false);
    expect(loaded[0].updatedAt).toBe("2024-01-01T00:00:00.000Z");
    expect(loaded[0].accessCount).toBe(3);
  });

  it("reinforceMemory bumps strength and persists", () => {
    const m = saveMemory(AGENT_ID, {
      type: "knowledge",
      title: "OAuth notes",
      content: "...",
      tags: ["auth"],
    });
    reinforceMemory(AGENT_ID, m.id, 2);
    const raw = JSON.parse(readFileSync(memIndexPath(), "utf-8"));
    expect(raw[0].strength).toBe(3);
  });

  it("pruneWeakMemories drops low-score entries but keeps pinned", () => {
    // 5 memories, cap at 3 — one pinned, rest ranked by strength.
    saveMemory(AGENT_ID, { type: "experience", title: "weak-1", content: "x", tags: [] });
    saveMemory(AGENT_ID, { type: "experience", title: "weak-2", content: "x", tags: [] });
    const strong = saveMemory(AGENT_ID, {
      type: "experience", title: "strong", content: "x", tags: [], strength: 8,
    });
    const pinned = saveMemory(AGENT_ID, {
      type: "knowledge", title: "pinned-weak", content: "x", tags: [], pinned: true, strength: 0,
    });
    saveMemory(AGENT_ID, { type: "experience", title: "middle", content: "x", tags: [], strength: 3 });

    const dropped = pruneWeakMemories(AGENT_ID, 3);
    expect(dropped).toBe(2);
    const kept = getMemories(AGENT_ID);
    expect(kept.map((k) => k.id)).toContain(pinned.id);
    expect(kept.map((k) => k.id)).toContain(strong.id);
    expect(kept).toHaveLength(3);
  });

  it("settleTaskMemory uses handoff summary when available", () => {
    const task: GuildTask = {
      id: "task_abc",
      groupId: "g_1",
      title: "Add endpoint",
      description: "Add /users",
      priority: "high",
      status: "completed",
      createdAt: new Date().toISOString(),
      kind: "subtask",
    } as GuildTask;
    const result: TaskResult = {
      summary: "full dump of conversation output",
      handoff: {
        fromAgentId: AGENT_ID,
        summary: "Added GET /users returning paginated list",
        artifacts: [{ kind: "file", ref: "api/users.ts" }],
        openQuestions: ["auth scope?"],
        createdAt: new Date().toISOString(),
      },
    };

    const mems = settleTaskMemory(AGENT_ID, task, result);
    const mem = mems[0];
    expect(mem.summary).toContain("Added GET /users");
    expect(mem.sourceTaskId).toBe("task_abc");
    expect(mem.groupId).toBe("g_1");
    expect(mem.content).toContain("api/users.ts");
    expect(mem.content).toContain("auth scope?");
  });

  it("searchRelevant matches CJK queries via character bigrams", () => {
    const hit = saveMemory(AGENT_ID, {
      type: "experience",
      title: "部署失败排查",
      content: "线上部署时容器健康检查超时",
      tags: ["部署"],
    });
    saveMemory(AGENT_ID, {
      type: "experience",
      title: "unrelated english doc",
      content: "nothing about the above",
      tags: ["other"],
    });
    // Whitespace tokenization alone would miss this — bigrams "部署" / "失败" let it land.
    const hits = searchRelevant(AGENT_ID, "部署失败");
    expect(hits.map((h) => h.id)).toContain(hit.id);
    expect(hits[0].id).toBe(hit.id);
  });

  it("searchRelevant weights title hits above content hits", () => {
    const titleHit = saveMemory(AGENT_ID, {
      type: "experience",
      title: "oauth token refresh",
      content: "mentions something else entirely",
      tags: [],
    });
    saveMemory(AGENT_ID, {
      type: "experience",
      title: "log rotation config",
      // Repeats the keyword 5 times in content — should still lose to title match.
      content: "oauth oauth oauth oauth oauth",
      tags: [],
    });
    const hits = searchRelevant(AGENT_ID, "oauth");
    expect(hits[0].id).toBe(titleHit.id);
  });

  it("writes human-readable markdown alongside the index", () => {
    const m = saveMemory(AGENT_ID, {
      type: "experience",
      title: "Solved flake",
      summary: "race in setup",
      content: "Details here",
      tags: ["flaky"],
    });
    const md = join(TEST_DATA_DIR, "guild", "agents", AGENT_ID, "memory", "experiences", `${m.id}.md`);
    expect(existsSync(md)).toBe(true);
    const body = readFileSync(md, "utf-8");
    expect(body).toContain("# Solved flake");
    expect(body).toContain("> race in setup");
  });
});
