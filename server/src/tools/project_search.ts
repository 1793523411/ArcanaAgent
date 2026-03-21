import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { indexManager } from "../index-strategy/index.js";

export const project_search = tool(
  async (input: {
    query: string;
    max_results?: number;
    file_glob?: string;
    workspace_path: string;
  }) => {
    const workspacePath = input.workspace_path;
    try {
      const strategy = await indexManager.getStrategy(workspacePath);
      // Ensure index is initialized
      if (!strategy.getStatus().ready) {
        await strategy.buildIndex(workspacePath);
      }
      const results = await strategy.search(input.query, {
        maxResults: input.max_results ?? 10,
        fileGlob: input.file_glob,
      });
      if (results.length === 0) {
        return `No results found for: ${input.query}`;
      }
      const lines = results.map((r) => {
        const loc = r.line ? `${r.file}:${r.line}` : r.file;
        const symbol = r.symbol ? ` [${r.symbol}]` : "";
        const score = `(${(r.score * 100).toFixed(0)}%)`;
        return `${score} ${loc}${symbol}\n  ${r.content}`;
      });
      return `Found ${results.length} result(s) for "${input.query}":\n\n${lines.join("\n\n")}`;
    } catch (e) {
      return `[error] ${e instanceof Error ? e.message : String(e)}`;
    }
  },
  {
    name: "project_search",
    description:
      "Search code using the project index. More semantic than search_code — results are ranked by relevance. " +
      "Best for finding related code, understanding dependencies, and exploring unfamiliar codebases. " +
      "Falls back to ripgrep-based search if no advanced index is available.",
    schema: z.object({
      query: z.string().describe("Search query — can be a symbol name, concept, or code pattern"),
      max_results: z.number().optional().describe("Maximum results to return (default 10)"),
      file_glob: z.string().optional().describe("File glob filter, e.g. '*.ts', '*.py'"),
      workspace_path: z.string().describe("Workspace root directory (absolute path)"),
    }),
  }
);
