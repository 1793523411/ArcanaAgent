import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { execFile } from "child_process";
import { resolve } from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";

const MAX_OUTPUT_BYTES = 32 * 1024;
const TIMEOUT_MS = 30_000;

function getScriptPath(): string {
  const scriptRelative = "skills/ddgs-web-search/scripts/search.py";

  // 1. Try from process.cwd() (project root when server is started normally)
  const fromCwd = resolve(process.cwd(), scriptRelative);
  if (existsSync(fromCwd)) return fromCwd;

  // 2. Try from this file's compiled location: dist/tools/ -> dist/ -> server/ -> project_root/
  const thisDir = typeof __dirname !== "undefined"
    ? __dirname
    : resolve(fileURLToPath(import.meta.url), "..");
  const fromFile = resolve(thisDir, "../../..", scriptRelative);
  if (existsSync(fromFile)) return fromFile;

  // 3. Fallback: return the cwd-based path (will produce a clear error message)
  return fromCwd;
}

function runPythonSearch(args: string[]): Promise<string> {
  return new Promise((resolveP, reject) => {
    const scriptPath = getScriptPath();
    if (!existsSync(scriptPath)) {
      resolveP(`[error] Search script not found at ${scriptPath}. Ensure skills/ddgs-web-search is installed.`);
      return;
    }

    execFile(
      "python3",
      [scriptPath, ...args],
      {
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES * 2,
        encoding: "utf-8",
      },
      (error, stdout, stderr) => {
        if (error) {
          // Check if python3 is not available
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            resolveP("[error] python3 is not available. Please install Python 3 to use web_search.");
            return;
          }
          // Timeout
          if (error.killed) {
            resolveP("[error] Search timed out after 30 seconds.");
            return;
          }
          // Script returned non-zero but may have useful output
          if (stdout && stdout.trim()) {
            let result = stdout;
            if (result.length > MAX_OUTPUT_BYTES) {
              result = result.slice(0, MAX_OUTPUT_BYTES) + "\n... [output truncated at 32KB]";
            }
            resolveP(result);
            return;
          }
          resolveP(`[error] Search failed: ${stderr || error.message}`);
          return;
        }

        let result = stdout || "No results found.";
        if (result.length > MAX_OUTPUT_BYTES) {
          result = result.slice(0, MAX_OUTPUT_BYTES) + "\n... [output truncated at 32KB]";
        }
        resolveP(result);
      }
    );
  });
}

export const web_search = tool(
  async (input: {
    query: string;
    type?: "web" | "news";
    max_results?: number;
    time_range?: "d" | "w" | "m" | "y";
  }) => {
    const args: string[] = [input.query];

    const searchType = input.type ?? "web";
    args.push("--type", searchType);

    const maxResults = Math.min(input.max_results ?? 5, 20);
    args.push("--max-results", String(maxResults));

    if (input.time_range) {
      args.push("--time-range", input.time_range);
    }

    // Use text format for readable output
    args.push("--format", "text");

    try {
      return await runPythonSearch(args);
    } catch (e) {
      return `[error] ${e instanceof Error ? e.message : String(e)}`;
    }
  },
  {
    name: "web_search",
    description:
      "Search the web using DuckDuckGo. Use this tool to find up-to-date information, " +
      "documentation, technical solutions, or current events. Supports web and news search " +
      "with optional time range filtering.",
    schema: z.object({
      query: z.string().describe("Search keywords"),
      type: z.enum(["web", "news"]).optional().describe("Search type (default: web)"),
      max_results: z.number().optional().describe("Maximum number of results (default 5, max 20)"),
      time_range: z.enum(["d", "w", "m", "y"]).optional().describe("Time range filter: d=day, w=week, m=month, y=year"),
    }),
  }
);
