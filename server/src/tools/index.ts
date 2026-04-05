import type { StructuredToolInterface } from "@langchain/core/tools";
import { run_command } from "./run_command.js";
import { read_file } from "./read_file.js";
import { write_file } from "./write_file.js";
import { load_skill } from "./load_skill.js";
import { background_run } from "./background_run.js";
import { background_check } from "./background_check.js";
import { background_cancel } from "./background_cancel.js";
import { edit_file } from "./edit_file.js";
import { search_code } from "./search_code.js";
import { list_files } from "./list_files.js";
import { git_operations } from "./git_operations.js";
import { test_runner } from "./test_runner.js";
import { web_search } from "./web_search.js";
import { project_index } from "./project_index.js";
import { project_search } from "./project_search.js";
import { project_snapshot } from "./project_snapshot.js";
import { get_time } from "./get_time.js";
import { fetch_url } from "./fetch_url.js";
import { claude_code } from "./claude_code.js";

export const tools = {
  run_command,
  read_file,
  write_file,
  load_skill,
  background_run,
  background_check,
  background_cancel,
  edit_file,
  search_code,
  list_files,
  git_operations,
  test_runner,
  web_search,
  project_index,
  project_search,
  project_snapshot,
  get_time,
  fetch_url,
  claude_code,
} as const;

export type ToolId = keyof typeof tools;

/**
 * 只读工具集合 — 可安全并行执行（无副作用）。
 * 不在此集合中的工具默认为写入工具，必须串行执行（Fail-closed）。
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "search_code",
  "list_files",
  "project_search",
  "project_snapshot",
  "project_index",
  "get_time",
  "web_search",
  "fetch_url",
  "load_skill",
  "background_check",
]);

export function isReadOnlyTool(toolName: string): boolean {
  return READ_ONLY_TOOLS.has(toolName);
}

export function getToolsByIds(ids: string[]): StructuredToolInterface[] {
  const out: StructuredToolInterface[] = [];
  for (const id of ids) {
    if (id in tools) {
      out.push((tools as Record<string, StructuredToolInterface>)[id]);
    }
  }
  return out;
}

export function listToolIds(): string[] {
  return Object.keys(tools);
}
