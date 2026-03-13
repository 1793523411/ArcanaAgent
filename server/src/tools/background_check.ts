import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { backgroundManager } from "../agent/backgroundManager.js";

export const background_check = tool(
  (input: {
    task_id: string;
    output_priority?: "top" | "bottom" | "split";
    output_character_count?: number;
    skip_character_count?: number;
  }) => {
    const task = backgroundManager.getTask(input.task_id);
    if (!task) {
      return `[background_check]\nstatus: failed\nerror: task not found (${input.task_id})`;
    }
    const outputView = backgroundManager.getTaskOutputView(input.task_id, {
      priority: input.output_priority,
      count: input.output_character_count,
      skip: input.skip_character_count,
    });
    if (!outputView) {
      return `[background_check]\nstatus: failed\nerror: task not found (${input.task_id})`;
    }
    return [
      "[background_check]",
      `task_id: ${task.id}`,
      `status: ${task.status}`,
      `command: ${task.command}`,
      `cwd: ${task.cwd}`,
      `timeout_ms: ${task.timeoutMs}`,
      `created_at: ${task.createdAt}`,
      `updated_at: ${task.updatedAt}`,
      `finished_at: ${task.finishedAt ?? ""}`,
      `exit_code: ${typeof task.exitCode === "number" ? task.exitCode : ""}`,
      `signal: ${task.signal ?? ""}`,
      `output_total_chars: ${outputView.totalChars}`,
      `output_returned_chars: ${outputView.returnedChars}`,
      `output_priority: ${input.output_priority ?? "bottom"}`,
      `skip_character_count: ${input.skip_character_count ?? 0}`,
      `has_more: ${outputView.hasMore}`,
      `output:\n${outputView.content || "(empty slice)"}`,
    ].join("\n");
  },
  {
    name: "background_check",
    description: "Check status and paged output for a background task.",
    schema: z.object({
      task_id: z.string().describe("Background task id returned by background_run."),
      output_priority: z
        .enum(["top", "bottom", "split"])
        .optional()
        .describe("Output slice direction. Defaults to bottom."),
      output_character_count: z
        .number()
        .optional()
        .describe("Characters to return in current slice (1-20000, default 1200)."),
      skip_character_count: z
        .number()
        .optional()
        .describe("Characters to skip from selected direction (default 0)."),
    }),
  }
);
