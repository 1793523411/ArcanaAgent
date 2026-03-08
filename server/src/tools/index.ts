import type { StructuredToolInterface } from "@langchain/core/tools";
import { calculator } from "./calculator.js";
import { get_time } from "./get_time.js";
import { echo } from "./echo.js";
import { run_command } from "./run_command.js";
import { read_file } from "./read_file.js";

export const tools = {
  calculator,
  get_time,
  echo,
  run_command,
  read_file,
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
