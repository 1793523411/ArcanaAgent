import type { StructuredToolInterface } from "@langchain/core/tools";
import { run_command } from "./run_command.js";
import { read_file } from "./read_file.js";
import { write_file } from "./write_file.js";
import { edit_file } from "./edit_file.js";
import { search_code } from "./search_code.js";
import { list_files } from "./list_files.js";
import { git_operations } from "./git_operations.js";
import { test_runner } from "./test_runner.js";
import { web_search } from "./web_search.js";
import { get_time } from "./get_time.js";
import { fetch_url } from "./fetch_url.js";
import { background_run } from "./background_run.js";
import { background_check } from "./background_check.js";
import { background_cancel } from "./background_cancel.js";

export const tools = {
  run_command,
  read_file,
  write_file,
  edit_file,
  search_code,
  list_files,
  git_operations,
  test_runner,
  web_search,
  get_time,
  fetch_url,
  background_run,
  background_check,
  background_cancel,
} as const;

export type ToolId = keyof typeof tools;

export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "search_code",
  "list_files",
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
