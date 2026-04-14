import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { backgroundManager } from "../agent/backgroundManager.js";

export const background_cancel = tool(
  (input: { task_id: string }) => {
    const result = backgroundManager.cancel(input.task_id);
    if (!result.ok || !result.task) {
      return `[background_cancel]\nstatus: failed\nerror: ${result.error ?? "unknown error"}`;
    }
    return [
      "[background_cancel]",
      `status: canceled`,
      `task_id: ${result.task.id}`,
      `command: ${result.task.command}`,
      `updated_at: ${result.task.updatedAt}`,
    ].join("\n");
  },
  {
    name: "background_cancel",
    description: "Cancel a running background task.",
    schema: z.object({
      task_id: z.string().describe("Background task id returned by background_run."),
    }),
  }
);
