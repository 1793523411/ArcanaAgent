import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
