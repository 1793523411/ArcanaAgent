import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { StructuredToolInterface } from "@langchain/core/tools";

export type McpServerConfig =
  | {
      name: string;
      transport: "stdio";
      command: string;
      args: string[];
      env?: Record<string, string>;
    }
  | {
      name: string;
      transport: "streamablehttp";
      url: string;
      headers?: Record<string, string>;
    };

type AnyTransport = StdioClientTransport | StreamableHTTPClientTransport;

interface McpConnection {
  client: Client;
  transport: AnyTransport;
  tools: StructuredToolInterface[];
  serverName: string;
  config: McpServerConfig;
}

function sanitizeToolName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "") || "unnamed";
}

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
        const items = prop.items as Record<string, unknown> | undefined;
        if (items && typeof items === "object") {
          const itemType = items.type as string | undefined;
          let itemSchema: z.ZodTypeAny;
          switch (itemType) {
            case "string": itemSchema = z.string(); break;
            case "number": case "integer": itemSchema = z.number(); break;
            case "boolean": itemSchema = z.boolean(); break;
            case "object": itemSchema = jsonSchemaToZod(items); break;
            default: itemSchema = z.any();
          }
          field = z.array(itemSchema);
        } else {
          field = z.array(z.any());
        }
        break;
      }
      case "object":
        field = (prop.properties as Record<string, unknown>)
          ? jsonSchemaToZod(prop as Record<string, unknown>)
          : z.record(z.any());
        break;
      default:
        field = z.any();
    }
    if (pDesc) field = field.describe(pDesc);
    if (!required.has(key)) field = field.optional().nullable();
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

export class McpManager {
  private connections = new Map<string, McpConnection>();

  async connect(servers: McpServerConfig[]): Promise<void> {
    const desired = new Set(servers.map((s) => s.name));
    for (const name of [...this.connections.keys()]) {
      if (!desired.has(name)) await this.disconnectServer(name);
    }
    for (const server of servers) {
      if (this.connections.has(server.name)) continue;
      await this.connectServer(server);
    }
  }

  private async connectServer(config: McpServerConfig): Promise<void> {
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
    const client = new Client({ name: "arcana-agent-sdk", version: "1.0.0" });
    await client.connect(transport);
    const { tools: mcpTools } = await client.listTools();
    const lcTools = mcpTools.map((t) => createLangChainTool(t, client, config.name));
    this.connections.set(config.name, { client, transport, tools: lcTools, serverName: config.name, config });
  }

  private async disconnectServer(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) return;
    try { await conn.client.close(); } catch { /* best effort */ }
    this.connections.delete(name);
  }

  getTools(): StructuredToolInterface[] {
    const all: StructuredToolInterface[] = [];
    for (const conn of this.connections.values()) {
      all.push(...conn.tools);
    }
    return all;
  }

  async disconnectAll(): Promise<void> {
    for (const name of [...this.connections.keys()]) {
      await this.disconnectServer(name);
    }
  }
}
