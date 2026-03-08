import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { McpServerConfig } from "../config/userConfig.js";

interface McpConnection {
  client: Client;
  transport: StdioClientTransport;
  tools: StructuredToolInterface[];
  serverName: string;
  config: McpServerConfig;
}

const connections = new Map<string, McpConnection>();

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
      case "array":
        field = z.array(z.any());
        break;
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

function createLangChainTool(
  mcpTool: { name: string; description?: string; inputSchema?: Record<string, unknown> },
  mcpClient: Client,
  serverName: string
): StructuredToolInterface {
  const schema = jsonSchemaToZod(mcpTool.inputSchema);
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
      name: `mcp_${serverName}__${mcpTool.name}`,
      description: `[MCP: ${serverName}] ${mcpTool.description || mcpTool.name}`,
      schema,
    }
  );
}

function configChanged(existing: McpConnection, next: McpServerConfig): boolean {
  const a = existing.config;
  if (a.command !== next.command) return true;
  if (JSON.stringify(a.args) !== JSON.stringify(next.args)) return true;
  if (JSON.stringify(a.env ?? {}) !== JSON.stringify(next.env ?? {})) return true;
  return false;
}

async function connectServer(config: McpServerConfig): Promise<void> {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: config.env ? { ...process.env, ...config.env } as Record<string, string> : undefined,
  });
  const client = new Client({ name: "my-agent", version: "1.0.0" });

  await client.connect(transport);
  const { tools: mcpTools } = await client.listTools();
  const lcTools = mcpTools.map((t) => createLangChainTool(t, client, config.name));

  connections.set(config.name, { client, transport, tools: lcTools, serverName: config.name, config });
  console.log(`[MCP] Connected to "${config.name}" — ${lcTools.length} tool(s) available`);
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
  console.log(`[MCP] Disconnected from "${name}"`);
}

export async function connectToMcpServers(servers: McpServerConfig[]): Promise<void> {
  const desired = new Set(servers.map((s) => s.name));

  // 断开已移除的服务器
  for (const name of [...connections.keys()]) {
    if (!desired.has(name)) await disconnectServer(name);
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
    } catch (e) {
      console.error(`[MCP] Failed to connect to "${server.name}":`, e instanceof Error ? e.message : String(e));
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

export function getMcpStatus(): Array<{ name: string; connected: boolean; toolCount: number }> {
  return [...connections.entries()].map(([name, conn]) => ({
    name,
    connected: true,
    toolCount: conn.tools.length,
  }));
}

export async function disconnectAll(): Promise<void> {
  for (const name of [...connections.keys()]) {
    await disconnectServer(name);
  }
}
