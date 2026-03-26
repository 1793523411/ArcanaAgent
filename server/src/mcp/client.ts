import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { McpServerConfig } from "../config/userConfig.js";
import { logMCP } from "../lib/logger.js";

type AnyTransport = StdioClientTransport | StreamableHTTPClientTransport;

interface McpConnection {
  client: Client;
  transport: AnyTransport;
  tools: StructuredToolInterface[];
  serverName: string;
  config: McpServerConfig;
}

const connections = new Map<string, McpConnection>();
const failedServers = new Map<string, { config: McpServerConfig; error: string }>();

function jsonSchemaToZod(schema: Record<string, unknown> | undefined): z.ZodObject<Record<string, z.ZodTypeAny>> {
  if (!schema || typeof schema !== "object") return z.object({});

  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((schema.required as string[]) ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, prop] of Object.entries(properties)) {
    let field: z.ZodTypeAny;
    const pType = prop.type as string | undefined;
    const pEnum = prop.enum as string[] | undefined;
    const pDesc = prop.description as string | undefined;

    switch (pType) {
      case "string":
        field = pEnum ? z.enum(pEnum as [string, ...string[]]) : z.string();
        break;
      case "number":
      case "integer":
        field = z.number();
        break;
      case "boolean":
        field = z.boolean();
        break;
      case "array": {
        // 正确处理数组的 items 字段
        const items = prop.items as Record<string, unknown> | undefined;
        if (items && typeof items === "object") {
          const itemType = items.type as string | undefined;
          let itemSchema: z.ZodTypeAny;
          switch (itemType) {
            case "string":
              itemSchema = z.string();
              break;
            case "number":
            case "integer":
              itemSchema = z.number();
              break;
            case "boolean":
              itemSchema = z.boolean();
              break;
            case "object":
              itemSchema = jsonSchemaToZod(items);
              break;
            default:
              itemSchema = z.any();
          }
          field = z.array(itemSchema);
        } else {
          field = z.array(z.any());
        }
        break;
      }
      case "object":
        // 递归处理嵌套对象
        field = (prop.properties as Record<string, unknown>)
          ? jsonSchemaToZod(prop as Record<string, unknown>)
          : z.record(z.any());
        break;
      default:
        field = z.any();
    }
    if (pDesc) field = field.describe(pDesc);
    if (!required.has(key)) field = field.optional();
    shape[key] = field;
  }
  return z.object(shape);
}

/** Sanitize a string so it only contains characters allowed by LLM API tool name patterns: [a-zA-Z0-9_-] */
function sanitizeToolName(raw: string): string {
  // Replace non-ASCII / special chars with underscores, collapse runs, trim edges
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "") || "unnamed";
}

function createLangChainTool(
  mcpTool: { name: string; description?: string; inputSchema?: Record<string, unknown> },
  mcpClient: Client,
  serverName: string
): StructuredToolInterface {
  const schema = jsonSchemaToZod(mcpTool.inputSchema);
  const safeName = `mcp_${sanitizeToolName(serverName)}__${sanitizeToolName(mcpTool.name)}`;
  return tool(
    async (input: Record<string, unknown>) => {
      try {
        const result = await mcpClient.callTool({ name: mcpTool.name, arguments: input });
        const contents = result.content as Array<{ type: string; text?: string }>;
        if (result.isError) {
          return `[MCP error] ${contents.map((c) => c.text ?? "").join("\n")}`;
        }
        return contents.map((c) => (c.type === "text" ? c.text ?? "" : JSON.stringify(c))).join("\n") || "(no output)";
      } catch (e) {
        return `[MCP error] ${e instanceof Error ? e.message : String(e)}`;
      }
    },
    {
      name: safeName,
      description: `[MCP: ${serverName}] ${mcpTool.description || mcpTool.name}`,
      schema,
    }
  );
}

