/**
 * 存储层单元测试（依赖 test-setup 设置 DATA_DIR）
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  listConversations,
  createConversation,
  getConversation,
  deleteConversation,
  cleanupOldConversations,
  getDataDir,
} from "./index.js";

const TEST_DATA_DIR = process.env.DATA_DIR!;

describe("storage", () => {
  afterAll(() => {
    try {
      rmSync(join(TEST_DATA_DIR, "conversations"), { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("getDataDir returns DATA_DIR", () => {
    expect(getDataDir()).toBe(TEST_DATA_DIR);
  });

  it("listConversations returns empty array when no conversations", () => {
    const list = listConversations();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBe(0);
  });

  it("createConversation creates meta and returns id", () => {
    const { id, meta } = createConversation(undefined, "测试对话");
    expect(id).toBeDefined();
    expect(meta.id).toBe(id);
    expect(meta.title).toBe("测试对话");
    expect(meta.createdAt).toBeDefined();
    expect(meta.updatedAt).toBeDefined();
  });

  it("getConversation returns meta for existing id", () => {
    const { id, meta } = createConversation(undefined, "存在");
    const found = getConversation(id);
    expect(found).not.toBeNull();
    expect(found!.title).toBe("存在");
  });

  it("getConversation returns null for missing id", () => {
    expect(getConversation("nonexistent")).toBeNull();
  });

  it("deleteConversation removes directory and returns true", () => {
    const { id } = createConversation(undefined, "待删");
    const convDir = join(TEST_DATA_DIR, "conversations", id);
    expect(existsSync(convDir)).toBe(true);
    const ok = deleteConversation(id);
    expect(ok).toBe(true);
    expect(existsSync(convDir)).toBe(false);
  });

  it("cleanupOldConversations removes old conversations only", () => {
    const { id: id1 } = createConversation(undefined, "保留");
    const { id: id2 } = createConversation(undefined, "删除");
    const convDir = join(TEST_DATA_DIR, "conversations");
    const metaPath2 = join(convDir, id2, "meta.json");
    const meta2 = JSON.parse(readFileSync(metaPath2, "utf-8"));
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 40);
    meta2.updatedAt = oldDate.toISOString();
    writeFileSync(metaPath2, JSON.stringify(meta2, null, 2));
    const removed = cleanupOldConversations(30);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(getConversation(id2)).toBeNull();
    expect(getConversation(id1)).not.toBeNull();
  });
});
