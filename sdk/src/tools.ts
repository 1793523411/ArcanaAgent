import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { resolve } from "path";
import {
  tools as coreToolsRegistry,
  getToolsByIds,
  listToolIds as coreListToolIds,
  isReadOnlyTool as coreIsReadOnlyTool,
  isPathInWorkspace,
} from "@arcana-agent/core";
import type { ToolId } from "@arcana-agent/core";
import type { BuiltinToolId, ToolConfig } from "./types.js";

export function isReadOnlyTool(name: string): boolean {
  return coreIsReadOnlyTool(name);
}

const DEFAULT_TOOL_IDS: BuiltinToolId[] = [
  "read_file", "write_file", "edit_file", "run_command",
  "search_code", "list_files", "git_operations", "test_runner",
  "get_time", "fetch_url",
];

export function buildToolSet(config?: ToolConfig, workspacePath?: string, allowedDirs?: string[]): StructuredToolInterface[] {
  if (config?.builtinTools && config?.excludeTools?.length) {
    throw new Error("builtinTools and excludeTools cannot be used together. Use builtinTools to specify an explicit set, or excludeTools to remove from defaults.");
  }

  let toolIds: BuiltinToolId[];

  if (config?.builtinTools) {
    toolIds = config.builtinTools;
  } else {
    toolIds = [...DEFAULT_TOOL_IDS];
  }

  if (config?.excludeTools) {
    const exclude = new Set(config.excludeTools);
    toolIds = toolIds.filter((id) => !exclude.has(id));
  }

  const coreTools = getToolsByIds(toolIds as ToolId[]);

  let result: StructuredToolInterface[] = [...coreTools];

  if (workspacePath) {
    result = result.map((t) => wrapToolWithWorkspace(t, workspacePath, allowedDirs ?? []));
  }

  if (config?.customTools) {
    result.push(...config.customTools);
  }
  return result;
}

function wrapSingle(
  t: StructuredToolInterface,
  fn: (input: Record<string, unknown>) => Promise<string>,
): StructuredToolInterface {
  const wrapped = tool(fn, {
    name: t.name,
    description: (t as unknown as { description?: string }).description ?? t.name,
    schema: (t as unknown as { schema: unknown }).schema as never,
  });
  return wrapped as unknown as StructuredToolInterface;
}

function resolvePath(raw: string, ws: string): string {
  return raw.startsWith("/") ? raw : resolve(ws, raw);
}

function isAllowedPath(target: string, workspacePath: string, allowedDirs: string[]): boolean {
  if (isPathInWorkspace(target, workspacePath)) return true;
  for (const dir of allowedDirs) {
    if (isPathInWorkspace(target, dir)) return true;
  }
  return false;
}

function wrapToolWithWorkspace(t: StructuredToolInterface, workspacePath: string, allowedDirs: string[]): StructuredToolInterface {
  if (t.name === "read_file") {
    return wrapSingle(t, async (input) => {
      const rawPath = typeof input.path === "string" ? input.path : "";
      const resolvedPath = rawPath ? resolvePath(rawPath, workspacePath) : workspacePath;
      if (!isAllowedPath(resolvedPath, workspacePath, allowedDirs)) {
        return `[read_file]\nstatus: blocked\npath: ${rawPath}\nnote: 读取路径不在当前会话 workspace 内。请使用 ${workspacePath} 下的路径。`;
      }
      return String(await t.invoke({ ...input, path: resolvedPath }));
    });
  }

  if (t.name === "write_file") {
    return wrapSingle(t, async (input) => {
      const rawPath = typeof input.path === "string" ? input.path : "";
      const resolvedPath = rawPath ? resolvePath(rawPath, workspacePath) : workspacePath;
      if (!isPathInWorkspace(resolvedPath, workspacePath)) {
        return `[write_file]\nstatus: blocked\npath: ${rawPath}\nnote: 输出路径不在当前会话 workspace 内。请使用 ${workspacePath} 下的路径。`;
      }
      return String(await t.invoke({ ...input, path: resolvedPath }));
    });
  }

  if (t.name === "edit_file") {
    return wrapSingle(t, async (input) => {
      const rawPath = typeof input.path === "string" ? input.path : "";
      const resolvedPath = rawPath ? resolvePath(rawPath, workspacePath) : workspacePath;
      if (!isPathInWorkspace(resolvedPath, workspacePath)) {
        return `[edit_file]\nstatus: blocked\npath: ${rawPath}\nnote: 编辑路径不在当前会话 workspace 内。请使用 ${workspacePath} 下的路径。`;
      }
      return String(await t.invoke({ ...input, path: resolvedPath }));
    });
  }

  if (t.name === "search_code") {
    return wrapSingle(t, async (input) => {
      const rawPath = typeof input.path === "string" ? input.path : "";
      const resolvedPath = rawPath ? resolvePath(rawPath, workspacePath) : workspacePath;
      if (!isAllowedPath(resolvedPath, workspacePath, allowedDirs)) {
        return `[search_code]\nstatus: blocked\npath: ${rawPath}\nnote: 搜索路径不在当前会话 workspace 内。请使用 ${workspacePath} 下的路径。`;
      }
      return String(await t.invoke({ ...input, path: resolvedPath }));
    });
  }

  if (t.name === "list_files") {
    return wrapSingle(t, async (input) => {
      const rawPath = typeof input.path === "string" ? input.path : "";
      const resolvedPath = rawPath ? resolvePath(rawPath, workspacePath) : workspacePath;
      if (!isAllowedPath(resolvedPath, workspacePath, allowedDirs)) {
        return `[list_files]\nstatus: blocked\npath: ${rawPath}\nnote: 列出路径不在当前会话 workspace 内。请使用 ${workspacePath} 下的路径。`;
      }
      return String(await t.invoke({ ...input, path: resolvedPath }));
    });
  }

  if (t.name === "test_runner") {
    return wrapSingle(t, async (input) => {
      const rawPath = typeof input.path === "string" ? input.path : "";
      const resolvedPath = rawPath ? resolvePath(rawPath, workspacePath) : workspacePath;
      if (!isPathInWorkspace(resolvedPath, workspacePath)) {
        return `[test_runner]\nstatus: blocked\npath: ${rawPath}\nnote: 测试路径不在当前会话 workspace 内。请使用 ${workspacePath} 下的路径。`;
      }
      return String(await t.invoke({ ...input, path: resolvedPath }));
    });
  }

  if (t.name === "git_operations") {
    return wrapSingle(t, async (input) => {
      const rawDir = typeof input.working_directory === "string" ? input.working_directory : "";
      const resolvedDir = rawDir ? resolvePath(rawDir, workspacePath) : workspacePath;
      const safeDir = isPathInWorkspace(resolvedDir, workspacePath) ? resolvedDir : workspacePath;
      return String(await t.invoke({ ...input, working_directory: safeDir }));
    });
  }

  if (t.name === "run_command") {
    return wrapSingle(t, async (input) => {
      const rawDir = typeof input.working_directory === "string" ? input.working_directory : "";
      const resolvedDir = rawDir ? resolve(rawDir) : workspacePath;
      const safeDir = isAllowedPath(resolvedDir, workspacePath, allowedDirs) ? resolvedDir : workspacePath;
      return String(await t.invoke({ ...input, working_directory: safeDir }));
    });
  }

  return t;
}

export function listBuiltinToolIds(): string[] {
  return coreListToolIds();
}
