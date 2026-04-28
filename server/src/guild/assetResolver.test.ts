import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { AgentAsset } from "./types.js";

// Mock the mcp client module so we control what getMcpStatus returns without
// actually wiring up any MCP servers in the test environment.
vi.mock("../mcp/client.js", () => ({
  getMcpStatus: vi.fn(),
}));

// Import after the mock is registered so the module picks up our stub.
import { resolveAssetContext } from "./assetResolver.js";
import { getMcpStatus } from "../mcp/client.js";

const baseMcpAsset: AgentAsset = {
  id: "ast_1",
  type: "mcp_server",
  name: "slack",
  uri: "stdio://mcp-slack",
  description: "Slack messaging MCP",
  addedAt: new Date().toISOString(),
};

describe("assetResolver mcp_server", () => {
  beforeEach(() => {
    vi.mocked(getMcpStatus).mockReset();
  });

  afterEach(() => {
    vi.mocked(getMcpStatus).mockReset();
  });

  it("enriches the snippet with live tool names when the server is connected", () => {
    vi.mocked(getMcpStatus).mockReturnValue([
      {
        name: "slack",
        connected: true,
        toolCount: 2,
        tools: [
          { name: "send_message", description: "send a channel message" },
          { name: "list_channels", description: "list workspace channels" },
        ],
      },
    ]);
    const [resolved] = resolveAssetContext([baseMcpAsset]);
    expect(resolved.contextSnippet).toContain("已连接");
    expect(resolved.contextSnippet).toContain("send_message");
    expect(resolved.contextSnippet).toContain("list_channels");
  });

  it("warns when a matching server is configured but not connected", () => {
    vi.mocked(getMcpStatus).mockReturnValue([
      { name: "slack", connected: false, toolCount: 0, error: "ECONNREFUSED" },
    ]);
    const [resolved] = resolveAssetContext([baseMcpAsset]);
    expect(resolved.contextSnippet).toMatch(/未连接/);
    expect(resolved.contextSnippet).toContain("ECONNREFUSED");
  });

  it("warns explicitly when the server name isn't in user config", () => {
    vi.mocked(getMcpStatus).mockReturnValue([
      { name: "other-server", connected: true, toolCount: 1 },
    ]);
    const [resolved] = resolveAssetContext([baseMcpAsset]);
    expect(resolved.contextSnippet).toMatch(/未在用户配置中注册/);
  });

  it("falls back cleanly if getMcpStatus throws (MCP not initialized)", () => {
    vi.mocked(getMcpStatus).mockImplementation(() => {
      throw new Error("not initialized");
    });
    const [resolved] = resolveAssetContext([baseMcpAsset]);
    // No 已连接 banner — but the asset still resolves with its raw metadata
    // so agent prompts don't blow up during early startup.
    expect(resolved.contextSnippet).not.toContain("已连接");
    expect(resolved.contextSnippet).toContain("slack");
  });

  it("matches case-insensitively so 'Slack' and 'slack' both resolve", () => {
    vi.mocked(getMcpStatus).mockReturnValue([
      { name: "Slack", connected: true, toolCount: 1, tools: [{ name: "ping", description: "" }] },
    ]);
    const [resolved] = resolveAssetContext([baseMcpAsset]);
    expect(resolved.contextSnippet).toContain("已连接");
  });
});

describe("assetResolver repo", () => {
  let REPO: string;

  beforeEach(() => {
    REPO = join(tmpdir(), `repo-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(REPO, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(REPO)) rmSync(REPO, { recursive: true, force: true });
  });

  const repoAsset = (uri: string): AgentAsset => ({
    id: "ast_repo",
    type: "repo",
    name: "my-repo",
    uri,
    addedAt: new Date().toISOString(),
  });

  it("includes README plus other key files in priority order", () => {
    writeFileSync(join(REPO, "README.md"), "# My Repo\nUseful description");
    writeFileSync(join(REPO, "package.json"), '{"name":"my-repo","version":"1.0.0"}');
    writeFileSync(join(REPO, "CLAUDE.md"), "# Conventions\nalways use tabs");

    const [resolved] = resolveAssetContext([repoAsset(REPO)]);
    expect(resolved.contextSnippet).toContain("My Repo");
    expect(resolved.contextSnippet).toContain("package.json");
    expect(resolved.contextSnippet).toContain('"name":"my-repo"');
    expect(resolved.contextSnippet).toContain("CLAUDE.md");
    expect(resolved.contextSnippet).toContain("always use tabs");
  });

  it("dedupes case-insensitive variants so a README appears exactly once", () => {
    writeFileSync(join(REPO, "README.md"), "only readme content");
    const [resolved] = resolveAssetContext([repoAsset(REPO)]);
    // REPO_KEY_FILES lists README.md, readme.md, README, README.txt as separate
    // entries. On a case-insensitive FS (macOS default) existsSync() returns
    // true for all four, so without dedup the content would render 4 times.
    const matches = resolved.contextSnippet.match(/only readme content/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("falls back to metadata-only when repo directory doesn't exist", () => {
    const [resolved] = resolveAssetContext([repoAsset("/does/not/exist")]);
    expect(resolved.contextSnippet).toContain("my-repo");
    expect(resolved.contextSnippet).not.toContain("Structure:");
  });

  it("truncates files exceeding per-file budget and appends an ellipsis marker", () => {
    const large = "x".repeat(5000);
    writeFileSync(join(REPO, "README.md"), large);
    const [resolved] = resolveAssetContext([repoAsset(REPO)]);
    expect(resolved.contextSnippet).toMatch(/truncated/);
  });
});