function configChanged(existing: McpConnection, next: McpServerConfig): boolean {
  const a = existing.config;
  if (a.transport !== next.transport) return true;
  if (a.transport === "stdio" && next.transport === "stdio") {
    if (a.command !== next.command) return true;
    if (JSON.stringify(a.args) !== JSON.stringify(next.args)) return true;
    if (JSON.stringify(a.env ?? {}) !== JSON.stringify(next.env ?? {})) return true;
  }
  if (a.transport === "streamablehttp" && next.transport === "streamablehttp") {
    if (a.url !== next.url) return true;
    if (JSON.stringify(a.headers ?? {}) !== JSON.stringify(next.headers ?? {})) return true;
  }
  return false;
}

async function connectServer(config: McpServerConfig): Promise<void> {
  let transport: AnyTransport;
  if (config.transport === "streamablehttp") {
    transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: config.headers ? { headers: config.headers } : undefined,
    });
  } else {
    transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env ? { ...process.env, ...config.env } as Record<string, string> : undefined,
    });
  }
  const client = new Client({ name: "my-agent", version: "1.0.0" });
  await client.connect(transport);
  const { tools: mcpTools } = await client.listTools();
  const lcTools = mcpTools.map((t) => createLangChainTool(t, client, config.name));
  connections.set(config.name, { client, transport, tools: lcTools, serverName: config.name, config });
  logMCP("connect", config.name, `${lcTools.length} tool(s) available`);
}

async function disconnectServer(name: string): Promise<void> {
  const conn = connections.get(name);
  if (!conn) return;
  try {
    await conn.client.close();
  } catch {
    /* best effort */
  }
  connections.delete(name);
  logMCP("disconnect", name);
}

export async function connectToMcpServers(servers: McpServerConfig[]): Promise<void> {
  const desired = new Set(servers.map((s) => s.name));

  // 断开已移除的服务器
  for (const name of [...connections.keys()]) {
    if (!desired.has(name)) await disconnectServer(name);
  }
  for (const name of [...failedServers.keys()]) {
    if (!desired.has(name)) failedServers.delete(name);
  }

  for (const server of servers) {
    const existing = connections.get(server.name);
    if (existing) {
      // 配置未变化则跳过，变化则重连
      if (!configChanged(existing, server)) continue;
      await disconnectServer(server.name);
    }
    try {
      await connectServer(server);
      failedServers.delete(server.name);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      failedServers.set(server.name, { config: server, error: errMsg });
      logMCP("error", server.name, errMsg);
    }
  }
}

export function getMcpTools(): StructuredToolInterface[] {
  const all: StructuredToolInterface[] = [];
  for (const conn of connections.values()) {
    all.push(...conn.tools);
  }
  return all;
}

export function getMcpStatus(): Array<{ name: string; connected: boolean; toolCount: number; tools?: Array<{ name: string; description: string }>; error?: string }> {
  const result: Array<{ name: string; connected: boolean; toolCount: number; tools?: Array<{ name: string; description: string }>; error?: string }> = [];
  for (const [name, conn] of connections.entries()) {
    result.push({
      name,
      connected: true,
      toolCount: conn.tools.length,
      tools: conn.tools.map((t) => ({
        name: t.name.replace(`mcp_${sanitizeToolName(name)}__`, ""),
        description: (t.description ?? "").replace(`[MCP: ${name}] `, ""),
      })),
    });
  }
  for (const [name, info] of failedServers.entries()) {
    if (!connections.has(name)) {
      result.push({ name, connected: false, toolCount: 0, error: info.error });
    }
  }
  return result;
}

export async function restartMcpServer(serverName: string, servers: McpServerConfig[]): Promise<{ connected: boolean; toolCount: number; error?: string }> {
  const config = servers.find((s) => s.name === serverName);
  if (!config) throw new Error(`MCP server "${serverName}" not found in config`);

  await disconnectServer(serverName);
  failedServers.delete(serverName);

  try {
    await connectServer(config);
    failedServers.delete(serverName);
    const conn = connections.get(serverName);
    return { connected: true, toolCount: conn?.tools.length ?? 0 };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    failedServers.set(serverName, { config, error: errMsg });
    logMCP("error", serverName, errMsg);
    return { connected: false, toolCount: 0, error: errMsg };
  }
}

export async function disconnectAll(): Promise<void> {
  for (const name of [...connections.keys()]) {
    await disconnectServer(name);
  }
}
