import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { indexManager } from "../index-strategy/index.js";

export const project_index = tool(
  async (input: {
    action: "build" | "status" | "switch" | "recommend";
    strategy?: "none" | "repomap" | "vector";
    workspace_path: string;
  }) => {
    const workspacePath = input.workspace_path;
    try {
      switch (input.action) {
        case "build": {
          const strategy = await indexManager.getStrategy(workspacePath, input.strategy);
          const building = indexManager.getBuildingStrategies(workspacePath);
          if (building.includes(strategy.type)) {
            return `Index is already being built for strategy: ${strategy.type}. Use 'status' action to check progress.`;
          }
          await indexManager.startBuild(workspacePath, strategy);
          const status = strategy.getStatus();
          return `Index built successfully.\nStrategy: ${status.strategy}\nFiles: ${status.fileCount}\nReady: ${status.ready}`;
        }
        case "status": {
          const strategy = await indexManager.getStrategy(workspacePath);
          const activeStatus = strategy.getStatus();
          const allStatuses = await indexManager.getAllStatuses(workspacePath);
          const lines = [
            `Active strategy: ${activeStatus.strategy}`,
            `Ready: ${activeStatus.ready}`,
            `Files indexed: ${activeStatus.fileCount}`,
            ...(activeStatus.lastUpdated ? [`Last updated: ${activeStatus.lastUpdated}`] : []),
            ...(activeStatus.error ? [`Error: ${activeStatus.error}`] : []),
            "",
            "All strategies:",
          ];
          for (const [type, s] of Object.entries(allStatuses)) {
            const readyStr = s.ready ? "ready" : "not built";
            const filesStr = s.fileCount > 0 ? `, ${s.fileCount} files` : "";
            const updatedStr = s.lastUpdated ? `, updated ${s.lastUpdated}` : "";
            lines.push(`  - ${type}: ${readyStr}${filesStr}${updatedStr}`);
          }
          return lines.join("\n");
        }
        case "switch": {
          if (!input.strategy) {
            return "[error] strategy parameter is required for switch action";
          }
          await indexManager.switchStrategy(workspacePath, input.strategy);
          const strategy = await indexManager.getStrategy(workspacePath);
          const activeStatus = strategy.getStatus();
          const allStatuses = await indexManager.getAllStatuses(workspacePath);
          const diskStatus = allStatuses[input.strategy];
          // Show disk-probed status if instance has no data yet
          const effectiveReady = activeStatus.ready || (diskStatus?.ready ?? false);
          const effectiveFiles = activeStatus.fileCount || (diskStatus?.fileCount ?? 0);
          return `Switched to ${input.strategy} strategy.\nReady: ${effectiveReady}\nFiles: ${effectiveFiles}${!effectiveReady ? "\nNote: Run 'build' to create the index." : ""}`;
        }
        case "recommend": {
          const recommendation = await indexManager.getRecommendation();
          const lines = [`Recommended: ${recommendation.recommended}`, "", "Available strategies:"];
          for (const s of recommendation.available) {
            const status = s.ready ? "ready" : `missing: ${s.missing.join(", ")}`;
            lines.push(`  - ${s.type}: ${status}`);
          }
          return lines.join("\n");
        }
        default:
          return `[error] Unknown action: ${input.action}`;
      }
    } catch (e) {
      return `[error] ${e instanceof Error ? e.message : String(e)}`;
    }
  },
  {
    name: "project_index",
    description:
      "Manage code index for the project. Actions: " +
      "'build' to build/rebuild the index, " +
      "'status' to check index state, " +
      "'switch' to change indexing strategy (none/repomap/vector), " +
      "'recommend' to see available strategies and recommendations.",
    schema: z.object({
      action: z.enum(["build", "status", "switch", "recommend"]).describe(
        "Action to perform: build (create index), status (check state), switch (change strategy), recommend (get recommendations)"
      ),
      strategy: z.enum(["none", "repomap", "vector"]).optional().describe(
        "Strategy to use (required for switch action, optional for build to override default)"
      ),
      workspace_path: z.string().describe("Workspace root directory (absolute path)"),
    }),
  }
);
