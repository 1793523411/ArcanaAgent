import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { indexManager } from "../index-strategy/index.js";

export const project_snapshot = tool(
  async (input: {
    max_tokens?: number;
    workspace_path: string;
  }) => {
    const workspacePath = input.workspace_path;
    try {
      const strategy = await indexManager.getStrategy(workspacePath);
      // Ensure index is initialized
      if (!strategy.getStatus().ready) {
        await strategy.buildIndex(workspacePath);
      }
      const snapshot = await strategy.getSnapshot(input.max_tokens ?? 2048);
      const status = strategy.getStatus();
      return `[Strategy: ${status.strategy} | Files: ${status.fileCount}]\n\n${snapshot}`;
    } catch (e) {
      return `[error] ${e instanceof Error ? e.message : String(e)}`;
    }
  },
  {
    name: "project_snapshot",
    description:
      "Get a compact project map/snapshot showing the overall structure, key files, and important symbols. " +
      "Use this when first encountering a large project to understand its architecture before diving into details. " +
      "The output format depends on the active indexing strategy.",
    schema: z.object({
      max_tokens: z.number().optional().describe("Token budget for the snapshot (default 2048)"),
      workspace_path: z.string().describe("Workspace root directory (absolute path)"),
    }),
  }
);
