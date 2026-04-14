import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { backgroundManager } from "../agent/backgroundManager.js";

export const background_run = tool(
  (input: { command: string; working_directory?: string; timeout_ms?: number }) => {
    const result = backgroundManager.start({
      command: input.command,
      cwd: input.working_directory,
      timeoutMs: input.timeout_ms,
    });
    if (!result.ok || !result.taskId) {
      return `[background_run]\nstatus: failed\nerror: ${result.error ?? "unknown error"}`;
    }
    if (result.deduplicated) {
      const task = backgroundManager.getTask(result.taskId);
      return [
        "[background_run]",
        "status: deduplicated",
        `task_id: ${result.taskId}`,
        `command: ${input.command}`,
        `cwd: ${task?.cwd ?? (input.working_directory ?? process.cwd())}`,
        "note: This command is already running. Reusing existing task. Use background_check to query status.",
      ].join("\n");
    }
    const task = backgroundManager.getTask(result.taskId);
    return [
      "[background_run]",
      "status: started",
      `task_id: ${result.taskId}`,
      `command: ${input.command}`,
      `cwd: ${task?.cwd ?? (input.working_directory ?? process.cwd())}`,
      `timeout_ms: ${task?.timeoutMs ?? (input.timeout_ms ?? 300000)}`,
      "note: use background_check to query status",
    ].join("\n");
  },
  {
    name: "background_run",
    description: "Run a shell command in background and return task_id immediately.",
    schema: z.object({
      command: z.string().describe("Shell command to run in background."),
      working_directory: z.string().optional().nullable().describe("Working directory for command."),
      timeout_ms: z.number().optional().nullable().describe("Timeout in milliseconds (default 300000, max 900000)."),
    }),
  }
);
