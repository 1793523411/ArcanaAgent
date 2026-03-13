import type { StructuredToolInterface } from "@langchain/core/tools";
import { run_command } from "./run_command.js";
import { read_file } from "./read_file.js";
import { write_file } from "./write_file.js";
import { load_skill } from "./load_skill.js";
import { background_run } from "./background_run.js";
import { background_check } from "./background_check.js";
import { background_cancel } from "./background_cancel.js";

export const tools = {
  run_command,
  read_file,
  write_file,
  load_skill,
  background_run,
  background_check,
  background_cancel,
} as const;

export type ToolId = keyof typeof tools;

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
